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

/**
 * How often a name must stand on its own before it counts as a character rather than an alias.
 *
 * Below this, a chunk saying «晚娘 is 苏晚's other name» is accepted. Above it the claim is refused
 * and reported: absorbing the name would delete a person from the graph (奥丁 240 次 → 神, 夏弥 87 次 → 诺诺).
 */
const CHARACTER_ALIAS_LIMIT = 20

/**
 * Role words, not people.
 *
 * A novel is full of 「护士」「老板」「中年人」, and a per-chunk extractor happily turns them into
 * characters; they then collect edges that belong to nobody. They are dropped by name, and the drop
 * is reported with its reason instead of quietly becoming a node.
 */
const GENERIC_ROLES = new Set([
  '护士',
  '医生',
  '大夫',
  '老板',
  '老板娘',
  '服务员',
  '店员',
  '伙计',
  '小二',
  '店小二',
  '掌柜',
  '管家',
  '秘书',
  '专家',
  '老人',
  '老者',
  '中年人',
  '年轻人',
  '少年',
  '少女',
  '小孩',
  '孩子',
  '学生们',
  '老师',
  '教授',
  '警察',
  '士兵',
  '士兵们',
  '守卫',
  '守卫们',
  '护卫',
  '侍卫',
  '保镖',
  '仆人',
  '仆人们',
  '丫鬟',
  '侍女',
  '随从',
  '手下',
  '手下们',
  '使者',
  '传令兵',
  '队长',
  '将军',
  '长老',
  '族长',
  '村长',
  '村民',
  '村民们',
  '难民',
  '渔民',
  '猎户',
  '商人',
  '车夫',
  '船夫',
  '铁匠',
  '木匠',
  '路人',
  '人群',
  '众人',
  '人们',
  '船员',
  '船员们',
  '船工',
  '船长',
  '水手',
  '水手们',
  '军官',
  '将军们',
  '医生们',
  '护士们',
  '小姐',
  '先生',
  '女士',
  '太太',
  '夫人',
  '老爷',
  '少爷',
  '公子',
  '小姐们',
  '中年人',
  '老者们',
  '看门人',
  '门房',
  // Collected from a real 457k-character run: these were the role words that still became nodes.
  '服务生',
  '女侍',
  '乘务长',
  '厨师',
  '教官',
  '站长',
  '马仔',
  '校工',
  '女保安',
  '歌手',
  '老妇人',
  '小护士',
  '母亲',
  '父亲',
  '长辈',
  '长辈们',
  '秘党',
  '黄昏教条',
  '百夫长会',
  '神仙',
  '老神仙',
  '老大',
  '巨兽',
  '蛟龙',
  '天马',
  '白狼',
  '乌鸦',
  '骏马',
  '恶灵',
  '黑王',
  '尊神',
  '至尊',
  '陛下',
  '元首',
  '大爷',
  '大爷们',
  '孩子们',
  '女人们',
  '男人们',
  '加图索家',
  '卡塞尔学院',
  '办公室主任',
])

/** True for a role noun that a chunk extractor mistook for a character. */
export function isGenericRole(name) {
  const key = normalizeKey(name)
  if (key === '') return false
  if (GENERIC_ROLES.has(key)) return true
  // 「船员们」「加图索家的长辈们」: a plural collective is never one person.
  if (key.endsWith('们')) return true
  // 「中年人」「后座上的人」: a description, not a name.
  if (key.endsWith('的人') && key.length <= 6) return true
  return false
}

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

/**
 * Occurrences of every key, as offsets.
 * One pass per key over the text; used by `standaloneCounts`.
 */
function keyPositions(text, keys) {
  const positions = new Map()
  for (const key of keys) {
    const hits = []
    if (key.length > 0) {
      let from = 0
      for (;;) {
        const at = text.indexOf(key, from)
        if (at < 0) break
        hits.push(at)
        from = at + key.length
      }
    }
    positions.set(key, hits)
  }
  return positions
}

/**
 * Count only the occurrences of each key that a *longer* key does not already cover.
 *
 * This is the fix for the 「楚」 problem: plain substring counting credits 「楚」 with every one of the
 * 762 「楚子航」 in the book, so the shortest label wins the canonical-name vote and a character ends
 * up called 「楚」 with twenty aliases. Independent occurrences make the full name win its own cluster.
 *
 * Keys are processed longest-first and the covering intervals are kept as a prefix-max array, so the
 * whole map costs one pass plus a binary search per occurrence — a 457k-character book with ~500 names
 * stays in the tens of milliseconds instead of going quadratic.
 */
