/**
 * The extraction pipeline: text → chunks → (retrieval) → per-chunk extraction → verification →
 * global merge.
 *
 * It is deliberately a function of an injected `callModel`, not of Cordis or fetch: the host tool
 * passes `ctx.llm`, the CLI and the viewer server pass lib/model.js, and the assertions pass a stub.
 * That is what makes the long-text path testable without burning quota.
 *
 * The evidence rule never moves: every chunk's reply goes through `verifyAndBind` against the exact
 * chunk text the model saw, and only then is its `charStart` shifted into global coordinates. A
 * failed quote is counted in `dropped` with a reason — never repaired by trusting the model.
 */

import { buildIndex, describeIndex } from './bm25.js'
import { chunkText, describeChunks } from './chunk.js'
import { textHash } from './checkpoint.js'
import {
  CHUNK_SYSTEM_PROMPT,
  CAST_SYSTEM_PROMPT,
  SINGLE_PASS_MAX_CHARS,
  SYSTEM_PROMPT,
  buildCastPrompt,
  buildChunkPrompt,
  buildPrompt,
  parseCastJson,
  parseModelJson,
  verifyAndBind,
} from './extract.js'
import { mergeChunkGraphs } from './merge.js'
import { addUsage, costOf, emptyUsage } from './model.js'
import { buildRetrievalPlan, clusterCast } from './retrieve.js'

/** Chunks the cheap cast scan looks at when the text is long. */
const DEFAULT_CAST_SAMPLES = 12

/**
 * @param {{
 *   text: string,
 *   callModel: (options: {system: string, user: string, maxTokens?: number, label?: string}) => Promise<{text: string, usage?: any, seconds?: number}>,
 *   options?: any,
 *   onProgress?: (event: any) => void,
 *   store?: any,
 *   signal?: AbortSignal,
 * }} input
 */
