/**
 * Local companion server for the viewer page.
 *
 * It exists because a static file:// page cannot reach a model: the page can take an uploaded or
 * pasted text, but the extraction has to happen somewhere that owns a credential. This process is
 * that "somewhere" — it reads the same DeepSeek key DSH already stores on this machine and calls
 * the provider directly, so the whole flow works without restarting DSH.
 *
 * For a long book the extraction is a *job*, not a request: POST /api/jobs starts it, the page polls
 * GET /api/jobs/:id for phase/progress, and the same artifacts the CLI writes land in out/runs/<id>/
 * so a killed job can be resumed and a finished one can be reloaded without re-extraction.
 *
 * It listens on loopback only, and it never logs the key.
 *
 *   node scripts/serve.mjs            → http://127.0.0.1:19401
 */

import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRunStore } from '../lib/checkpoint.js'
import { MAX_CHARS, MIN_CHARS, summarize } from '../lib/extract.js'
import { DEFAULT_BASE_URL, DEFAULT_MODEL, callChat, normalizeUsage, readApiKey } from '../lib/model.js'
import { runExtraction } from '../lib/pipeline.js'
import { retrievePassages } from '../lib/retrieve.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = resolve(ROOT, 'out/character-graph.html')
const RUNS = resolve(ROOT, 'out/runs')
const PORT = Number(process.env.CHARACTER_GRAPH_PORT ?? 19401)
const MODEL = process.env.CHARACTER_GRAPH_MODEL ?? DEFAULT_MODEL
const BASE_URL = process.env.CHARACTER_GRAPH_BASE ?? DEFAULT_BASE_URL
/** 600k characters of Chinese is ~1.8 MB of UTF-8; leave room for JSON escaping. */
const MAX_BODY_BYTES = 12 * 1024 * 1024

/** id → job. A local tool: the job list lives as long as the process, artifacts live on disk. */
const jobs = new Map()
/** runId → {text, chunks, result} — lazily loaded for pair retrieval. */
const runCache = new Map()

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)

  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      })
      response.end()
      return
    }

    if (url.pathname === '/api/health') {
      json(response, 200, { ok: true, model: MODEL, maxChars: MAX_CHARS })
      return
    }

    if (url.pathname === '/api/extract' && request.method === 'POST') {
      const payload = await handleExtract(await readJsonBody(request))
      json(response, 200, payload)
      return
    }

    if (url.pathname === '/api/jobs' && request.method === 'POST') {
      const body = await readJsonBody(request)
      const job = await startJob(body)
      json(response, 202, jobSummary(job))
      return
    }

    if (url.pathname.startsWith('/api/jobs/')) {
      const [, , , id, action] = url.pathname.split('/')
      const job = jobs.get(id)
      if (!job) {
        json(response, 404, { error: `没有这个任务：${id}` })
        return
      }
      if (action === 'cancel' && request.method === 'POST') {
        job.controller.abort()
        json(response, 200, jobSummary(job))
        return
      }
      json(response, 200, jobSummary(job, { includeResult: url.searchParams.get('result') !== '0' }))
      return
    }

    if (url.pathname === '/api/runs') {
      json(response, 200, { runs: await listRuns() })
      return
    }

    if (url.pathname.startsWith('/api/runs/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/runs/'.length))
      const run = await loadRun(id)
      if (!run) {
        json(response, 404, { error: `没有这个产物目录：${id}` })
        return
      }
      json(response, 200, run.result)
      return
    }

    if (url.pathname === '/api/pair') {
      const runId = url.searchParams.get('run')
      const a = (url.searchParams.get('a') ?? '').trim()
      const b = (url.searchParams.get('b') ?? '').trim()
      if (a === '' || b === '') {
        json(response, 400, { error: '需要 a 和 b 两个角色名。' })
        return
      }
      json(response, 200, await pairReport(runId, a, b))
      return
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      await servePage(response)
      return
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  } catch (error) {
    const status = error.statusCode ?? 400
    if (status >= 500) console.error(`[serve] ${error.stack ?? error.message}`)
    else console.error(`[serve] ${error.message}`)
    json(response, status, { error: error.message })
  }
})

// ── extraction ──────────────────────────────────────────────────────────────────────────────

/** Synchronous extraction, kept for short texts and for the smoke test. */
async function handleExtract(body) {
  const text = normalise(body.text)
  const started = Date.now()
  const payload = await runExtraction({
    text,
    callModel: (options) => callChat({ ...options, model: MODEL, baseUrl: BASE_URL }),
    options: { mode: body.mode ?? 'auto', model: MODEL, concurrency: 4, rag: body.rag ?? {} },
  })
  const result = viewerPayload(payload, text, '上传的文本')
  console.log(
    `[extract] ${text.length} 字 → ${result.stats.nodes} 角色 / ${result.stats.edges} 边 ` +
      `(verified ${result.stats.verified}, repaired ${result.stats.repaired}, dropped ${result.stats.dropped}) ` +
      `in ${Math.round((Date.now() - started) / 1000)}s`,
  )
  console.log(`          ${summarize(result.stats)}`)
  return result
}

