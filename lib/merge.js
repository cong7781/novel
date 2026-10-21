/**
 * Global merge: chunk-local graphs → one graph over the whole text.
 *
 * Three things have to happen here, and all of them are pure functions of the per-chunk results:
 *
 *   1. entity resolution — the same person is called 苏晚 / 晚娘 / 三姑娘 in different scenes, and
 *      each chunk names them independently. Nodes are clustered by shared names/aliases claimed by
 *      the model plus alias declarations mined from the text itself ("晚娘，人称三姑娘").
 *   2. evidence merge — overlapping windows quote the same sentence twice; the same pair must end
 *      up with distinct narrative beats, not duplicates.
 *   3. honest accounting — every edge the model proposed either survives with a verbatim quote or
 *      is counted in `dropped` with a reason. Nothing is silently discarded.
 *
 * Merging is deliberately conservative: a wrong merge invents a person, so an unproven alias stays
 * two people and is reported as a *suspect* instead of being flattened.
 */

const HONORIFICS = ['姑娘', '娘子', '夫人', '掌柜', '少爷', '公子', '小姐', '大爷', '大叔', '大娘', '婶子', '嫂子', '大哥', '大姐']

/** Names compete for the canonical label; the one the text uses most wins. */
export function countNameOccurrences(text, phrase) {
  if (!phrase) return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = text.indexOf(phrase, from)
    if (at < 0) return count
    count += 1
    from = at + phrase.length
  }
}

export function normalizeKey(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[「」『』“”"'‘’《》〈〉()（）\[\]【】\s、，,。.！!？?：:；;·—\-]/g, '')
    .trim()
}

/**
 * Mine explicit alias declarations from the raw text: "晚娘，人称三姑娘", "苏晚又叫三姑娘".
 * Only pairs whose *both* sides are already known cast names are kept, so the pattern cannot
 * invent a person; it can only link two known ones.
 */
export function mineAliasDeclarations(text, knownKeys) {
  const known = knownKeys instanceof Set ? knownKeys : new Set(knownKeys ?? [])
  const pattern =
    /([\u4e00-\u9fff]{2,4})(?:，|,)?(?:人称|又叫|又名|也叫|小名是|小名叫|小名|外号|俗称|唤作|唤做|称作|也就是|即是)(?:为|作|做)?([\u4e00-\u9fff]{2,4})/g
  const found = []
  const seen = new Set()
  let match
  while ((match = pattern.exec(text)) !== null) {
    const left = normalizeKey(match[1])
    const right = normalizeKey(match[2])
    if (left === '' || right === '' || left === right) continue
    if (known.size > 0 && !(known.has(left) && known.has(right))) continue
    const key = left < right ? `${left}|${right}` : `${right}|${left}`
    if (seen.has(key)) continue
    seen.add(key)
    const at = Math.max(0, match.index - 12)
    found.push({
      a: left,
      b: right,
      at: match.index,
      evidence: text.slice(at, Math.min(text.length, match.index + match[0].length + 12)),
    })
  }
  return found
}

/** Trailing honorific removed, e.g. 「林姑娘」→「林」 — only used when the stem is still ≥ 2 chars. */
function honorificStem(key) {
  for (const honorific of HONORIFICS) {
    if (key.length > honorific.length + 1 && key.endsWith(honorific)) {
      return key.slice(0, -honorific.length)
    }
  }
  return key
}

class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index)
    this.rank = new Uint8Array(size)
  }

  find(index) {
    let root = index
    while (this.parent[root] !== root) {
      this.parent[root] = this.parent[this.parent[root]]
      root = this.parent[root]
    }
    return root
  }

  union(a, b) {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA === rootB) return false
    if (this.rank[rootA] < this.rank[rootB]) this.parent[rootA] = rootB
    else if (this.rank[rootA] > this.rank[rootB]) this.parent[rootB] = rootA
    else {
      this.parent[rootB] = rootA
      this.rank[rootA] += 1
    }
    return true
  }
}