export async function runExtraction({ text, callModel, options = {}, onProgress = () => {}, store = null, signal = null }) {
  const startedAt = Date.now()
  const mode = resolveMode(options.mode, text.length, options)
  const chunkOptions = options.chunk ?? {}
  const concurrency = Math.max(1, Math.min(12, options.concurrency ?? 4))
  /**
   * Distinct narrative beats kept per unordered pair, across the whole text. More than three turns
   * the pair view into a list and the graph into a hairball; the model proposes far more than this
   * in a long book, and the extra ones are counted as `pair-cap` drops rather than silently dropped.
   */
  const maxEvidencesPerPair = options.maxEvidencesPerPair ?? 3
  const hash = textHash(text)
  const timing = { prepareMs: 0, castMs: 0, retrieveMs: 0, extractMs: 0, mergeMs: 0 }
  const usage = emptyUsage()
  const calls = { total: 0, failed: 0 }

  await store?.ensure()

  const previousManifest = await store?.readManifest()
  const resumeSafe =
    Boolean(store) &&
    options.resume !== false &&
    previousManifest?.textHash === hash &&
    previousManifest?.model === (options.model ?? null) &&
    previousManifest?.mode === mode
  if (store && previousManifest && !resumeSafe && options.resume !== false) {
    onProgress({ phase: 'resume-mismatch', message: 'run 目录属于另一份文本/模型，本次忽略旧中间产物' })
  }

  const manifest = {
    v: 2,
    createdAt: new Date().toISOString(),
    textHash: hash,
    chars: text.length,
    mode,
    model: options.model ?? null,
    chunk: chunkOptions,
    rag: mode === 'rag' ? { ...(options.rag ?? {}) } : null,
    resumeSafe,
  }
  await store?.writeManifest(manifest)

  onProgress({ phase: 'start', mode, chars: text.length, textHash: hash })

  if (mode === 'single') {
    const single = await extractSingle({ text, callModel, onProgress })
    const stats = finishStats({
      base: single.bound.stats,
      text,
      chunks: [{ index: 0, start: 0, end: text.length, chars: text.length }],
      extracted: 1,
      failed: 0,
      calls: single.calls,
      usage: single.usage,
      cost: costOf(single.usage),
      elapsedMs: Date.now() - startedAt,
      timing,
      mode,
      rag: null,
      modelSeconds: single.seconds,
    })
    const payload = { nodes: single.bound.nodes, edges: single.bound.edges, stats, chunks: [], mode }
    await store?.writeResult(payload)
    return payload
  }

  // ── chunking ───────────────────────────────────────────────────────────────────────────
  const prepareStart = Date.now()
  const chunks = chunkText(text, chunkOptions).map((chunk) => ({ ...chunk, text: text.slice(chunk.start, chunk.end) }))
  const coverage = describeChunks(chunks, text.length)
  timing.prepareMs = Date.now() - prepareStart
  await store?.writeChunks(chunks.map(({ text: _text, ...rest }) => rest))
  onProgress({ phase: 'chunked', chunks: chunks.length, coverage: coverage.coverage, chars: text.length })

  // ── stage 1: cast scan (cheap) ───────────────────────────────────────────────────────
  let clusters = []
  let castMeta = null
  let castUsage = emptyUsage()
  let castCalls = 0
  let castSeconds = 0
  const castFailures = []
  if (mode === 'rag') {
    const rag = options.rag ?? {}
    const cachedCast = resumeSafe ? await store?.readCast() : null
    if (Array.isArray(options.cast) && options.cast.length > 0) {
      clusters = clusterCast([options.cast])
      castMeta = { source: 'provided', samples: 0 }
    } else if (cachedCast?.clusters?.length > 0 && (cachedCast.textHash === undefined || cachedCast.textHash === hash)) {
      // Resuming a run must not pay for the scan again: the cast is an input to the plan, not a
      // result of the extraction, and re-sampling it would also silently change the plan.
      clusters = cachedCast.clusters
      castMeta = { source: 'checkpoint', samples: cachedCast.samples ?? 0 }
      castUsage = cachedCast.usage ? { ...emptyUsage(), ...cachedCast.usage } : emptyUsage()
      mergeUsage(usage, castUsage)
      onProgress({ phase: 'cast-reused', cast: clusters.length })
    } else {
      const castStart = Date.now()
      const sampleIndexes = pickSamples(chunks.length, rag.castSampleBlocks ?? DEFAULT_CAST_SAMPLES)
      const scans = []
      await mapLimit(sampleIndexes, concurrency, async (chunkIndex) => {
        throwIfAborted(signal)
        const chunk = chunks[chunkIndex]
        try {
          const reply = await callModel({
            system: CAST_SYSTEM_PROMPT,
            user: buildCastPrompt(chunk.text, chunk.index, chunks.length),
            // The scan answers with a short name list, but a thinking model has to spend budget on
            // its reasoning before that list appears: 900 tokens is enough for the answer and not
            // enough for the answer plus the thinking that precedes it.
            maxTokens: 2048,
            label: `cast ${chunk.index}`,
          })
          calls.total += 1
          castCalls += 1
          castSeconds += reply.seconds ?? 0
          castUsage = addUsage(castUsage, reply.usage ?? emptyUsage())
          if (reply.usage) usage.prompt += reply.usage.prompt ?? 0
          if (reply.usage) usage.completion += reply.usage.completion ?? 0
          if (reply.usage) usage.cacheHit += reply.usage.cacheHit ?? 0
          const parsed = parseCastJson(reply.text)
          scans.push(parsed.cast)
          onProgress({ phase: 'cast', done: scans.length, total: sampleIndexes.length, chunkIndex })
        } catch (error) {
          calls.failed += 1
          castFailures.push({ chunkIndex: chunk.index, error: error.message })
          onProgress({ phase: 'cast-failed', chunkIndex, error: error.message })
        }
      })
      clusters = clusterCast(scans)
      castMeta = { source: 'scan', samples: sampleIndexes.length, scannedIndexes: sampleIndexes }
      timing.castMs = Date.now() - castStart
      await store?.writeCast({ ...castMeta, textHash: hash, clusters, usage: castUsage })
    }
    onProgress({ phase: 'casted', cast: clusters.length, calls: castCalls })
  }

  // ── stage 2: retrieval plan ───────────────────────────────────────────────────────────
  let plan = null
  let targets
  if (mode === 'rag') {
    const retrieveStart = Date.now()
    plan = buildRetrievalPlan({
      chunks,
      clusters,
      options: {
        minCooccurrence: options.rag?.minCooccurrence ?? (text.length > 50000 ? 2 : 1),
        maxPairs: options.rag?.maxPairs ?? 120,
        maxBlocks: options.rag?.maxBlocks ?? Number.POSITIVE_INFINITY,
      },
    })
    timing.retrieveMs = Date.now() - retrieveStart
    targets = plan.selected
      .slice()
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((entry) => ({ chunk: chunks[entry.chunkIndex], focusPairs: entry.focusPairs }))
    await store?.writePlan({
      cast: { ...castMeta, size: clusters.length },
      pairs: plan.pairs.map((pair) => ({
        a: pair.a,
        b: pair.b,
        cooccurrence: pair.cooccurrence,
        coverage: Number(pair.coverage.toFixed(3)),
        blocks: pair.blocks,
      })),
      candidateBlocks: plan.candidateCount,
      selectedBlocks: plan.selectedIndexes.size,
      skippedByReason: plan.skippedByReason,
      skippedBlocks: plan.skippedBlocks.slice(0, 500),
    })
    onProgress({
      phase: 'planned',
      pairs: plan.pairs.length,
      candidates: plan.candidateCount,
      selected: plan.selectedIndexes.size,
      skipped: plan.skippedBlocks.length,
      skippedByReason: plan.skippedByReason,
    })

    // A plan-only run is the cheap half of the RAG path: it answers "which blocks would be read,
    // and why" without paying for a single extraction. Useful for sizing a long book before
    // committing to it, and it is what the viewer shows when a run is still in progress.
    if (options.planOnly) {
      const elapsedMs = Date.now() - startedAt
      const cost = costOf(usage)
      const offsets = chunks.map(({ text: _text, ...rest }) => rest)
      const stats = finishStats({
        base: { dropped: 0, droppedReasons: [], edges: 0, nodes: 0, verified: 0, repaired: 0 },
        text,
        chunks,
        extracted: 0,
        failed: 0,
        calls: calls.total,
        usage,
        cost,
        elapsedMs,
        timing,
        mode,
        usageEstimated: usage.estimated === true,
        extra: {
          coverage: Number(coverage.coverage.toFixed(4)),
          plannedOnly: true,
          rag: {
            enabled: true,
            castSize: clusters.length,
            castSamples: castMeta?.samples ?? 0,
            castCalls,
            castCostUsd: Number(costOf(castUsage).total.toFixed(4)),
            pairs: plan.pairs.length,
            candidateBlocks: plan.candidateCount,
            selectedBlocks: plan.selectedIndexes.size,
            skippedBlocks: plan.skippedBlocks.length,
            skippedByReason: plan.skippedByReason,
            savedBlocks: Math.max(0, chunks.length - plan.selectedIndexes.size),
            savedRatio:
              chunks.length === 0 ? 0 : Math.max(0, chunks.length - plan.selectedIndexes.size) / chunks.length,
            estimatedSavedUsd: null,
          },
        },
      })
      const payload = {
        v: 2,
        nodes: [],
        edges: [],
        stats,
        chunks: offsets,
        cast: clusters,
        plan: planPayload(plan),
        failures: [],
        mode,
        planOnly: true,
        index: describeIndex(buildIndex(chunks.map((chunk) => ({ id: chunk.index, text: chunk.text })))),
      }
      await store?.writeResult(payload)
      onProgress({ phase: 'plan-only', stats })
      return payload
    }
  } else {
    targets = chunks.map((chunk) => ({ chunk, focusPairs: [] }))
  }

  // An empty target list in RAG mode means the cheap scan or the plan came up empty. Say which of
  // the two it was, instead of falling through to "all 0 chunks failed", which told the user
  // nothing about the scan that actually broke.
  if (mode === 'rag' && targets.length === 0) {
    const reason =
      castCalls === 0 && castFailures.length > 0
        ? `角色扫描的 ${castFailures.length} 次调用全部失败：${castFailures[0]?.error ?? '未知错误'}`
        : clusters.length === 0
          ? '角色扫描没有从样块里认出任何角色'
          : `检索计划没有选中任何块（候选对 ${plan?.pairs.length ?? 0}）`
    throw new Error(`${reason}。中间产物已保存在 ${store?.dir ?? '（未启用落盘）'}，修好后可加 --resume 续跑。`)
  }

  // ── stage 3: per-chunk fine extraction ───────────────────────────────────────────────
  const extractStart = Date.now()
  const results = []
  const failures = []
  let completed = 0
  let reused = 0
  let usageEstimated = false
  /** Wall time of *this* invocation; model time is the sum of every artifact's own call time. */
  let modelSeconds = 0
  const total = targets.length
  const castNames = clusters.map((cluster) => cluster.name)

  await mapLimit(targets, concurrency, async (target) => {
    throwIfAborted(signal)
    const chunk = target.chunk

    if (store && resumeSafe) {
      const existing = await store.readBlock(chunk.index)
      if (existing?.status === 'ok' && existing.textHash === hash) {
        results.push(existing)
        completed += 1
        reused += 1
        if (existing.usage) mergeUsage(usage, existing.usage)
        modelSeconds += existing.seconds ?? 0
        onProgress({ phase: 'extract', done: completed, total, reused: true, chunkIndex: chunk.index })
        return
      }
    }

    try {
      // A malformed JSON reply is a cheap, recoverable failure — retrying the same chunk is much
      // better than leaving a hole that only a manual `--resume` would fill. One retry, with an
      // explicit reminder, and only for parse errors: a model error is not worth doubling.
      let parsed = null
      let reply = null
      let bound = null
      for (let attempt = 0; attempt < 2; attempt += 1) {
        reply = await callModel({
          system: attempt === 0 ? CHUNK_SYSTEM_PROMPT : `${CHUNK_SYSTEM_PROMPT}\n11. 上一次回复不是合法 JSON。这次只输出一个 JSON 对象，不要代码块、不要解释。`,
          user: buildChunkPrompt({
            text: chunk.text,
            ordinal: chunk.index,
            total: chunks.length,
            cast: castNames,
            focusPairs: target.focusPairs ?? [],
          }),
          maxTokens: 4096,
          label: `chunk ${chunk.index}${attempt > 0 ? ' (retry)' : ''}`,
        })
        calls.total += 1
        if (reply.usage?.estimated) usageEstimated = true
        mergeUsage(usage, reply.usage)
        modelSeconds += reply.seconds ?? 0
        try {
          parsed = parseModelJson(reply.text)
          bound = verifyAndBind(chunk.text, parsed)
          break
        } catch (error) {
          if (attempt === 1) throw error
          calls.retried = (calls.retried ?? 0) + 1
          onProgress({ phase: 'extract-retry', chunkIndex: chunk.index, error: error.message })
        }
      }
      const record = {
        status: 'ok',
        textHash: hash,
        chunkIndex: chunk.index,
        chunkStart: chunk.start,
        chunkEnd: chunk.end,
        seconds: reply.seconds ?? 0,
        usage: reply.usage ?? emptyUsage(),
        parsed: {
          nodes: parsed.nodes,
          edges: parsed.edges,
          modelNodeCount: parsed.modelNodeCount,
          modelEdgeCount: parsed.modelEdgeCount,
        },
        bound,
      }
      if (store) await store.writeBlock(chunk.index, record)
      results.push(record)
    } catch (error) {
      calls.failed += 1
      failures.push({ chunkIndex: chunk.index, error: error.message })
      onProgress({ phase: 'extract-failed', chunkIndex: chunk.index, error: error.message })
    } finally {
      completed += 1
      onProgress({
        phase: 'extract',
        done: completed,
        total,
        chunkIndex: chunk.index,
        calls: calls.total,
        usage,
        elapsedMs: Date.now() - startedAt,
      })
    }
  })

  if (failures.length > 0) await store?.writeFailures(failures)
  timing.extractMs = Date.now() - extractStart
  results.sort((a, b) => a.chunkIndex - b.chunkIndex)

  // ── stage 4: merge ───────────────────────────────────────────────────────────────────
  const mergeStart = Date.now()
  const merged = mergeChunkGraphs({
    text,
    chunks,
    results: results.map((record) => ({
      chunk: chunks[record.chunkIndex] ?? { index: record.chunkIndex, start: record.chunkStart },
      parsed: record.parsed,
      bound: record.bound,
    })),
    options: { maxEvidencesPerPair },
  })
  timing.mergeMs = Date.now() - mergeStart
  if (results.length === 0) {
    throw new Error(
      `所有 ${total} 个分块的模型调用都失败了（${failures[0]?.error ?? '未知错误'}）。中间产物已保存在 ${store?.dir ?? '（未启用落盘）'}，修好后可加 --resume 续跑。`,
    )
  }

  const cost = costOf(usage)
  const elapsedMs = Date.now() - startedAt
  const savedBlocks = Math.max(0, chunks.length - results.length)
  const avgBlockCost = results.length > 0 ? cost.total / results.length : 0

  const stats = finishStats({
    base: merged.stats,
    text,
    chunks,
    extracted: results.length,
    failed: failures.length,
    calls: calls.total,
    usage,
    cost,
    elapsedMs,
    timing,
    mode,
    usageEstimated,
    modelSeconds: modelSeconds + castSeconds,
    extra: {
      chunksReused: reused,
      callsRetried: calls.retried ?? 0,
      aliasMerges: merged.stats.aliasMerges,
      aliasDeclarations: merged.stats.aliasDeclarations,
      aliasRefusals: merged.stats.aliasRefusals,
      duplicateEvidence: merged.stats.duplicateEvidence,
      genericDropped: merged.stats.genericDropped,
      genericExamples: merged.stats.genericExamples,
      pairCapTop: merged.stats.pairCapTop,
      suspects: merged.stats.suspects,
      suspectExamples: merged.stats.suspectExamples,
      chunksFailed: failures.length,
      coverage: Number(coverage.coverage.toFixed(4)),
      rag:
        mode === 'rag' && plan
          ? {
              enabled: true,
              castSize: clusters.length,
              castSamples: castMeta?.samples ?? 0,
              castCalls,
              castCostUsd: costOf(castUsage).total,
              pairs: plan.pairs.length,
              candidateBlocks: plan.candidateCount,
              selectedBlocks: plan.selectedIndexes.size,
              skippedBlocks: plan.skippedBlocks.length,
              skippedByReason: plan.skippedByReason,
              savedBlocks,
              savedRatio: chunks.length === 0 ? 0 : savedBlocks / chunks.length,
              estimatedSavedUsd: Number((savedBlocks * avgBlockCost).toFixed(4)),
            }
          : { enabled: false },
    },
  })

  // The merge decides who exists and what they are called; keep its reasoning next to the result so
  // a suspicious alias can be checked afterwards instead of guessed at.
  const mergeReportPath = store && merged.mergeReport ? 'merge-report.json' : null
  if (mergeReportPath) {
    await store.writeNamed(mergeReportPath, merged.mergeReport)
    stats.mergeReport = mergeReportPath
  }

  const payload = {
    nodes: merged.nodes,
    edges: merged.edges,
    stats,
    chunks: chunks.map(({ text: _text, ...rest }) => rest),
    cast: clusters,
    plan: plan ? planPayload(plan) : null,
    failures,
    mode,
  }
  await store?.writeResult(payload)
  onProgress({ phase: 'done', stats, elapsedMs })
  return payload
}

