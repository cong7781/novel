/**
 * Replayable extraction run, from the command line.
 *
 * This is the path the README documents and the path the measurements were taken on: it prints
 * progress, writes every intermediate artifact to `<run>/`, and can resume a half-finished run
 * without paying for the finished chunks again.
 *
 *   node scripts/extract-cli.mjs --path fixtures/sample.txt --out out/runs/fixture
 *   node scripts/extract-cli.mjs --path out/texts/novel-100k.txt --mode rag --max-blocks 20
 *   node scripts/extract-cli.mjs --path out/texts/novel-100k.txt --resume
 *   node scripts/extract-cli.mjs --path out/texts/novel-600k.txt --plan-only --cast-from out/runs/novel-100k
 *
 * Every run writes:
 *   <run>/text.txt        normalised input (the text every offset refers to)
 *   <run>/manifest.json   text hash, mode, model, chunk options
 *   <run>/chunks.json     window boundaries
 *   <run>/blocks/*.json   one verified extraction per chunk (the resumable unit)
 *   <run>/cast.json       characters found by the cheap scan
 *   <run>/plan.json       which blocks were selected, and why the others were not
 *   <run>/result.json     the merged graph (viewer payload)
 *   out/latest-graph.json copy of the result, for build-viewer.mjs
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRunStore, textHash } from '../lib/checkpoint.js'
import { MAX_CHARS, MIN_CHARS } from '../lib/extract.js'
import { DEFAULT_BASE_URL, DEFAULT_MODEL, callChat, readApiKey } from '../lib/model.js'
import { runExtraction } from '../lib/pipeline.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2))

if (args.help || (!args.path && !args.text)) {
  console.log(usage())
  process.exit(args.help ? 0 : 2)
}

const sourcePath = args.path ? resolve(args.path) : null
const raw = args.text ?? (await readFile(sourcePath, 'utf8'))
const text = raw.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
const chars = text.length
if (text.trim().length < MIN_CHARS) {
  fail(`文本太短（${text.trim().length} 字），至少 ${MIN_CHARS} 字才抽得出有证据的关系。`)
}
if (chars > MAX_CHARS) {
  fail(`文本 ${chars.toLocaleString('en-US')} 字，超过上限 ${MAX_CHARS.toLocaleString('en-US')} 字。请按卷切分后分别跑。`)
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
const slug = sourcePath ? basename(sourcePath, extname(sourcePath)) : 'text'
const runDir = resolve(ROOT, args.out ?? join('out', 'runs', `${slug}-${chars}-${stamp}`))
const store = createRunStore(runDir)
await store.ensure()
await writeFile(join(runDir, 'text.txt'), text, 'utf8')

const apiKey = readApiKey()
const model = args.model ?? DEFAULT_MODEL
const mode = args.mode ?? 'auto'
const startedAt = Date.now()

const options = {
  mode,
  model,
  resume: args.resume !== false,
  concurrency: Number(args.concurrency ?? 4),
  maxEvidencesPerPair: Number(args['max-evidence-per-pair'] ?? 3),
  planOnly: Boolean(args['plan-only']),
  chunk: {
    target: Number(args['chunk-target'] ?? 3500),
    min: Number(args['chunk-min'] ?? 2600),
    max: Number(args['chunk-max'] ?? 5000),
    overlap: Number(args['chunk-overlap'] ?? 0.12),
  },
  rag: {
    castSampleBlocks: Number(args['cast-samples'] ?? 12),
    maxPairs: Number(args['max-pairs'] ?? 120),
    maxBlocks: args['max-blocks'] ? Number(args['max-blocks']) : Number.POSITIVE_INFINITY,
    minCooccurrence: args['min-cooccurrence'] ? Number(args['min-cooccurrence']) : undefined,
  },
}

if (args['cast-from']) {
  const castPath = resolve(args['cast-from'], 'cast.json')
  const previous = JSON.parse(await readFile(castPath, 'utf8'))
  const clusters = previous.clusters ?? []
  options.cast = clusters.map((cluster) => ({
    name: cluster.name,
    aliases: (cluster.keys ?? []).filter((key) => key !== cluster.name),
  }))
  console.log(`cast: 复用 ${castPath}（${options.cast.length} 个角色，不再调用扫描模型）`)
}

console.log(`text: ${chars.toLocaleString('en-US')} 字  hash=${textHash(text)}`)
console.log(`run:  ${runDir}`)
console.log(`mode: ${mode}  model: ${model}  concurrency: ${options.concurrency}`)

let lastLine = ''
const onProgress = (event) => {
  if (event.phase === 'extract') {
    const percent = Math.round((event.done / Math.max(1, event.total)) * 100)
    const elapsed = ((event.elapsedMs ?? Date.now() - startedAt) / 1000).toFixed(0)
    const tokens = event.usage ? ` in=${event.usage.prompt} out=${event.usage.completion}` : ''
    const line =
      `[extract] ${event.done}/${event.total} ${percent}%  ${elapsed}s${tokens}` +
      (event.reused ? '  复用' : '') +
      `  …#${event.chunkIndex ?? '-'}`
    if (args.verbose) console.log(line)
    else {
      process.stdout.write(`\r${line.padEnd(Math.max(lastLine.length, line.length))}`)
      lastLine = line
    }
    return
  }
  if (!args.quiet) console.log(describeEvent(event))
}

let payload
try {
  payload = await runExtraction({
    text,
    store,
    onProgress,
    options,
    callModel: ({ system, user, maxTokens, label }) =>
      callChat({ apiKey, model, baseUrl: args.base ?? DEFAULT_BASE_URL, system, user, maxTokens, label }),
  })
} catch (error) {
  if (!args.quiet) process.stdout.write('\n')
  console.error(`\n失败了：${error.message}`)
  console.error(`中间产物在 ${runDir}；修好后加 --resume 可以续跑，已完成的块不会再调用模型。`)
  process.exit(1)
}
if (!args.quiet && lastLine) process.stdout.write('\n')

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
const stats = payload.stats
const result = {
  v: 2,
  ...payload,
  source: { name: sourcePath ? basename(sourcePath) : '命令行文本', chars, path: sourcePath },
  generatedAt: new Date().toISOString(),
  run: {
    dir: runDir,
    model,
    baseUrl: args.base ?? DEFAULT_BASE_URL,
    textHash: textHash(text),
    elapsedSeconds: Number(elapsed),
  },
}
await store.writeResult(result)
const resultPath = join(runDir, 'result.json')
if (!args['no-latest']) {
  await mkdir(resolve(ROOT, 'out'), { recursive: true })
  await writeFile(resolve(ROOT, 'out/latest-graph.json'), JSON.stringify(result, null, 2), 'utf8')
}

if (!args['no-record']) {
  const record = {
    at: new Date().toISOString(),
    text: sourcePath ? basename(sourcePath) : 'inline',
    chars,
    mode: payload.mode ?? mode,
    planOnly: Boolean(payload.planOnly),
    chunks: stats.chunks,
    chunksExtracted: stats.chunksExtracted,
    chunksReused: stats.chunksReused ?? 0,
    chunksFailed: stats.chunksFailed ?? 0,
    calls: stats.calls,
    promptTokens: stats.tokens.prompt,
    completionTokens: stats.tokens.completion,
    costUsd: stats.costUsd,
    elapsedSeconds: Number(elapsed),
    modelSeconds: Number(((stats.modelMs ?? 0) / 1000).toFixed(1)),
    per10k: stats.per10k,
    nodes: stats.nodes,
    edges: stats.edges,
    verified: stats.verified,
    repaired: stats.repaired,
    dropped: stats.dropped,
    evidenceFailed: stats.evidenceFailed ?? 0,
    evidencePassRate: Number((stats.evidencePassRate ?? 1).toFixed(4)),
    aliasMerges: stats.aliasMerges ?? 0,
    rag: stats.rag ?? null,
    run: runDir,
  }
  await appendFile(resolve(ROOT, 'out/measurements.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
}

console.log('')
console.log('── 结果 ──────────────────────────────────────────────')
console.log(`字数        ${chars.toLocaleString('en-US')}`)
console.log(`分块        ${stats.chunks}（抽取 ${stats.chunksExtracted}，复用 ${stats.chunksReused ?? 0}，失败 ${stats.chunksFailed ?? 0}）`)
console.log(`模型调用    ${stats.calls} 次   输入 ${stats.tokens.prompt.toLocaleString('en-US')} tokens   输出 ${stats.tokens.completion.toLocaleString('en-US')} tokens`)
console.log(`耗时        ${elapsed}s 墙钟 / ${((stats.modelMs ?? 0) / 1000).toFixed(1)}s 模型（每块 ${stats.msPerChunk}ms）`)
console.log(`成本        $${stats.costUsd.toFixed(4)}（输入 $${stats.cost.input} + 输出 $${stats.cost.output}）`)
console.log(`每万字      ${stats.per10k.promptTokens} in tokens / ${stats.per10k.completionTokens} out tokens / ${stats.per10k.seconds}s / $${stats.per10k.costUsd}`)
console.log(`角色/关系   ${stats.nodes} / ${stats.edges}（逐字通过 ${stats.verified}，重锚 ${stats.repaired}）`)
console.log(
  `丢弃        ${stats.dropped}   逐字证据通过率 ${Math.round((stats.evidencePassRate ?? 1) * 100)}%` +
    `（核对失败 ${stats.evidenceFailed ?? 0} 条）`,
)
if (stats.droppedReasons?.length) {
  console.log(`丢弃原因    ${stats.droppedReasons.map((item) => `${item.reason}×${item.count}`).join('  ')}`)
}
if (stats.aliasMerges) console.log(`别名合并    ${stats.aliasMerges} 个重复称呼被合并（别名声明 ${stats.aliasDeclarations} 处）`)
if (stats.rag?.enabled) {
  console.log(
    `RAG         角色表 ${stats.rag.castSize} 人 / 候选对 ${stats.rag.pairs} / 候选块 ${stats.rag.candidateBlocks}` +
      ` → 抽取 ${stats.rag.selectedBlocks} 块，跳过 ${stats.rag.skippedBlocks} 块` +
      `（${stats.rag.skippedByReason.map((item) => `${item.reason}×${item.count}`).join('，') || '无'}）`,
  )
  if (typeof stats.rag.estimatedSavedUsd === 'number') {
    console.log(`            估算省下 $${stats.rag.estimatedSavedUsd}（按已抽块的平均成本推算）`)
  }
}
if (stats.suspects > 0) {
  console.log(`疑似同一人未合并 ${stats.suspects} 组（保守策略）：${(stats.suspectExamples ?? []).map((item) => `${item.a}/${item.b}`).join('、')}`)
}
console.log('')
console.log(`result: ${resultPath}`)
console.log(`复跑：   node scripts/extract-cli.mjs --path "${sourcePath ?? '(inline)'}" --out "${runDir}" --mode ${mode}`)
console.log(`续跑：   node scripts/extract-cli.mjs --path "${sourcePath ?? '(inline)'}" --out "${runDir}" --mode ${mode} --resume`)

function describeEvent(event) {
  switch (event.phase) {
    case 'start':
      return `phase start  mode=${event.mode}`
    case 'chunked':
      return `phase chunked  ${event.chunks} 块 覆盖率 ${(event.coverage * 100).toFixed(1)}%`
    case 'cast':
      return `phase cast  ${event.done}/${event.total}`
    case 'cast-failed':
      return `phase cast-failed  chunk ${event.chunkIndex}: ${event.error}`
    case 'casted':
      return `phase casted  角色表 ${event.cast} 人（扫描调用 ${event.calls} 次）`
    case 'planned':
      return (
        `phase planned  候选对 ${event.pairs} / 候选块 ${event.candidates} / 选中 ${event.selected} / 跳过 ${event.skipped}` +
        `（${event.skippedByReason.map((item) => `${item.reason}×${item.count}`).join('，') || '—'}）`
      )
    case 'extract-failed':
      return `phase extract-failed  chunk ${event.chunkIndex}: ${event.error}`
    case 'resume-mismatch':
      return `phase resume-mismatch  ${event.message}`
    case 'single':
      return `phase single  已校验 ${event.edges} 条`
    default:
      return `phase ${event.phase}`
  }
}

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      parsed[key] = true
    } else {
      parsed[key] = next
      i += 1
    }
  }
  return parsed
}

function fail(message) {
  console.error(message)
  process.exit(2)
}

function usage() {
  return [
    '用法: node scripts/extract-cli.mjs --path <txt> [选项]',
    '',
    '  --path <file>            输入文本（与 --text 二选一）',
    '  --text <string>          直接给文本',
    '  --out <dir>              run 目录（默认 out/runs/<名字>-<字数>-<时间>）',
    '  --mode auto|single|chunk|rag   默认 auto（≤8000 字单次；更长分块；>50k 走检索）',
    '  --resume                 复用 run 目录里已完成的块（默认开）',
    '  --concurrency <n>        并发模型调用（默认 4）',
    '  --plan-only              只建索引 + 出检索计划，不做精细抽取',
    '  --cast-from <runDir>     复用上一次的角色表（配合 --plan-only 可零模型调用看计划）',
    '  --max-blocks <n>         RAG 预算：最多精细抽取多少块',
    '  --max-pairs <n>          最多考虑多少对角色（默认 120）',
    '  --max-evidence-per-pair <n>  每对角色最多保留几条叙事证据（默认 3）',
    '  --min-cooccurrence <n>   一对角色至少同现几块才值得抽（默认 >5 万字时 2，否则 1）',
    '  --cast-samples <n>       角色扫描抽多少块（默认 12）',
    '  --chunk-target <n>       分块目标字数（默认 3500，min 2600 / max 5000）',
    '  --chunk-overlap <f>      重叠比例（默认 0.12）',
    '  --model <name>           provider 模型名（默认 deepseek-chat）',
    '  --base <url>             接口地址（默认 https://api.deepseek.com）',
    '  --no-latest              不写 out/latest-graph.json',
    '  --no-record              不追加 out/measurements.jsonl',
    '  --verbose                每个块一行，不覆盖同一行',
  ].join('\n')
}