/**
 * Merge per-chunk extraction results.
 *
 * @param {{
 *   text: string,
 *   chunks: {index: number, start: number, end: number}[],
 *   results: {chunk: {index: number, start: number}, parsed: any, bound: any, usage?: any, seconds?: number}[],
 *   options?: {maxEvidencesPerPair?: number, pairCapReason?: string}
 * }} input
 */
export function mergeChunkGraphs({ text, chunks, results, options = {} }) {
  const maxEvidencesPerPair = options.maxEvidencesPerPair ?? 6
  const instances = []

  for (const result of results) {
    const chunk = result.chunk
    for (const node of result.bound?.nodes ?? result.parsed?.nodes ?? []) {
      const keys = new Set()
      const nameKey = normalizeKey(node.name)
      if (nameKey !== '') keys.add(nameKey)
      for (const alias of node.aliases ?? []) {
        const aliasKey = normalizeKey(alias)
        if (aliasKey !== '' && aliasKey !== nameKey) keys.add(aliasKey)
      }
      instances.push({
        chunkIndex: chunk.index,
        chunkStart: chunk.start,
        localId: node.id,
        name: node.name,
        nameKey,
        keys,
      })
    }
  }

  const uf = new UnionFind(instances.length)
  const byKey = new Map()
  // A character's canonical name inside one chunk is hard evidence that two *distinct* people are
  // present. If the model elsewhere claims that name as somebody's alias, the co-presence wins:
  // merging father and son because a chunk called one of them 「老爷」 would be worse than leaving
  /**
   * Two names that ever appear as *separate nodes in the same chunk* are different people. This is
   * the only reliable dataset-wide signal against the classic Chinese alias trap: 沈砚's chunk may
   * call him 「沈掌柜」 and 沈鹤年's chunk calls *him* 「沈掌柜」 too, so a shared alias key alone would
   * collapse father and son. Co-presence is direct evidence to the contrary, so it wins.
   */
  const coPresent = new Set()
  const namesByChunk = new Map()
  for (const instance of instances) {
    if (instance.nameKey === '') continue
    if (!namesByChunk.has(instance.chunkIndex)) namesByChunk.set(instance.chunkIndex, new Set())
    namesByChunk.get(instance.chunkIndex).add(instance.nameKey)
  }
  for (const names of namesByChunk.values()) {
    const list = [...names]
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        coPresent.add(list[i] < list[j] ? `${list[i]}|${list[j]}` : `${list[j]}|${list[i]}`)
      }
    }
  }
  const conflicts = (a, b) => a !== b && coPresent.has(a < b ? `${a}|${b}` : `${b}|${a}`)

  let refusedMerges = 0
  for (const instance of instances) instance.refused = new Set()

  // Pass 1 — the same canonical name in different chunks is the same person, always.
  const firstByName = new Map()
  instances.forEach((instance, index) => {
    if (instance.nameKey === '') return
    const first = firstByName.get(instance.nameKey)
    if (first === undefined) {
      firstByName.set(instance.nameKey, index)
      byKey.set(instance.nameKey, index)
      return
    }
    uf.union(first, index)
  })

  // Pass 2 — aliases are only trusted while they never contradict co-presence. A name owner always
  // owns its own name here, so an alias claim can never steal somebody else's identity.
  instances.forEach((instance, index) => {
    for (const key of instance.keys) {
      if (key === instance.nameKey) continue
      const ownerIndex = byKey.get(key)
      if (ownerIndex === undefined) {
        byKey.set(key, index)
        continue
      }
      const owner = instances[ownerIndex]
      const contradicts =
        conflicts(instance.nameKey, owner.nameKey) ||
        conflicts(instance.nameKey, key) ||
        conflicts(owner.nameKey, key)
      if (contradicts) {
        refusedMerges += 1
        instance.refused.add(key)
        continue
      }
      uf.union(ownerIndex, index)
    }
  })

  // A key claimed by two people who are known to be different is a title («沈掌柜»), not an alias:
  // it may still be shown on the chunk that used it, but merging on it or listing it as a person's
  // other name would be wrong. Such keys are tracked and reported instead.
  const claimers = new Map()
  instances.forEach((instance) => {
    for (const key of instance.keys) {
      if (!claimers.has(key)) claimers.set(key, new Set())
      claimers.get(key).add(instance.nameKey)
    }
  })
  const contested = new Set()
  for (const [key, names] of claimers) {
    const list = [...names]
    outer: for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (conflicts(list[i], list[j])) {
          contested.add(key)
          break outer
        }
      }
    }
  }

  // Alias declarations found in the text itself link two keys without another model call.
  const allKeys = new Set(byKey.keys())
  const declarations = mineAliasDeclarations(text, allKeys)
  const declaredPairs = []
  for (const declaration of declarations) {
    const a = byKey.get(declaration.a)
    const b = byKey.get(declaration.b)
    if (a === undefined || b === undefined) continue
    if (uf.union(a, b)) declaredPairs.push(declaration)
  }

  // Honorific stems: 「林姑娘」 and 「林」 are the same person; only merges when the stem survives and
  // the two labels never appear as separate people in one chunk.
  const byStem = new Map()
  allKeys.forEach((key) => {
    const stem = honorificStem(key)
    if (stem !== key && stem.length >= 2 && allKeys.has(stem) && !conflicts(key, stem)) {
      const a = byKey.get(key)
      const b = byKey.get(stem)
      if (a !== undefined && b !== undefined) {
        if (!byStem.has(stem)) byStem.set(stem, [])
        byStem.get(stem).push([a, b])
      }
    }
  })
  let honorificMerges = 0
  for (const pairs of byStem.values()) {
    for (const [a, b] of pairs) if (uf.union(a, b)) honorificMerges += 1
  }

  // Cluster → canonical name, decided by how often the full text uses each candidate label.
  const clusters = new Map()
  instances.forEach((instance, index) => {
    const root = uf.find(index)
    let cluster = clusters.get(root)
    if (!cluster) {
      cluster = { root, members: [], keys: new Set(), nameVotes: new Map() }
      clusters.set(root, cluster)
    }
    cluster.members.push(instance)
    if (instance.nameKey !== '') cluster.nameVotes.set(instance.nameKey, (cluster.nameVotes.get(instance.nameKey) ?? 0) + 1)
    for (const key of instance.keys) {
      // A refused alias never reaches the cluster: it belongs to somebody else's name.
      if (instance.refused?.has(key)) continue
      if (contested.has(key) && key !== instance.nameKey) continue
      cluster.keys.add(key)
      cluster.nameVotes.set(key, (cluster.nameVotes.get(key) ?? 0) + 1)
    }
  })

  const occurrenceCache = new Map()
  const occurrences = (key) => {
    if (!occurrenceCache.has(key)) occurrenceCache.set(key, countNameOccurrences(text, key))
    return occurrenceCache.get(key)
  }

  const ordered = []
  for (const cluster of clusters.values()) {
    let canonical = ''
    let canonicalScore = -1
    for (const key of cluster.keys) {
      const score = occurrences(key) * 1000 + key.length
      if (score > canonicalScore) {
        canonicalScore = score
        canonical = key
      }
    }
    if (canonical === '') canonical = cluster.members[0]?.nameKey ?? ''
    if (canonical === '') continue

    // 「知州」 is a title that happens to be very frequent, and it is a suffix of the full name
    // 「陆知州」. When the fuller form is a real name in the text (not a nickname prefix like 老/小/阿),
    // use it: a character graph should show 陆知州, not his office.
    const fuller = [...cluster.keys].find(
      (key) =>
        key !== canonical &&
        key.length > canonical.length &&
        key.endsWith(canonical) &&
        !/^[老少阿]$/.test(key.slice(0, key.length - canonical.length)) &&
        occurrences(key) >= Math.max(3, occurrences(canonical) * 0.05),
    )
    if (fuller) canonical = fuller

    const aliases = [...cluster.keys].filter((key) => key !== canonical).sort()
    ordered.push({
      cluster,
      canonical,
      aliases,
      occurrences: occurrences(canonical),
      firstAt: Math.min(...cluster.members.map((member) => member.chunkStart)),
    })
  }

  // Main characters first: the most-mentioned name is the one a reader expects to see at the centre,
  // and a stable order keeps deep links (?pair=n1,n2) meaningful across reruns of the same text.
  ordered.sort(
    (a, b) =>
      b.occurrences - a.occurrences ||
      b.cluster.members.length - a.cluster.members.length ||
      a.canonical.localeCompare(b.canonical, 'zh'),
  )

  const nodeIdByRoot = new Map()
  const nodes = ordered.map((entry, index) => {
    const id = `n${index + 1}`
    nodeIdByRoot.set(entry.cluster.root, id)
    return {
      id,
      name: entry.canonical,
      aliases: entry.aliases,
      mentions: entry.occurrences,
    }
  })

  const chunkIdByIndex = new Map(chunks.map((chunk, index) => [chunk.index, { chunk, index }]))
  const instanceIndex = new Map()
  instances.forEach((instance, index) => {
    instanceIndex.set(`${instance.chunkIndex}:${instance.localId}`, { instance, index })
  })
  const kept = []
  const dropped = []
  const seen = new Map()

  for (const result of results) {
    const chunk = result.chunk
    for (const edge of result.bound?.edges ?? []) {
      const sourceInstance = instanceIndex.get(`${chunk.index}:${edge.source}`)
      const targetInstance = instanceIndex.get(`${chunk.index}:${edge.target}`)
      if (!sourceInstance || !targetInstance) {
        dropped.push({ reason: 'node-unmapped', edge })
        continue
      }
      const sourceId = nodeIdByRoot.get(uf.find(sourceInstance.index))
      const targetId = nodeIdByRoot.get(uf.find(targetInstance.index))
      if (!sourceId || !targetId) {
        dropped.push({ reason: 'node-unmapped', edge })
        continue
      }
      if (sourceId === targetId) {
        dropped.push({ reason: 'self-after-merge', edge })
        continue
      }

      const pairKey = sourceId < targetId ? `${sourceId}|${targetId}` : `${targetId}|${sourceId}`
      const globalStart = chunk.start + (edge.charStart ?? 0)
      const quoteKey = edge.evidence.replace(/\s+/g, '')
      const bucket = seen.get(pairKey) ?? { spans: [], quotes: new Set() }
      if (bucket.quotes.has(quoteKey)) {
        dropped.push({ reason: 'duplicate-evidence', edge })
        continue
      }
      const overlapping = bucket.spans.some((span) => {
        const overlap = Math.min(span.end, globalStart + edge.evidence.length) - Math.max(span.start, globalStart)
        return overlap > 0 && overlap / Math.max(1, Math.min(span.length, edge.evidence.length)) >= 0.6
      })
      if (overlapping) {
        dropped.push({ reason: 'duplicate-evidence', edge })
        continue
      }
      if (bucket.spans.length >= maxEvidencesPerPair) {
        dropped.push({ reason: 'pair-cap', edge })
        continue
      }

      bucket.spans.push({ start: globalStart, end: globalStart + edge.evidence.length, length: edge.evidence.length })
      bucket.quotes.add(quoteKey)
      seen.set(pairKey, bucket)

      const position = chunkIdByIndex.get(chunk.index)
      kept.push({
        source: sourceId,
        target: targetId,
        relation: edge.relation,
        evidence: edge.evidence,
        strength: edge.strength,
        charStart: globalStart,
        repaired: Boolean(edge.repaired),
        chunk: position ? position.index : chunk.index,
      })
    }
  }

  kept.sort((a, b) => a.charStart - b.charStart)

  // A cluster that ended up with no surviving edge is not drawn; drop the node so the graph never
  // shows an isolated stranger the model invented in one chunk and never mentioned again.
  const connected = new Set()
  for (const edge of kept) {
    connected.add(edge.source)
    connected.add(edge.target)
  }
  const nodesFiltered = nodes.filter((node) => connected.has(node.id))
  const liveIds = new Set(nodesFiltered.map((node) => node.id))
  const edges = kept.filter((edge) => liveIds.has(edge.source) && liveIds.has(edge.target))

  const chunkDrops = results.reduce((sum, result) => sum + (result.bound?.stats?.dropped ?? 0), 0)
  const chunkDropReasons = new Map()
  for (const result of results) {
    for (const item of result.bound?.stats?.droppedReasons ?? []) {
      chunkDropReasons.set(item.reason, (chunkDropReasons.get(item.reason) ?? 0) + item.count)
    }
  }
  for (const item of dropped) {
    chunkDropReasons.set(item.reason, (chunkDropReasons.get(item.reason) ?? 0) + 1)
  }

  const droppedTotal = chunkDrops + dropped.length
  const verified = edges.filter((edge) => !edge.repaired).length
  const repaired = edges.length - verified

  const modelNodes = results.reduce((sum, result) => sum + (result.parsed?.modelNodeCount ?? 0), 0)
  const modelEdges = results.reduce((sum, result) => sum + (result.parsed?.modelEdgeCount ?? 0), 0)

  // A drop is not automatically an evidence failure. Only these two reasons mean the quote could not
  // be found in the source; duplicates, pair caps and post-merge self loops are policy outcomes of a
  // quote that *did* verify. Mixing them would make the pass rate look worse with more overlap.
  const evidenceFailed =
    (chunkDropReasons.get('evidence-not-in-source') ?? 0) + (chunkDropReasons.get('evidence-too-short') ?? 0)
  const duplicateEvidence = dropped.filter((item) => item.reason === 'duplicate-evidence').length
  const policyDrops = droppedTotal - evidenceFailed
  const gatePassed = edges.length + policyDrops

  const suspects = findAliasSuspects(nodesFiltered)

  return {
    nodes: nodesFiltered,
    edges,
    stats: {
      chars: text.length,
      chunks: chunks.length,
      chunksExtracted: results.length,
      modelNodes,
      modelEdges,
      nodes: nodesFiltered.length,
      edges: edges.length,
      verified,
      repaired,
      dropped: droppedTotal,
      droppedReasons: [...chunkDropReasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      evidenceFailed,
      evidencePassRate: gatePassed + evidenceFailed === 0 ? 1 : gatePassed / (gatePassed + evidenceFailed),
      aliasMerges: Math.max(0, instances.length - clusters.size),
      aliasDeclarations: declaredPairs.length + honorificMerges,
      refusedMerges,
      contestedAliases: contested.size,
      duplicateEvidence,
      suspects: suspects.length,
      suspectExamples: suspects.slice(0, 5),
    },
    aliasDeclarations: declaredPairs,
  }
}