async function extractSingle({ text, callModel, onProgress }) {
  const usage = emptyUsage()
  const reply = await callModel({
    system: SYSTEM_PROMPT,
    user: buildPrompt(text),
    maxTokens: 8192,
    label: 'single-pass',
  })
  const parsed = parseModelJson(reply.text)
  const bound = verifyAndBind(text, parsed)
  mergeUsage(usage, reply.usage)
  usage.estimated = Boolean(reply.usage?.estimated)
  onProgress({ phase: 'single', edges: bound.edges.length, usage })
  return { bound, usage, calls: 1, seconds: reply.seconds ?? 0 }
}

/**
 * Which pipeline a text gets.
 *
 * Below `singlePassMax` one call sees everything. Above it, chunking. The retrieval stage only pays
 * for itself once the corpus is big enough that (a) the cheap cast scan is a small fraction of the
 * bill and (b) a budget/selection decision actually exists — hence the 50k threshold, which is the
 * same number the README and the tool description quote.
 */
function resolveMode(requested, chars, options) {
  if (requested === 'single' || requested === 'chunk' || requested === 'rag') return requested
  const threshold = options.singlePassMax ?? SINGLE_PASS_MAX_CHARS
  if (chars <= threshold) return 'single'
  if (options.rag?.enabled === true) return 'rag'
  if (options.rag?.enabled === false) return 'chunk'
  const ragThreshold = options.rag?.threshold ?? 50000
  return chars > ragThreshold ? 'rag' : 'chunk'
}

