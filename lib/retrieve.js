/**
 * Retrieval: which blocks are worth an expensive extraction call, and where two people actually
 * appear together in the text.
 *
 * The design constraint from the provider side is that there is no embedding endpoint, so this is a
 * lexical retriever built on character bigrams (see lib/bm25.js) plus exact name matching. For a
 * character graph that is the right tool: the query is always a name or a pair of names, and a name
 * is a short, exactly-spelled string.
 *
 * Two distinct jobs live here:
 *   - planning: given the cast found by the cheap scan, rank character pairs by how often they
 *     co-occur and decide which blocks get a full extraction call (with a budget, if given);
 *   - pair retrieval: for "these two characters", return the verbatim passages where they appear
 *     together — this is what the viewer shows when there is no verified edge, and it is also what
 *     makes the RAG claim checkable rather than decorative.
 */

import { buildIndex, search } from './bm25.js'

export function pairKeyOf(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * Fold per-sample cast scans into global clusters.
 *
 * Samples are independent slices of the book, so the same person arrives several times with
 * different aliases. Clusters are joined by any shared name/alias key (transitive), and the label
 * with the most sample support becomes the display name.
 *
 * @param {{name: string, aliases?: string[]}[][]} samples one array per scanned block
 * @returns {{name: string, keys: string[], samples: number}[]}
 */
export function clusterCast(samples) {
  const entries = []
  for (const sample of samples) {
    for (const item of sample ?? []) {
      const keys = [item.name, ...(item.aliases ?? [])].filter(Boolean)
      if (keys.length === 0) continue
      entries.push({ keys, name: item.name })
    }
  }

  const parent = entries.map((_, index) => index)
  const find = (index) => {
    let root = index
    while (parent[root] !== root) {
      parent[root] = parent[parent[root]]
      root = parent[root]
    }
    return root
  }
  const union = (a, b) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent[rootB] = rootA
  }

  const byKey = new Map()
  entries.forEach((entry, index) => {
    for (const key of entry.keys) {
      if (byKey.has(key)) union(byKey.get(key), index)
      else byKey.set(key, index)
    }
  })

  const clusters = new Map()
  entries.forEach((entry, index) => {
    const root = find(index)
    let cluster = clusters.get(root)
    if (!cluster) {
      cluster = { keys: new Set(), votes: new Map(), samples: 0 }
      clusters.set(root, cluster)
    }
    cluster.samples += 1
    for (const key of entry.keys) {
      cluster.keys.add(key)
      cluster.votes.set(key, (cluster.votes.get(key) ?? 0) + 1)
    }
  })

  const out = []
  for (const cluster of clusters.values()) {
    const keys = [...cluster.keys]
    keys.sort((a, b) => (cluster.votes.get(b) ?? 0) - (cluster.votes.get(a) ?? 0) || b.length - a.length || a.localeCompare(b, 'zh'))
    out.push({ name: keys[0], keys, samples: cluster.samples })
  }
  out.sort((a, b) => b.samples - a.samples || b.keys.length - a.keys.length || a.name.localeCompare(b.name, 'zh'))
  return out
}

/** Which chunks mention each cluster. Exact substring matching — a name is not a fuzzy thing. */
export function indexChunkMentions(chunks, clusters) {
  const mentions = clusters.map(() => new Set())
  for (const chunk of chunks) {
    const body = chunk.text ?? ''
    clusters.forEach((cluster, index) => {
      for (const key of cluster.keys) {
        if (key.length >= 2 && body.includes(key)) {
          mentions[index].add(chunk.index)
          break
        }
      }
    })
  }
  return mentions
}

/**
 * Character pairs that actually co-occur, ranked.
 *
 * `minCooccurrence` is the honest knob: a pair that shares exactly one block on a 600k-character
 * book is more likely to be a walk-on mention than a relationship, so a long run does not spend a
 * call on it. Small texts keep the threshold at 1 so nothing is excluded arbitrarily.
 */
export function rankPairs({ chunks, clusters, mentions, options = {} }) {
  const minCooccurrence = options.minCooccurrence ?? 1
  const maxPairs = options.maxPairs ?? 120
  const pairs = []

  for (let i = 0; i < clusters.length; i += 1) {
    const blocksA = mentions[i]
    if (blocksA.size === 0) continue
    for (let j = i + 1; j < clusters.length; j += 1) {
      const blocksB = mentions[j]
      if (blocksB.size === 0) continue
      const shared = []
      for (const blockIndex of blocksA) if (blocksB.has(blockIndex)) shared.push(blockIndex)
      if (shared.length < minCooccurrence) continue
      pairs.push({
        a: clusters[i].name,
        b: clusters[j].name,
        aKeys: clusters[i].keys,
        bKeys: clusters[j].keys,
        blocks: shared.sort((x, y) => x - y),
        cooccurrence: shared.length,
        coverage: shared.length / Math.max(1, Math.min(blocksA.size, blocksB.size)),
      })
    }
  }

  pairs.sort(
    (p, q) => q.cooccurrence - p.cooccurrence || q.coverage - p.coverage || p.a.localeCompare(q.a, 'zh'),
  )
  return pairs.slice(0, maxPairs)
}

/**
 * Choose which blocks get the expensive fine-extraction call.
 *
 * Candidates are blocks that mention at least two distinct characters — a block with one name
 * cannot contain a relation between two people, so calling the model there is pure waste. Beyond
 * that, blocks are ranked by how many *selected* pairs they can serve, so a tight budget is spent
 * on the blocks that carry the most of the graph.
 */
