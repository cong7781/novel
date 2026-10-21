/**
 * dsh-character-graph — host half.
 *
 * One tool call, one verified graph. For short texts that is still a single model call; above
 * `SINGLE_PASS_MAX_CHARS` the text is windowed, each window is extracted and checked against its own
 * exact text, and the windows are merged into one graph (sliding-window pipeline). Above ~50k
 * characters the cheap cast scan and the lexical retriever decide which windows are worth a full
 * extraction call (the RAG path).
 *
 * What never changes: an edge survives only if its `evidence` can be located verbatim in the text
 * the model was shown. The graph travels to the browser through `output.presentationMeta`, which is
 * the only structured channel that is durable (survives refresh and log replay) without polluting
 * the model-facing content.
 */

import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRunStore } from './checkpoint.js'
import { MAX_CHARS, MIN_CHARS, summarize } from './extract.js'
import { emptyUsage } from './model.js'
import { runExtraction } from './pipeline.js'

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/sample.txt', import.meta.url))

export const name = 'dsh-character-graph'

/** `llm` performs the extraction; `agentDefaultModel` picks the route. */
export const inject = ['tools', 'llm', 'agentDefaultModel']

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['nodes', 'edges', 'stats', 'source'],
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          aliases: { type: 'array', items: { type: 'string' } },
          mentions: { type: 'integer' },
          independent: { type: 'integer' },
        },
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'target', 'relation', 'evidence', 'strength', 'charStart', 'repaired'],
        properties: {
          source: { type: 'string' },
          target: { type: 'string' },
          relation: { type: 'string' },
          evidence: { type: 'string' },
          strength: { type: 'integer' },
          charStart: { type: 'integer' },
          repaired: { type: 'boolean' },
          chunk: { type: 'integer' },
        },
      },
    },
    stats: {
      type: 'object',
      additionalProperties: true,
      required: ['chars', 'nodes', 'edges', 'verified', 'repaired', 'dropped', 'droppedReasons'],
      properties: {
        chars: { type: 'integer' },
        chunks: { type: 'integer' },
        chunksExtracted: { type: 'integer' },
        chunksFailed: { type: 'integer' },
        modelNodes: { type: 'integer' },
        modelEdges: { type: 'integer' },
        nodes: { type: 'integer' },
        edges: { type: 'integer' },
        verified: { type: 'integer' },
        repaired: { type: 'integer' },
        dropped: { type: 'integer' },
        droppedReasons: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['reason', 'count'],
            properties: { reason: { type: 'string' }, count: { type: 'integer' } },
          },
        },
        evidencePassRate: { type: 'number' },
        calls: { type: 'integer' },
        costUsd: { type: 'number' },
        elapsedMs: { type: 'integer' },
        mode: { type: 'string' },
      },
    },
    source: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'chars'],
      properties: { name: { type: 'string' }, chars: { type: 'integer' } },
    },
  },
}

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(createTool(ctx)), 'dsh-character-graph:extract_characters')
}

function createTool(ctx) {
  return {
    name: 'extract_characters',
    description: [
      '从中文叙事文本中抽取角色与角色关系网，返回 nodes + edges（每条边都带原文证据 evidence）。',
      '适合：小说片段、剧本、人物志等有人物互动的文本。',
      `不给参数时使用插件自带的测试文本（一段约 9 千字的原创短篇：江南药铺与漕运的旧怨）。`,
      `长文本会自动分块：≤ ${MAX_CHARS.toLocaleString('en-US')} 字都能处理，每个分块的证据仍然逐字核对，` +
        '超长文本（>5 万字）走检索式抽取（先扫角色表、再用字 n-gram 检索候选块），耗时可能到几分钟；' +
        '更长的书建议用本地查看器/CLI（scripts/extract-cli.mjs），它会把中间产物落盘并可断点续跑。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: {
          type: 'string',
          description: '直接传入的纯文本（可选）。适合几百到几万字的片段。',
        },
        path: {
          type: 'string',
          description: '纯文本文件路径（可选，绝对路径或相对当前工作目录）。与 text 二选一。',
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: summarize(value.stats) }],
      // This is the graph the card draws. It persists with the tool result, so the view
      // survives a page refresh, and it never enters the model-facing content.
      presentationMeta: (_args, value) => ({
        v: 2,
        nodes: value.nodes,
        edges: value.edges,
        stats: value.stats,
        source: value.source,
      }),
    },
    async execute(args, exec) {
      const { text, source } = await resolveInput(args)
      const store = await openRunStore(text.length)
      const payload = await runExtraction({
        text,
        store,
        signal: exec.signal,
        options: { mode: 'auto', model: 'host', concurrency: hostConcurrency() },
        callModel: (options) => callModelWithCtx(ctx, options, exec.signal),
      })

      if (payload.nodes.length === 0) {
        throw new Error(
          '没有一条关系能在原文中核对成功，因此没有生成图谱。这通常说明文本里人物互动太少，或模型没有按原文引用；可以换一段叙事性更强的文本重试。',
        )
      }

      return {
        nodes: payload.nodes,
        edges: payload.edges,
        stats: payload.stats,
        source: { name: source, chars: text.length },
      }
    },
  }
}