function finishStats({ base, text, chunks, extracted, failed, calls, usage, cost, elapsedMs, timing, mode, usageEstimated = false, modelSeconds = 0, extra = {} }) {
  const kept = base.edges ?? 0
  const dropped = base.dropped ?? 0
  /** Sum of every model call that produced the artifacts, including calls made by earlier runs. */
  const totalModelMs = Math.round((modelSeconds || elapsedMs / 1000) * 1000)
  return {
    chars: text.length,
    chunks: chunks.length,
    chunksExtracted: extracted,
    chunksFailed: failed,
    modelNodes: base.modelNodes ?? 0,
    modelEdges: base.modelEdges ?? 0,
    nodes: base.nodes ?? 0,
    edges: kept,
    verified: base.verified ?? 0,
    repaired: base.repaired ?? 0,
    dropped,
    droppedReasons: base.droppedReasons ?? [],
    evidencePassRate: base.evidencePassRate ?? (kept + dropped === 0 ? 1 : kept / (kept + dropped)),
    calls,
    tokens: {
      prompt: usage.prompt,
      completion: usage.completion,
      cacheHit: usage.cacheHit,
      estimated: usageEstimated || usage.estimated === true,
    },
    costUsd: Number(cost.total.toFixed(4)),
    cost: { input: Number(cost.input.toFixed(4)), output: Number(cost.output.toFixed(4)) },
    elapsedMs,
    modelMs: totalModelMs,
    charsPerSecond: elapsedMs > 0 ? Math.round((text.length / elapsedMs) * 1000) : 0,
    msPerChunk: extracted > 0 ? Math.round(elapsedMs / extracted) : 0,
    per10k: {
      promptTokens: Math.round((usage.prompt * 10000) / Math.max(1, text.length)),
      completionTokens: Math.round((usage.completion * 10000) / Math.max(1, text.length)),
      seconds: Number(((totalModelMs / 1000) * 10000 / Math.max(1, text.length)).toFixed(1)),
      costUsd: Number(((cost.total * 10000) / Math.max(1, text.length)).toFixed(4)),
    },
    timings: timing,
    mode,
    ...extra,
  }
}