async function startJob(body) {
  const text = normalise(body.text)
  const mode = body.mode ?? 'auto'
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  const id = `serve-${stamp}-${text.length}`
  const runDir = join(RUNS, id)
  const store = createRunStore(runDir)
  await store.ensure()
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, 'text.txt'), text, 'utf8')

  const job = {
    id,
    runDir,
    store,
    text,
    chars: text.length,
    mode,
    status: 'running',
    phase: 'queued',
    progress: { done: 0, total: 0 },
    startedAt: Date.now(),
    finishedAt: null,
    stats: null,
    result: null,
    error: null,
    controller: new AbortController(),
    log: [],
  }
  jobs.set(id, job)

  // Deliberately not awaited: the page gets the id immediately and polls for progress.
  void runJob(job, body)
  return job
}

async function runJob(job, body) {
  const push = (event) => {
    job.phase = event.phase === 'extract' ? 'extract' : event.phase
    if (event.phase === 'extract') {
      job.progress = { done: event.done, total: event.total }
      job.usage = event.usage ?? job.usage
    }
    if (job.log.length < 400) job.log.push({ at: Date.now() - job.startedAt, ...event })
  }

  try {
    const payload = await runExtraction({
      text: job.text,
      store: job.store,
      signal: job.controller.signal,
      onProgress: push,
      options: {
        mode: job.mode,
        model: MODEL,
        concurrency: Number(body.concurrency ?? 4),
        maxEvidencesPerPair: Number(body.maxEvidencePerPair ?? 3),
        planOnly: Boolean(body.planOnly),
        chunk: body.chunk ?? {},
        rag: {
          maxBlocks: body.maxBlocks ? Number(body.maxBlocks) : Number.POSITIVE_INFINITY,
          maxPairs: body.maxPairs ? Number(body.maxPairs) : undefined,
          castSampleBlocks: body.castSampleBlocks ? Number(body.castSampleBlocks) : undefined,
          minCooccurrence: body.minCooccurrence ? Number(body.minCooccurrence) : undefined,
        },
      },
      callModel: (options) => callChat({ ...options, model: MODEL, baseUrl: BASE_URL }),
    })

    const result = viewerPayload(payload, job.text, body.name ?? '上传的长文本')
    job.result = result
    job.stats = result.stats
    job.status = 'done'
    job.phase = 'done'
    job.finishedAt = Date.now()
    job.progress = { done: job.progress.total || result.stats.chunksExtracted, total: job.progress.total || result.stats.chunks }
    await writeFile(join(job.runDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8')
    await writeFile(join(job.runDir, 'summary.json'), JSON.stringify(summaryOf(result, job), null, 2), 'utf8')
    runCache.delete(job.id)
    console.log(
      `[job ${job.id}] done: ${result.stats.chars} 字 / ${result.stats.chunks} 块 / ${result.stats.edges} 边 ` +
        `/ $${result.stats.costUsd} / ${Math.round((job.finishedAt - job.startedAt) / 1000)}s`,
    )
  } catch (error) {
    job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'
    job.phase = job.status
    job.error = error.message
    job.finishedAt = Date.now()
    console.error(`[job ${job.id}] ${job.status}: ${error.message}`)
  }
}

/**
 * The graph payload the page consumes. It is also what lands in result.json, so a run started from
 * the CLI and a run started from the page are the same shape.
 */
function viewerPayload(payload, text, name) {
  return {
    v: 2,
    nodes: payload.nodes,
    edges: payload.edges,
    stats: payload.stats,
    source: { name, chars: text.length },
    chunks: payload.chunks ?? [],
    cast: payload.cast ?? [],
    plan: payload.plan ?? null,
    mode: payload.mode,
    planOnly: Boolean(payload.planOnly),
  }
}

function summaryOf(result, job) {
  return {
    id: job.id,
    chars: result.stats.chars,
    mode: result.stats.mode,
    nodes: result.stats.nodes,
    edges: result.stats.edges,
    chunks: result.stats.chunks,
    evidencePassRate: result.stats.evidencePassRate,
    costUsd: result.stats.costUsd,
    elapsedSeconds: Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000),
    generatedAt: new Date().toISOString(),
    source: result.source,
  }
}

function jobSummary(job, { includeResult = true } = {}) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    chars: job.chars,
    mode: job.mode,
    progress: job.progress,
    elapsedSeconds: Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000),
    usage: job.usage ? normalizeUsage(job.usage) : null,
    stats: job.stats,
    error: job.error,
    result: includeResult ? job.result : null,
  }
}

// ── runs and pair retrieval ────────────────────────────────────────────────────────────────

async function listRuns() {
  let names = []
  try {
    names = await readdir(RUNS)
  } catch {
    return []
  }
  const runs = []
  for (const name of names) {
    try {
      const summary = JSON.parse(await readFile(join(RUNS, name, 'summary.json'), 'utf8'))
      runs.push(summary)
      continue
    } catch {
      /* no summary: fall through to the manifest */
    }
    try {
      const result = JSON.parse(await readFile(join(RUNS, name, 'result.json'), 'utf8'))
      runs.push({
        id: name,
        chars: result.stats?.chars ?? 0,
        nodes: result.stats?.nodes ?? 0,
        edges: result.stats?.edges ?? 0,
        mode: result.stats?.mode ?? result.mode ?? null,
        costUsd: result.stats?.costUsd ?? 0,
        source: result.source ?? null,
      })
    } catch {
      /* not a run directory */
    }
  }
  runs.sort((a, b) => (b.chars ?? 0) - (a.chars ?? 0))
  return runs
}