async function resolveInput(args) {
  if (args && typeof args.text === 'string' && args.text.trim() !== '') {
    return { text: normalizeText(args.text), source: '直接传入的文本' }
  }
  if (args && typeof args.path === 'string' && args.path.trim() !== '') {
    const target = resolve(args.path.trim())
    let raw
    try {
      raw = await readFile(target, 'utf8')
    } catch (error) {
      throw new Error(`读不到文件 ${target}（${error.code ?? error.message}）。请确认路径正确、文件是纯文本。`)
    }
    return { text: normalizeText(raw), source: target }
  }
  const raw = await readFile(FIXTURE_PATH, 'utf8')
  return { text: normalizeText(raw), source: '内置测试文本' }
}

function normalizeText(value) {
  const text = value.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  if (text.trim().length < MIN_CHARS) {
    throw new Error(
      `文本太短（${text.trim().length} 字），不足 ${MIN_CHARS} 字，抽不出有证据支撑的人物关系。请换一段更长的叙事文本。`,
    )
  }
  if (text.length > MAX_CHARS) {
    throw new Error(
      `文本 ${text.length.toLocaleString('en-US')} 字，超过单次上限 ${MAX_CHARS.toLocaleString('en-US')} 字。` +
        '可以按卷切分后用 scripts/extract-cli.mjs 分卷跑，再合并 result.json。',
    )
  }
  return text
}

/**
 * Intermediate artifacts for a host-side run.
 *
 * Nothing is written unless the user asked for it: `CHARACTER_GRAPH_RUNS` names the directory, and
 * the default is a per-text folder under the OS temp directory so a failed multi-minute run can be
 * resumed instead of paid for twice.
 */
async function openRunStore(chars) {
  if (chars < 12000) return null
  const base = process.env.CHARACTER_GRAPH_RUNS ?? join(tmpdir(), 'dsh-character-graph-runs')
  const stamp = new Date().toISOString().slice(0, 10)
  try {
    return createRunStore(join(base, `${stamp}-${chars}`))
  } catch {
    return null
  }
}

function hostConcurrency() {
  const value = Number.parseInt(process.env.CHARACTER_GRAPH_CONCURRENCY ?? '', 10)
  if (Number.isFinite(value) && value > 0) return Math.min(8, value)
  return 4
}

/** Hard ceiling for one call, whatever the caller asked for. */
const MAX_TOKENS_CEILING = 32768

/**
 * Adapter: the pipeline knows only `callModel({system, user, maxTokens})`.
 *
 * Two things about the host stream shape the code below. First, a *thinking* model — which is what
 * `reasoningEffort: max` selects on this provider — spends its output budget on `reasoning-delta`
 * chunks before it writes a single `text-delta`. A cast call asking for 900 tokens then comes back
 * with real usage, real time and an empty string: not an error, but nothing to parse either, which
 * is exactly how an entire RAG run can end up with an empty cast list. So an empty reply is treated
 * as a failure, retried once or twice with a doubled budget, and finally reported as an error that
 * says so. Second, the stream does report a `usage` chunk, so the counts are real rather than the
 * character-count estimate this adapter used to make up.
 *
 * Exported so the adapter's retry rules can be asserted without a live session (test-host-adapter).
 */
