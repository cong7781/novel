/**
 * Assertions for the long-text pipeline: chunking, BM25 retrieval, global merge/alias resolution,
 * RAG planning, pair retrieval, and — the important one — that the verbatim evidence gate and the
 * resume path still behave when the text is bigger than one prompt.
 *
 * Everything here runs offline through a stub model, so it is safe to run in CI and it cannot burn
 * quota:  node scripts/test-pipeline.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildIndex, describeIndex, search, tokenize } from '../lib/bm25.js'
import { createRunStore } from '../lib/checkpoint.js'
import { chunkText, describeChunks } from '../lib/chunk.js'
import { mergeChunkGraphs, mineAliasDeclarations, normalizeKey } from '../lib/merge.js'
import { pickSamples, runExtraction } from '../lib/pipeline.js'
import { buildRetrievalPlan, clusterCast, indexChunkMentions, retrievePassages } from '../lib/retrieve.js'

// ── chunking ───────────────────────────────────────────────────────────────────────────────
{
  const paragraph = '苏晚把药碗递给沈砚，说，趁热喝，凉了伤胃。沈砚没接，只说，放着吧。\n\n'
  const text = paragraph.repeat(400) // ~14.8k chars
  const chunks = chunkText(text, { target: 4000, min: 3000, max: 5000, overlap: 0.12 })
  const coverage = describeChunks(chunks, text.length)

  assert.ok(chunks.length >= 3, 'a 14k text splits into several chunks')
  assert.equal(coverage.coverage, 1, 'every character is covered by at least one chunk')
  assert.ok(coverage.maxChars <= 5000, 'no chunk exceeds the hard maximum')
  assert.ok(chunks.every((chunk) => chunk.chars > 0), 'no empty chunk')
  assert.ok(chunks.every((chunk, index) => index === 0 || chunk.start > chunks[index - 1].start), 'chunks advance monotonically')
  assert.ok(chunks.slice(1).every((chunk) => chunk.overlapPrev > 0), 'consecutive chunks overlap')
  for (const chunk of chunks.slice(0, -1)) {
    const last = text[chunk.end - 1]
    assert.ok('。！？…\n」'.includes(last), `chunk ends on a boundary, got ${JSON.stringify(last)}`)
  }
  assert.equal(chunkText('短文本', { target: 4000 }).length, 1, 'short text stays a single chunk')
  assert.deepEqual(chunkText('', {}), [], 'empty text has no chunks')
}

// ── BM25 ──────────────────────────────────────────────────────────────────────────────────
{
  assert.deepEqual(tokenize('沈砚'), ['沈砚'], 'a two-character name is one bigram')
  assert.ok(tokenize('他说hello').includes('#hello'), 'latin words become their own terms')

  const docs = [
    { id: 0, text: '苏晚把药碗递给沈砚，说，趁热喝。' },
    { id: 1, text: '沈砚独自在河边钓鱼，一坐就是半天。' },
    { id: 2, text: '柳氏在后堂算账，算到深夜。' },
  ]
  const index = buildIndex(docs)
  assert.equal(describeIndex(index).docs, 3)

  const hit = search(index, '苏晚 沈砚')
  assert.equal(hit[0].id, 0, 'the block with both names wins')
  assert.ok(hit.every((entry, i) => i === 0 || hit[i - 1].score >= entry.score), 'results are ordered by score')
  assert.equal(search(index, '河边钓鱼')[0].id, 1, 'a free-text query retrieves the matching block')
  assert.equal(search(index, '完全不存在的词').length, 0, 'no match, no invented hit')
}

// ── alias declarations mined from the text ────────────────────────────────────────────────
{
  const text = '晚娘，人称三姑娘。苏晚又名晚娘。'
  const known = new Set(['晚娘', '三姑娘', '苏晚', '沈砚'])
  const found = mineAliasDeclarations(text, known)
  assert.ok(found.some((item) => item.a === '晚娘' && item.b === '三姑娘'), 'declaration 人称 is mined')
  assert.ok(found.some((item) => item.a === '苏晚' && item.b === '晚娘'), 'declaration 又名 is mined')
  assert.equal(mineAliasDeclarations(text, new Set(['沈砚'])).length, 0, 'unknown names are never linked')
  assert.equal(normalizeKey('「苏晚」'), '苏晚', 'quotes and brackets are normalised away')
}

// ── merge: alias resolution, cross-chunk dedupe, global offsets ────────────────────────────
{
  const paragraphs = [
    '苏晚把药碗递给沈砚，说，趁热喝，凉了伤胃。',
    '晚娘，人称三姑娘，是药铺里最不爱说话的人。',
    '沈砚没接碗，只说，放着吧。',
    '三姑娘站在门口，没有进来。',
    '苏晚又盛了一碗，放在沈砚手边。',
    '苏晚说，明天再来。',
  ]
  const text = paragraphs.join('\n\n')
  const quote = (index) => paragraphs[index]
  const at = (index) => text.indexOf(quote(index))
  assert.ok(paragraphs.every((paragraph) => text.includes(paragraph)), 'test text contains every quote')

  const splitAt = text.indexOf(paragraphs[3]) // chunk 0 ends where paragraph 4 begins
  const chunks = [
    { index: 0, start: 0, end: splitAt, chars: splitAt },
    { index: 1, start: splitAt - 30, end: text.length, chars: text.length - splitAt + 30 },
  ]
  const chunk0 = text.slice(chunks[0].start, chunks[0].end)
  const chunk1 = text.slice(chunks[1].start, chunks[1].end)
  assert.ok(chunk0.includes(quote(2)) && chunk1.includes(quote(2)), 'the overlap really contains the sentence quoted twice')

  const results = [
    {
      chunk: chunks[0],
      parsed: { modelNodeCount: 3, modelEdgeCount: 3 },
      bound: {
        nodes: [
          { id: 'n1', name: '苏晚', aliases: ['晚娘'] },
          { id: 'n2', name: '沈砚', aliases: [] },
          { id: 'n3', name: '三姑娘', aliases: [] },
        ],
        edges: [
          { source: 'n1', target: 'n2', relation: '朋友', evidence: quote(0), strength: 3, charStart: chunk0.indexOf(quote(0)), repaired: false },
          { source: 'n2', target: 'n1', relation: '朋友', evidence: quote(2), strength: 4, charStart: chunk0.indexOf(quote(2)), repaired: false },
        ],
        // the fabricated edge was already dropped by the per-chunk gate, which is why only two
        // edges arrive here but the chunk reports one drop
        stats: { dropped: 1, droppedReasons: [{ reason: 'evidence-not-in-source', count: 1 }] },
      },
    },
    {
      chunk: chunks[1],
      parsed: { modelNodeCount: 3, modelEdgeCount: 3 },
      bound: {
        nodes: [
          { id: 'n1', name: '晚娘', aliases: ['苏晚'] },
          { id: 'n2', name: '沈砚', aliases: [] },
          { id: 'n3', name: '三姑娘', aliases: [] },
        ],
        edges: [
          // same sentence as chunk 0: must be recognised as a duplicate, not a second beat
          { source: 'n1', target: 'n2', relation: '朋友', evidence: quote(2), strength: 4, charStart: chunk1.indexOf(quote(2)), repaired: false },
          { source: 'n1', target: 'n2', relation: '朋友', evidence: quote(4), strength: 4, charStart: chunk1.indexOf(quote(4)), repaired: false },
          { source: 'n3', target: 'n2', relation: '同僚', evidence: quote(3), strength: 2, charStart: chunk1.indexOf(quote(3)), repaired: false },
        ],
        stats: { dropped: 0, droppedReasons: [] },
      },
    },
  ]

  const merged = mergeChunkGraphs({ text, chunks, results })

  const su = merged.nodes.find((node) => node.name === '苏晚')
  assert.ok(su, 'the canonical name is the one the text uses most')
  assert.equal(merged.nodes.length, 2, '苏晚 / 晚娘 / 三姑娘 collapse into one person')
  assert.deepEqual([...su.aliases].sort(), ['三姑娘', '晚娘'], 'both aliases survive on the merged node')
  assert.equal(merged.stats.aliasMerges, 4, 'four duplicate node instances were merged away')
  assert.ok(merged.stats.aliasDeclarations >= 1, 'the 人称 declaration also linked 晚娘 and 三姑娘')

  const edgeKeys = merged.edges.map((edge) => `${edge.source}|${edge.target}|${edge.evidence}`)
  assert.equal(new Set(edgeKeys).size, edgeKeys.length, 'no duplicated evidence survives the merge')
  assert.equal(merged.edges.length, 4, 'four distinct narrative beats between the merged people')
  assert.equal(merged.stats.duplicateEvidence, 1, 'the overlap duplicate is counted, not hidden')
  assert.equal(merged.stats.dropped, 2, 'the fabricated edge and the duplicate are both counted')

  for (const edge of merged.edges) {
    assert.equal(text.slice(edge.charStart, edge.charStart + edge.evidence.length), edge.evidence, 'merged offsets point back into the full text')
  }
  const firstBeat = merged.edges.find((edge) => edge.evidence === quote(0))
  assert.equal(firstBeat.charStart, at(0), 'the first beat keeps its position in the whole text')
  const sorted = merged.edges.map((edge) => edge.charStart)
  assert.deepEqual(sorted, [...sorted].sort((a, b) => a - b), 'edges stay in narrative order')
  assert.ok(merged.stats.evidencePassRate < 1 && merged.stats.evidencePassRate > 0, 'pass rate reflects the dropped edge')
}

// ── retrieval planning: only blocks with two characters are worth a call ───────────────────
{
  const chunks = [
    { index: 0, start: 0, end: 40, text: '苏晚把药碗递给沈砚，说，趁热喝。' },
    { index: 1, start: 40, end: 80, text: '苏晚独自在后院晒药，晒到日落。' },
    { index: 2, start: 80, end: 120, text: '沈砚与柳氏在后堂对账，对到深夜。' },
    { index: 3, start: 120, end: 160, text: '柳氏吹了灯，整条巷子都黑了。' },
  ]
  const clusters = [
    { name: '苏晚', keys: ['苏晚'] },
    { name: '沈砚', keys: ['沈砚'] },
    { name: '柳氏', keys: ['柳氏'] },
  ]
  const mentions = indexChunkMentions(chunks, clusters)
  assert.deepEqual([...mentions[0]], [0, 1], '苏晚 is found in the two blocks that mention her')

  const plan = buildRetrievalPlan({ chunks, clusters })
  assert.equal(plan.candidateCount, 2, 'only the two blocks with a pair become candidates')
  assert.equal(plan.pairs.length, 2, 'two co-occurring pairs are ranked')
  assert.deepEqual(
    plan.skippedByReason.find((item) => item.reason === 'too-few-characters').count,
    2,
    'single-character blocks are skipped with a reason',
  )

  const budgeted = buildRetrievalPlan({ chunks, clusters, options: { maxBlocks: 1 } })
  assert.equal(budgeted.selectedIndexes.size, 1, 'a budget of one block is respected')
  assert.equal(budgeted.skippedByReason.find((item) => item.reason === 'over-budget').count, 1, 'the block that lost the budget is reported')

  const passages = retrievePassages({
    text: chunks.map((chunk) => chunk.text).join(''),
    chunks,
    leftKeys: ['苏晚'],
    rightKeys: ['沈砚'],
  })
  assert.ok(passages.length >= 1, 'a pair that appears together yields a passage')
  assert.equal(passages[0].source, 'retrieval', 'a passage is labelled as retrieval, not as a relation')
  for (const passage of passages) {
    assert.ok(chunks.map((chunk) => chunk.text).join('').includes(passage.snippet), 'passages are verbatim slices')
  }
}

{
  assert.deepEqual(pickSamples(10, 3), [0, 5, 9], 'cast samples include the first and last block')
  assert.deepEqual(pickSamples(4, 12), [0, 1, 2, 3], 'never samples more blocks than exist')

  const clusters = clusterCast([
    [{ name: '苏晚', aliases: ['晚娘'] }, { name: '沈砚', aliases: [] }],
    [{ name: '晚娘', aliases: ['三姑娘'] }, { name: '沈砚', aliases: [] }],
  ])
  assert.equal(clusters.length, 2, 'the same person sampled twice becomes one cluster')
  assert.ok(clusters[0].keys.includes('三姑娘'), 'aliases are transitive across samples')
}

// ── pipeline: chunk mode, the evidence gate, and resume ─────────────────────────────────────
const NAMES = ['苏晚', '沈砚', '柳氏', '阿竹']
const SENTENCE =
  '苏晚把药碗递给沈砚，说，趁热喝，凉了伤胃。沈砚没接碗，只说，放着吧。柳氏在后堂算账，阿竹把灯挑亮了一些。'

function buildLongText(repeat = 220) {
  const parts = []
  for (let i = 0; i < repeat; i += 1) parts.push(`${SENTENCE}（第${i + 1}段）`)
  return parts.join('\n\n')
}

function makeStub({ failChunk = null, fabricatedPerChunk = 1 } = {}) {
  const calls = []
  const counts = new Map()

  const model = async ({ system, user, label }) => {
    calls.push(label ?? '?')
    if (system.includes('角色名扫描器')) {
      return {
        text: JSON.stringify({ cast: [{ name: '苏晚', aliases: ['晚娘'] }, { name: '沈砚', aliases: [] }, { name: '柳氏', aliases: [] }] }),
        usage: { prompt: 100, completion: 20, cacheHit: 0 },
        seconds: 0.01,
      }
    }

    const text = /<<<TEXT\n([\s\S]*?)\nTEXT>>>/.exec(user)?.[1] ?? ''
    const chunkIndex = Number(/第 (\d+)\/(\d+) 段/.exec(user)?.[1] ?? 0) - 1
    const count = (counts.get(chunkIndex) ?? 0) + 1
    counts.set(chunkIndex, count)

    if (failChunk !== null && chunkIndex === failChunk && count === 1) {
      throw new Error(`stub failure for chunk ${chunkIndex}`)
    }

    const present = NAMES.filter((name) => text.includes(name))
    if (present.length === 0) throw new Error('stub needs at least one character in the chunk')

    const nodes = present.map((name, index) => ({
      id: `n${index + 1}`,
      name,
      aliases: name === '苏晚' ? ['晚娘'] : [],
    }))
    const edges = []
    if (nodes.length >= 2) {
      const evidence = text.slice(0, 30)
      edges.push({
        source: nodes[0].id,
        target: nodes[1].id,
        relation: '师徒',
        evidence,
        strength: 4,
      })
    }
    for (let i = 0; i < fabricatedPerChunk; i += 1) {
      edges.push({
        source: nodes[0].id,
        target: nodes[nodes.length - 1].id,
        relation: '敌对',
        evidence: `不存在的原文片段${i}，这句话并不在文本里。`,
        strength: 2,
      })
    }

    return {
      text: JSON.stringify({ nodes, edges }),
      usage: { prompt: 3800, completion: 400, cacheHit: 0 },
      seconds: 0.01,
    }
  }

  return { model, calls }
}

const workDir = await mkdtemp(join(tmpdir(), 'cg-pipeline-'))
try {
  const text = buildLongText()
  assert.ok(text.length > 9000, 'the integration text is longer than one single-pass call')

  const store = createRunStore(join(workDir, 'run'))
  await store.ensure()
  const stub = makeStub()
  const first = await runExtraction({
    text,
    callModel: stub.model,
    store,
    options: { mode: 'chunk', model: 'stub', concurrency: 3 },
  })

  assert.ok(first.stats.chunks >= 3, 'the text was split into several chunks')
  assert.equal(first.stats.chunksExtracted, first.stats.chunks, 'every chunk was extracted')
  assert.equal(first.stats.chunksFailed, 0, 'no chunk failed')
  assert.ok(first.stats.dropped >= first.stats.chunks, 'each fabricated edge is counted as dropped')
  for (const edge of first.edges) {
    assert.equal(text.slice(edge.charStart, edge.charStart + edge.evidence.length), edge.evidence, 'every surviving edge quotes the source exactly')
  }
  assert.ok(first.stats.tokens.prompt > 0 && first.stats.costUsd > 0, 'cost accounting is populated')
  const savedChunks = await store.readChunks()
  assert.equal(savedChunks.length, first.stats.chunks, 'chunk boundaries are on disk')

  // Resume: a second run with the same store must not call the model at all.
  const resumeStub = makeStub()
  const second = await runExtraction({
    text,
    callModel: resumeStub.model,
    store,
    options: { mode: 'chunk', model: 'stub', concurrency: 3 },
  })
  assert.equal(resumeStub.calls.length, 0, 'a complete run directory is reused without model calls')
  assert.equal(second.stats.chunksReused, first.stats.chunks, 'every chunk is reported as reused')
  assert.equal(second.nodes.length, first.nodes.length, 'the resumed graph is the same graph')
  assert.equal(second.edges.length, first.edges.length)

  // Failure + resume: the failed chunk is retried, the finished ones are not.
  const failingStore = createRunStore(join(workDir, 'run-fail'))
  await failingStore.ensure()
  const failingStub = makeStub({ failChunk: 1, fabricatedPerChunk: 0 })
  const partial = await runExtraction({
    text,
    callModel: failingStub.model,
    store: failingStore,
    options: { mode: 'chunk', model: 'stub', concurrency: 1 },
  })
  assert.equal(partial.stats.chunksFailed, 1, 'the failing chunk is counted, not hidden')
  assert.equal(partial.stats.chunksExtracted, partial.stats.chunks - 1, 'the other chunks still produced a graph')
  const failures = await failingStore.readFailures()
  assert.equal(failures.length, 1, 'the failure is written to disk so it can be retried')

  const retryStub = makeStub({ fabricatedPerChunk: 0 })
  const retried = await runExtraction({
    text,
    callModel: retryStub.model,
    store: failingStore,
    options: { mode: 'chunk', model: 'stub', concurrency: 1 },
  })
  assert.equal(retryStub.calls.length, 1, 'resume retries exactly the missing chunk')
  assert.equal(retried.stats.chunksFailed, 0, 'after resume nothing is missing')
  assert.equal(retried.stats.chunksReused, partial.stats.chunks - 1, 'the finished chunks were reused')

  // RAG: the plan is produced from a cheap cast scan, and a budget is enforced.
  const ragStore = createRunStore(join(workDir, 'run-rag'))
  await ragStore.ensure()
  const ragStub = makeStub({ fabricatedPerChunk: 0 })
  const rag = await runExtraction({
    text,
    callModel: ragStub.model,
    store: ragStore,
    options: {
      mode: 'rag',
      model: 'stub',
      concurrency: 2,
      rag: { castSampleBlocks: 3, maxBlocks: 1, minCooccurrence: 1 },
    },
  })
  assert.equal(rag.stats.rag.enabled, true, 'RAG mode reports its plan')
  assert.equal(rag.stats.rag.selectedBlocks, 1, 'the block budget is enforced')
  assert.ok(rag.stats.rag.skippedBlocks >= 1, 'skipped blocks are counted')
  assert.ok(rag.stats.rag.castSize >= 2, 'the cast scan found characters')
  assert.ok(ragStub.calls.filter((label) => label.startsWith('cast')).length <= 3, 'only sampled blocks are scanned')
  const plan = await ragStore.readPlan()
  assert.ok(plan.pairs.length >= 1, 'the plan lists candidate pairs on disk')

  // Plan-only: the index + retrieval half runs without a single extraction call.
  const planStore = createRunStore(join(workDir, 'run-plan'))
  await planStore.ensure()
  const planStub = makeStub({ fabricatedPerChunk: 0 })
  const planOnly = await runExtraction({
    text,
    callModel: planStub.model,
    store: planStore,
    options: {
      mode: 'rag',
      model: 'stub',
      planOnly: true,
      rag: { castSampleBlocks: 2 },
      cast: [{ name: '苏晚', aliases: [] }, { name: '沈砚', aliases: [] }, { name: '柳氏', aliases: [] }],
    },
  })
  assert.equal(planOnly.planOnly, true, 'plan-only runs are labelled')
  assert.equal(planStub.calls.length, 0, 'a provided cast means no model call at all')
  assert.ok(planOnly.index.docs === planOnly.stats.chunks, 'the lexical index covers every chunk')
  assert.ok(planOnly.plan.selectedBlocks.length > 0, 'the plan selects blocks')
} finally {
  await rm(workDir, { recursive: true, force: true })
}

console.log('pipeline ok')