async function loadRun(id) {
  if (!id) return null
  if (runCache.has(id)) return runCache.get(id)
  const dir = join(RUNS, id)
  try {
    const [resultRaw, textRaw, chunksRaw, castRaw] = await Promise.all([
      readFile(join(dir, 'result.json'), 'utf8'),
      readFile(join(dir, 'text.txt'), 'utf8').catch(() => ''),
      readFile(join(dir, 'chunks.json'), 'utf8').catch(() => '[]'),
      readFile(join(dir, 'cast.json'), 'utf8').catch(() => '{}'),
    ])
    const result = JSON.parse(resultRaw)
    const offsets = JSON.parse(chunksRaw)
    const cast = JSON.parse(castRaw)
    const entry = {
      id,
      result,
      text: textRaw,
      chunks: offsets.map((chunk) => ({ ...chunk, text: textRaw.slice(chunk.start, chunk.end) })),
      cast: cast.clusters ?? result.cast ?? [],
    }
    runCache.set(id, entry)
    return entry
  } catch {
    return null
  }
}

/**
 * "What happens between these two?" — the verified edges plus the verbatim passages where they
 * appear together. The passages are retrieval, not relations: they are labelled `source: 'retrieval'`
 * and the page must render them differently from evidence.
 */
async function pairReport(runId, a, b) {
  const run = (await loadRun(runId)) ?? (await latestRun())
  if (!run) {
    return { run: null, a, b, edges: [], passages: [], note: '还没有任何 run 产物；先跑一次抽取。' }
  }

  const graph = run.result
  const resolveName = (name) => {
    const direct = graph.nodes.find((node) => node.name === name)
    if (direct) return direct
    return graph.nodes.find((node) => (node.aliases ?? []).includes(name)) ?? null
  }
  const left = resolveName(a)
  const right = resolveName(b)
  if (!left || !right) {
    return { run: run.id, a, b, edges: [], passages: [], note: '这些名字不在当前图谱里。' }
  }

  const edges = graph.edges.filter(
    (edge) =>
      (edge.source === left.id && edge.target === right.id) ||
      (edge.source === right.id && edge.target === left.id),
  )
  const keysOf = (node) => [node.name, ...(node.aliases ?? [])]
  const passages = retrievePassages({
    text: run.text,
    chunks: run.chunks,
    leftKeys: keysOf(left),
    rightKeys: keysOf(right),
    limit: 8,
  })

  return {
    run: run.id,
    a: left.name,
    b: right.name,
    left: { id: left.id, name: left.name, aliases: left.aliases ?? [] },
    right: { id: right.id, name: right.name, aliases: right.aliases ?? [] },
    edges,
    passages,
    coverage: {
      verifiedEdges: edges.length,
      passages: passages.length,
      chunks: run.chunks.length,
      mode: graph.stats?.mode ?? graph.mode ?? null,
    },
  }
}

async function latestRun() {
  const runs = await listRuns()
  for (const run of runs) {
    if (run.planOnly) continue
    const loaded = await loadRun(run.id)
    if (loaded) return loaded
  }
  return null
}

// ── page and plumbing ─────────────────────────────────────────────────────────────────────

async function servePage(response) {
  try {
    const page = await readFile(PAGE, 'utf8')
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(page)
  } catch {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('out/character-graph.html 还不存在。先运行 node scripts/build-viewer.mjs')
  }
}

function normalise(value) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  if (text.trim().length < MIN_CHARS) {
    throw httpError(400, `文本太短（${text.trim().length} 字），至少 ${MIN_CHARS} 字才抽得出有证据的关系。`)
  }
  if (text.length > MAX_CHARS) {
    throw httpError(400, `文本 ${text.length.toLocaleString('en-US')} 字，超过上限 ${MAX_CHARS.toLocaleString('en-US')} 字。`)
  }
  return text
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectBody(httpError(413, '文本太大（超过 12 MB）。'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        rejectBody(httpError(400, '请求体不是 JSON。'))
      }
    })
    request.on('error', rejectBody)
  })
}

function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  response.end(body)
}

await mkdir(RUNS, { recursive: true })
await readFile(PAGE, 'utf8').catch(() => {
  console.warn('warning: out/character-graph.html 不存在，页面会返回 500。先运行 build-viewer.mjs')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`character-graph viewer → http://127.0.0.1:${PORT}`)
  console.log(`page: ${PAGE}`)
  console.log(`runs: ${RUNS}`)
  console.log(`model: ${MODEL} (${BASE_URL})`)
  try {
    readApiKey()
    console.log('credential: found')
  } catch (error) {
    console.error(`credential: ${error.message}`)
  }
})