export async function callModelWithCtx(ctx, options, signal) {
  const selection = currentSelection(ctx)
  const budget = clampTokens(options.maxTokens ?? 4096)
  let lastError = null

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const maxTokens = clampTokens(budget * 2 ** attempt)
    const started = Date.now()
    let reply = ''
    let reasoningChars = 0
    let usage = null
    let failure = null
    let finishKind = null

    try {
      const stream = ctx.llm.stream({
        provider: selection.provider,
        model: selection.model,
        system: options.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: options.user }] }],
        temperature: 0.2,
        maxTokens,
        signal,
      })

      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') {
          reply += chunk.text
        } else if (chunk.type === 'reasoning-delta') {
          reasoningChars += (chunk.text ?? '').length
        } else if (chunk.type === 'usage' && chunk.usage) {
          usage = chunk.usage
        } else if (chunk.type === 'finish') {
          const reason = chunk.reason
          finishKind = reason.kind
          if (reason.kind === 'error' || reason.kind === 'aborted') failure = reason.failure
        }
      }
    } catch (error) {
      throw new Error(`模型调用失败：${error.message}。请检查当前模型配置后重试。`)
    }

    if (failure) {
      throw new Error(`模型调用失败：${failure.message}。请检查当前模型配置后重试。`)
    }

    if (reply.trim() !== '') {
      return {
        text: reply,
        seconds: (Date.now() - started) / 1000,
        usage: normalizeStreamUsage(usage, options, reply),
        attempts: attempt + 1,
      }
    }

    const reasoningTokens = Number(usage?.reasoningTokens ?? 0) || 0
    const reasoningHint =
      reasoningTokens > 0
        ? `，其中 ${reasoningTokens} tokens 是思考过程`
        : reasoningChars > 0
          ? `，其中 ${reasoningChars} 字是思考过程`
          : ''
    lastError =
      `${options.label ? `${options.label}: ` : ''}模型只回了空正文（上限 ${maxTokens} tokens${reasoningHint}` +
      (finishKind === 'length' ? '，被输出上限截断' : '') +
      '）'
    // Nothing came back at all and not even reasoning was produced: a bigger budget will not help.
    if (reasoningChars === 0 && (finishKind === null || finishKind === 'stop')) break
  }

  throw new Error(
    `${lastError}。这个模型在思考上花光了输出预算，正文是空的；` +
      '请把默认模型换成非思考模型，或在模型设置里调低推理强度后重试。',
  )
}

function clampTokens(value) {
  const number = Number.isFinite(value) ? Math.floor(value) : 4096
  return Math.min(MAX_TOKENS_CEILING, Math.max(512, number))
}

/** Prefer the provider's own counts; fall back to the measured character ratio when absent. */
function normalizeStreamUsage(usage, options, reply) {
  const prompt = Number(usage?.inputTokens ?? usage?.promptTokens ?? 0) || 0
  const completion = Number(usage?.outputTokens ?? usage?.completionTokens ?? 0) || 0
  const cacheHit = Number(usage?.cacheReadTokens ?? usage?.cacheHitTokens ?? 0) || 0
  if (prompt > 0 || completion > 0) {
    return { prompt, completion, cacheHit: Math.min(cacheHit, prompt), estimated: false }
  }
  return {
    ...emptyUsage(),
    prompt: estimateTokens(options.system.length + options.user.length),
    completion: estimateTokens(reply.length),
    estimated: true,
  }
}

function estimateTokens(chars) {
  return Math.round(chars * 0.72)
}

function currentSelection(ctx) {
  let selection
  try {
    selection = ctx.agentDefaultModel.currentSelection()
  } catch (error) {
    throw new Error(`读不到默认模型（${error.message}）。请先在设置里选好模型。`)
  }
  if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    throw new Error('没有配置默认模型。请先在设置里选择 provider 和 model，再重试。')
  }
  return selection
}