function standaloneCounts(text, keys) {
  const positions = keyPositions(text, keys)
  const counts = new Map(keys.map((key) => [key, 0]))
  const byLength = new Map()
  for (const key of keys) {
    if (key.length === 0) continue
    if (!byLength.has(key.length)) byLength.set(key.length, [])
    byLength.get(key.length).push(key)
  }
  const lengths = [...byLength.keys()].sort((a, b) => b - a)

  // Intervals of every key strictly longer than the group being processed. Rebuilt per length group
  // (there are at most a handful of groups), then sorted so a binary search can answer "is this
  // occurrence inside a longer name?".
  let intervals = []
  let cursor = 0

  for (const length of lengths) {
    while (cursor < lengths.length && lengths[cursor] > length) {
      const longer = lengths[cursor]
      for (const key of byLength.get(longer)) {
        for (const at of positions.get(key) ?? []) intervals.push([at, at + longer])
      }
      cursor += 1
    }
    intervals = intervals.slice().sort((a, b) => a[0] - b[0])
    const starts = intervals.map((interval) => interval[0])
    const maxEnds = []
    let running = -1
    for (const interval of intervals) {
      running = Math.max(running, interval[1])
      maxEnds.push(running)
    }

    const covered = (at) => {
      let lo = 0
      let hi = starts.length - 1
      let found = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (starts[mid] <= at) {
          found = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      return found >= 0 && maxEnds[found] > at
    }

    for (const key of byLength.get(length)) {
      let count = 0
      for (const at of positions.get(key) ?? []) {
        if (!covered(at)) count += 1
      }
      counts.set(key, count)
    }
  }
  return counts
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

  /**
   * Independent occurrences for every claimed key, computed once for the whole book.
   *
   * Two decisions downstream need this number: the canonical label (「楚」 must not out-vote 「楚子航」
   * by counting its own substring) and whether a key is a *character* rather than an alias. A key that
   * stands on its own hundreds of times — 「奥丁」 240, 「夏弥」 87 — is somebody, and absorbing it into
   * another cluster deletes a person from the graph.
   */
  const allClaimedKeys = new Set()
  for (const instance of instances) for (const key of instance.keys) allClaimedKeys.add(key)
  const independent = standaloneCounts(text, [...allClaimedKeys])
  const independentCount = (key) => independent.get(key) ?? 0

  const occurrenceCache = new Map()
  const occurrences = (key) => {
    if (!occurrenceCache.has(key)) occurrenceCache.set(key, countNameOccurrences(text, key))
    return occurrenceCache.get(key)
  }
  const firstAtCache = new Map()
  const firstAt = (key) => {
    if (!firstAtCache.has(key)) firstAtCache.set(key, text.indexOf(key))
    return firstAtCache.get(key)
  }

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

  // How many *different chunks* claim each key as somebody's alias, and which keys each name itself
  // claims. Together they separate a real alias (诺诺 ↔ 陈墨瞳: each name appears as a node *and* each
  // claims the other) from a one-way mistake (诺诺 claiming 夏弥, while 夏弥's own chunks claim 耶梦加得).
  const aliasClaims = new Map()
  const claimsOf = new Map()
  for (const instance of instances) {
    for (const key of instance.keys) {
      if (key === instance.nameKey) continue
      if (!aliasClaims.has(key)) aliasClaims.set(key, new Set())
      aliasClaims.get(key).add(instance.chunkIndex)
      if (!claimsOf.has(instance.nameKey)) claimsOf.set(instance.nameKey, new Set())
      claimsOf.get(instance.nameKey).add(key)
    }
  }
  const aliasRefusals = []
  const mutualClaim = (key, nameKey) => Boolean(claimsOf.get(key)?.has(nameKey))

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
      // Only the fuller spelling of the *claimer* is exempt: 「楚」 claiming 「楚子航」 is the same
      // person named at length, while 「神」 claiming 「奥丁」 is a character being swallowed, and the
      // second direction must not be what decides it.
      const nameVariant = key.includes(instance.nameKey)
      if (contradicts) {
        refusedMerges += 1
        instance.refused.add(key)
        aliasRefusals.push({ alias: key, claimedBy: instance.nameKey, reason: 'co-presence' })
        continue
      }
      // Absorbing a name deletes that name from the graph unless something proves they are one person:
      // a spelling variant (楚 ⊂ 楚子航), mutual claims (诺诺 ↔ 陈墨瞳), or a key that barely stands on
      // its own (晚娘, twice in the book). 诺诺 claiming 夏弥 is one-way and 夏弥 appears 87 times on her
      // own — that is a person, not an alias, so the claim is refused and reported.
      const claimChunks = aliasClaims.get(key)?.size ?? 0
      const supported =
        nameVariant || mutualClaim(key, instance.nameKey) || occurrences(key) < CHARACTER_ALIAS_LIMIT
      if (!supported) {
        refusedMerges += 1
        instance.refused.add(key)
        aliasRefusals.push({
          alias: key,
          claimedBy: instance.nameKey,
          reason: 'unsupported-alias',
          occurrences: occurrences(key),
          claimChunks,
        })
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

  const ordered = []
  for (const cluster of clusters.values()) {
    const keys = [...cluster.keys]
    if (keys.length === 0) keys.push(cluster.members[0]?.nameKey ?? '')

    // Canonical label: the key with the most *independent* occurrences wins; the plain substring
    // count would hand the vote to 「楚」 for every 「楚子航」 in the book. Ties go to whichever name the
    // text introduces first, which is how a reader learns who the character is.
    let canonical = ''
    let bestIndependent = -1
    let bestFirstAt = Number.POSITIVE_INFINITY
    for (const key of keys) {
      const score = independentCount(key)
      const at = firstAt(key)
      if (
        score > bestIndependent ||
        (score === bestIndependent && at < bestFirstAt) ||
        (score === bestIndependent && at === bestFirstAt && key.length > canonical.length)
      ) {
        bestIndependent = score
        bestFirstAt = at
        canonical = key
      }
    }
    if (canonical === '') canonical = cluster.members[0]?.nameKey ?? ''
    if (canonical === '') continue

    // 「知州」 is a title that is also a suffix of the full name 「陆知州」; 「楚」 is a prefix of
    // 「楚子航」. When a longer key contains the winner and is itself used independently (not just as
    // the winner plus an honorific), prefer the longer form: a graph should show 陆知州, not his office.
    let fuller = ''
    for (const key of keys) {
      if (key === canonical || key.length <= canonical.length || !key.includes(canonical)) continue
      const remainder = key.replace(canonical, '')
      if (remainder !== '' && HONORIFICS.includes(remainder)) continue
      if (/^[老少阿]$/.test(remainder)) continue
      if (independentCount(key) < Math.max(2, bestIndependent * 0.3)) continue
      if (key.length > fuller.length) fuller = key
    }
    if (fuller !== '') canonical = fuller

    const aliases = keys.filter((key) => key !== canonical).sort()
    ordered.push({
      cluster,
      canonical,
      aliases,
      occurrences: occurrences(canonical),
      independent: independentCount(canonical),
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
  const genericIds = new Set()
  const nodes = ordered.map((entry, index) => {
    const id = `n${index + 1}`
    nodeIdByRoot.set(entry.cluster.root, id)
    if (isGenericRole(entry.canonical)) genericIds.add(id)
    return {
      id,
      name: entry.canonical,
      aliases: entry.aliases,
      mentions: entry.occurrences,
      independent: entry.independent ?? entry.occurrences,
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
  const pairCapDrops = new Map()
  const namesById = new Map(nodes.map((node) => [node.id, node.name]))

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
      // 「护士」「老板」 are role words, not people: their edges describe nobody.
      if (genericIds.has(sourceId) || genericIds.has(targetId)) {
        dropped.push({ reason: 'generic-name', edge })
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
        pairCapDrops.set(pairKey, (pairCapDrops.get(pairKey) ?? 0) + 1)
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

  const genericDropped = nodes.filter((node) => genericIds.has(node.id)).map((node) => node.name)
  const pairCapTop = [...pairCapDrops.entries()]
    .map(([pairKey, count]) => {
      const [a, b] = pairKey.split('|')
      return { a: namesById.get(a) ?? a, b: namesById.get(b) ?? b, count }
    })
    .sort((x, y) => y.count - x.count)
    .slice(0, 5)

  // Every merge decision, so a suspicious one can be checked afterwards instead of guessed at.
  const mergeReport = {
    chars: text.length,
    instances: instances.length,
    clusters: clusters.size,
    nodes: ordered.map((entry) => ({
      name: entry.canonical,
      aliases: entry.aliases,
      independent: entry.independent,
      occurrences: entry.occurrences,
      memberChunks: entry.cluster.members.length,
    })),
    refused: aliasRefusals.slice(0, 200),
    genericDropped,
    contested: [...contested].slice(0, 100),
    suspects: suspects.slice(0, 100),
  }

  return {
    nodes: nodesFiltered,
    edges,
    mergeReport,
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
      aliasRefusals: aliasRefusals.slice(0, 20),
      contestedAliases: contested.size,
      duplicateEvidence,
      genericDropped: genericDropped.length,
      genericExamples: genericDropped.slice(0, 8),
      pairCapTop,
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