/**
 * kept / (kept + evidence failures) — the share of proposed edges whose quote was found verbatim.
 * Duplicates and pair caps are *not* failures: the quote was real, the edge was redundant.
 */
export function evidencePassRate(kept, failed) {
  const total = kept + failed
  if (total === 0) return 1
  return kept / total
}

/**
 * Two clusters whose names contain each other (林 and 林妹妹) are *possible* aliases we refused to
 * merge because nothing in the text proves it. Reporting them beats silently splitting a character.
 */
function findAliasSuspects(nodes) {
  const suspects = []
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i].name
      const b = nodes[j].name
      if (a.length < 2 || b.length < 2) continue
      const shorter = a.length <= b.length ? a : b
      const longer = a.length <= b.length ? b : a
      if (longer.includes(shorter) && longer.length - shorter.length <= 2) {
        suspects.push({ a, b, why: 'containment' })
      }
    }
  }
  return suspects
}

/** One sentence for the card: what the merge did, in numbers the reader can check. */
export function describeMerge(stats) {
  const parts = [
    `${stats.chunks} 块 → ${stats.nodes} 个角色 / ${stats.edges} 条关系`,
  ]
  if (stats.aliasMerges > 0) parts.push(`合并了 ${stats.aliasMerges} 个重复称呼`)
  if (stats.duplicateEvidence > 0) parts.push(`去掉 ${stats.duplicateEvidence} 条重叠窗口里的重复证据`)
  const rate = Math.round((stats.evidencePassRate ?? 1) * 100)
  parts.push(`证据通过率 ${rate}%`)
  return parts.join('；')
}