function mergeUsage(target, incoming) {
  if (!incoming) return
  target.prompt += incoming.prompt ?? 0
  target.completion += incoming.completion ?? 0
  target.cacheHit += incoming.cacheHit ?? 0
}

/** Evenly spaced sample indexes that always include the first and last chunk. */
export function pickSamples(count, samples) {
  if (count <= 0) return []
  const wanted = Math.max(1, Math.min(count, samples))
  if (wanted === count) return Array.from({ length: count }, (_, index) => index)
  const indexes = new Set()
  for (let i = 0; i < wanted; i += 1) {
    indexes.add(Math.round((i * (count - 1)) / Math.max(1, wanted - 1)))
  }
  return [...indexes].sort((a, b) => a - b)
}

/** Bounded concurrency with per-item failure isolation. */
export async function mapLimit(items, limit, worker) {
  const queue = [...items]
  const errors = []
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      try {
        await worker(item)
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        errors.push(error)
      }
    }
  })
  await Promise.all(runners)
  return errors
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('抽取已取消。')
    error.name = 'AbortError'
    throw error
  }
}

function planPayload(plan) {
  return {
    pairs: plan.pairs.map((pair) => ({
      a: pair.a,
      b: pair.b,
      cooccurrence: pair.cooccurrence,
      blocks: pair.blocks,
    })),
    candidateBlocks: plan.candidateCount,
    selectedBlocks: [...plan.selectedIndexes].sort((a, b) => a - b),
    skippedByReason: plan.skippedByReason,
  }
}

/** Index over the chunks, used by the viewer's free-text retrieval endpoint. */
export function indexForChunks(chunks) {
  return buildIndex(chunks.map((chunk) => ({ id: chunk.index, text: chunk.text ?? '' })))
}

export { describeIndex }