export function buildRetrievalPlan({ chunks, clusters, options = {} }) {
  const mentions = indexChunkMentions(chunks, clusters)
  const pairs = rankPairs({ chunks, clusters, mentions, options })
  const maxBlocks = options.maxBlocks ?? Number.POSITIVE_INFINITY

  const blocksByPair = new Map()
  for (const pair of pairs) {
    const key = pairKeyOf(pair.a, pair.b)
    blocksByPair.set(key, new Set(pair.blocks))
  }

  const candidateBlocks = []
  const skippedBlocks = []
  for (const chunk of chunks) {
    let distinct = 0
    for (let i = 0; i < clusters.length; i += 1) if (mentions[i].has(chunk.index)) distinct += 1
    if (distinct < 2) {
      skippedBlocks.push({ chunkIndex: chunk.index, reason: 'too-few-characters', distinct })
      continue
    }
    const focusPairs = []
    let weight = 0
    for (const pair of pairs) {
      if (!pair.blocks.includes(chunk.index)) continue
      focusPairs.push([pair.a, pair.b])
      weight += Math.log(1 + pair.cooccurrence)
      if (focusPairs.length >= 6) break
    }
    if (focusPairs.length === 0) {
      skippedBlocks.push({ chunkIndex: chunk.index, reason: 'no-selected-pair', distinct })
      continue
    }
    candidateBlocks.push({ chunkIndex: chunk.index, distinct, focusPairs, weight })
  }

  candidateBlocks.sort((a, b) => b.weight - a.weight || b.distinct - a.distinct || a.chunkIndex - b.chunkIndex)
  const selected = candidateBlocks.slice(0, maxBlocks)
  for (const block of candidateBlocks.slice(maxBlocks)) {
    skippedBlocks.push({ chunkIndex: block.chunkIndex, reason: 'over-budget', distinct: block.distinct })
  }

  const selectedIndexes = new Set(selected.map((block) => block.chunkIndex))
  const reasons = new Map()
  for (const skipped of skippedBlocks) reasons.set(skipped.reason, (reasons.get(skipped.reason) ?? 0) + 1)

  return {
    pairs,
    selected,
    selectedIndexes,
    skippedBlocks,
    skippedByReason: [...reasons.entries()].map(([reason, count]) => ({ reason, count })),
    candidateCount: candidateBlocks.length,
    clusters,
    mentions,
  }
}

/**
 * Verbatim passages where two characters appear close together.
 *
 * This is retrieval, not extraction: nothing here claims the two are related, and every snippet is
 * a slice of the source text, so it can be compared with the evidence list instead of being trusted.
 */
export function retrievePassages({
  text,
  chunks,
  leftKeys,
  rightKeys,
  limit = 8,
  perChunk = 1,
  windowChars = 300,
  contextChars = 90,
}) {
  const passages = []
  const left = (leftKeys ?? []).filter((key) => key && key.length >= 2)
  const right = (rightKeys ?? []).filter((key) => key && key.length >= 2)
  if (left.length === 0 || right.length === 0) return passages

  for (const chunk of chunks) {
    if (passages.length >= limit) break
    let taken = 0
    const body = chunk.text ?? text.slice(chunk.start, chunk.end)
    const leftHits = []
    const rightHits = []
    for (const key of left) {
      let from = 0
      for (;;) {
        const at = body.indexOf(key, from)
        if (at < 0) break
        leftHits.push(at)
        from = at + key.length
      }
    }
    for (const key of right) {
      let from = 0
      for (;;) {
        const at = body.indexOf(key, from)
        if (at < 0) break
        rightHits.push(at)
        from = at + key.length
      }
    }
    if (leftHits.length === 0 || rightHits.length === 0) continue

    const windows = []
    for (const a of leftHits) {
      for (const b of rightHits) {
        if (Math.abs(a - b) <= windowChars) windows.push({ at: Math.min(a, b), distance: Math.abs(a - b) })
      }
    }
    if (windows.length === 0) continue
    windows.sort((x, y) => x.at - y.at)

    const used = []
    for (const window of windows) {
      if (taken >= perChunk) break
      const from = Math.max(0, window.at - contextChars)
      const to = Math.min(body.length, window.at + windowChars + contextChars)
      if (used.some((range) => from < range.to && to > range.from)) continue
      used.push({ from, to })
      taken += 1
      passages.push({
        chunkIndex: chunk.index,
        charStart: chunk.start + from,
        charEnd: chunk.start + to,
        distance: window.distance,
        snippet: text.slice(chunk.start + from, chunk.start + to),
        source: 'retrieval',
      })
      if (passages.length >= limit) return passages
    }
  }

  return passages
}

/** BM25 over chunks, used when the query is free text rather than a pair of names. */
export function searchChunks(chunks, query, options = {}) {
  const index = options.index ?? buildIndex(chunks.map((chunk) => ({ id: chunk.index, text: chunk.text ?? '' })))
  return search(index, query, { limit: options.limit ?? 8 }).map((hit) => ({
    chunkIndex: Number(hit.id),
    score: hit.score,
  }))
}

/** Global text offset → the chunk that contains it (used to deep-link a passage). */
export function chunkAtOffset(chunks, offset) {
  for (const chunk of chunks) {
    if (offset >= chunk.start && offset < chunk.end) return chunk
  }
  return chunks[chunks.length - 1] ?? null
}
