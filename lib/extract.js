/**
 * Pure extraction helpers for dsh-character-graph.
 *
 * Nothing here touches Cordis, the network, or the filesystem: the model call lives in
 * index.js, and everything that can be wrong with a model reply is handled here so it can
 * be tested without a provider.
 *
 * The contract this module exists to enforce: an edge survives only when its `evidence`
 * can be located verbatim in the source text. The model is never trusted to have quoted
 * correctly, and a failure to quote is resolved by dropping the edge, not by inventing one.
 */

/**
 * Largest input the tool accepts. This is a hard ceiling, not a target: 600,000 characters is the
 * scale the chunked/RAG pipeline was measured at, and silently truncating a larger book would be
 * worse than refusing it.
 */
export const MAX_CHARS = 600000

/**
 * Below this a single call still sees the whole text, so chunking would only add seams.
 * Above it, the sliding-window pipeline takes over.
 */
export const SINGLE_PASS_MAX_CHARS = 8000

/** Below this there is not enough text for a relationship to be evidence-backed. */
export const MIN_CHARS = 300

/** Shortest evidence we accept as a real quote (after whitespace stripping). */
const MIN_EVIDENCE_CHARS = 6

/** Shortest common fragment that lets us re-anchor a paraphrase onto the real text. */
const REPAIR_MIN_CHARS = 12

/** At most this many distinct evidences are kept for one unordered pair. */
const MAX_EDGES_PER_PAIR = 3

/**
 * The relation vocabulary. A closed list is what makes the edge label mean the same thing on
 * every edge — free-form labels from a model drift into "好友/朋友/至交/知己" for one relation.
 */
export const RELATION_LABELS = [
  '亲子',
  '兄弟姐妹',
  '夫妻',
  '情人',
  '师徒',
  '主仆',
  '朋友',
  '盟友',
  '敌对',
  '宿敌',
  '同僚',
  '上下级',
  '亲戚',
  '暗恋',
  '暗中保护',
  '理念冲突',
  '其他',
]

/** Model phrasings → one canonical label. Anything unknown degrades to 其他, never to garbage. */
const RELATION_SYNONYMS = new Map(
  Object.entries({
    父子: '亲子',
    父女: '亲子',
    母子: '亲子',
    母女: '亲子',
    父子关系: '亲子',
    父与子: '亲子',
    父母: '亲子',
    子女: '亲子',
    兄弟: '兄弟姐妹',
    姐妹: '兄弟姐妹',
    兄妹: '兄弟姐妹',
    姐弟: '兄弟姐妹',
    夫妇: '夫妻',
    夫妻关系: '夫妻',
    恋人: '情人',
    情侣: '情人',
    爱人: '情人',
    男女之情: '情人',
    师生: '师徒',
    老师: '师徒',
    学生: '师徒',
    师徒关系: '师徒',
    师父: '师徒',
    徒弟: '师徒',
    主人: '主仆',
    仆人: '主仆',
    主仆关系: '主仆',
    丫鬟: '主仆',
    好友: '朋友',
    知己: '朋友',
    挚友: '朋友',
    朋友关系: '朋友',
    同盟: '盟友',
    同盟者: '盟友',
    结盟: '盟友',
    敌人: '敌对',
    仇人: '敌对',
    仇敌: '敌对',
    对立: '敌对',
    冲突: '敌对',
    宿敌: '宿敌',
    死敌: '宿敌',
    世仇: '宿敌',
    同事: '同僚',
    同僚关系: '同僚',
    上下属: '上下级',
    上级: '上下级',
    下属: '上下级',
    亲属: '亲戚',
    亲戚关系: '亲戚',
    单恋: '暗恋',
    暗恋关系: '暗恋',
    保护: '暗中保护',
    守护: '暗中保护',
    暗中守护: '暗中保护',
    理念不合: '理念冲突',
    分歧: '理念冲突',
    矛盾: '理念冲突',
  }),
)

export function normalizeRelation(value) {
  const raw = typeof value === 'string' ? value.trim().replace(/\s+/g, '') : ''
  if (raw === '') return '其他'
  if (RELATION_LABELS.includes(raw)) return raw
  const mapped = RELATION_SYNONYMS.get(raw)
  if (mapped) return mapped
  // A label that merely contains a known word still carries the right meaning.
  for (const label of RELATION_LABELS) {
    if (raw.includes(label)) return label
  }
  for (const [word, label] of RELATION_SYNONYMS) {
    if (raw.includes(word)) return label
  }
  return '其他'
}

export const SYSTEM_PROMPT = [
  '你是中文叙事文本的角色关系抽取器。你只输出一个 JSON 对象，不输出任何其他字符。',
  '',
  'JSON 结构：',
  '{"nodes":[{"id":"n1","name":"角色名"}],"edges":[{"source":"n1","target":"n2","relation":"师徒","evidence":"原文片段","strength":3}]}',
  '',
  '规则：',
  '1. nodes：抽取 5–16 个主要角色。同一角色的不同称呼（例如「黛玉」「林妹妹」「三姑娘」）只能占一个节点，name 用文中出现次数最多的那个称呼。',
  '2. edges：只记录文中确实成立的两人关系。每条边只连两个节点，方向无关。不要重复连同一对人。',
  '3. relation：这条边的**关系类型**，只能从下面选一个词，不许自造：',
  `   ${RELATION_LABELS.join('、')}`,
  '4. evidence：必须是从原文逐字复制的一段连续文字，长度 15–80 字，且必须同时指向这两个人（可以其中一人用「他」「她」等明确指代）。禁止改写、概括、翻译、拼接。如果找不到能同时指向两人的原文，就不要生成这条边。',
  '5. strength：1–5 的整数。5 = 至亲／生死／宿敌，3 = 有明确往来的熟人或同僚，1 = 只是点头之交。',
  '6. 每个 source/target 必须是 nodes 里出现过的 id；不能出现指向自己的边。',
  '7. 只输出 JSON，不要 markdown 代码块，不要解释。',
].join('\n')

/** Build the single user message that carries the whole text plus the output contract. */
export function buildPrompt(text) {
  return [
    '下面是待分析的文本（全文）。请按系统指令输出 JSON。',
    '',
    '<<<TEXT',
    text,
    'TEXT>>>',
  ].join('\n')
}

/**
 * Chunk-mode system prompt: the single-call contract plus the two things only a chunked run needs —
 * the other names a character goes by (so the merge stage can resolve 苏晚 = 晚娘) and the
 * explicit warning that this is a fragment, which stops the model from "fixing" a truncated scene.
 */
export const CHUNK_SYSTEM_PROMPT = [
  SYSTEM_PROMPT,
  '',
  '补充规则（本次只看到全文的一个片段）：',
  '8. 片段开头或结尾可能被截断，不要脑补缺失的情节，只依据片段里实际出现的文字。',
  '9. 每个 node 增加 aliases 字段：本段中同一角色的其他称呼（如「林妹妹」「三姑娘」），最多 3 个；没有就给空数组 []。',
  '10. 证据仍然必须是本片段里逐字存在的连续文字。',
].join('\n')

/** The user message for one chunk, optionally carrying the global cast and this chunk's focus pairs. */
export function buildChunkPrompt({ text, ordinal, total, cast = [], focusPairs = [] }) {
  const lines = [`下面是全文的第 ${ordinal + 1}/${total} 段。请按系统指令输出 JSON。`]
  if (cast.length > 0) {
    lines.push('', `已知的全文角色名（同一角色请复用这些名字，不要另造译名）：${cast.slice(0, 60).join('、')}`)
  }
  if (focusPairs.length > 0) {
    const pairs = focusPairs
      .slice(0, 6)
      .map((pair) => `${pair[0]} ↔ ${pair[1]}`)
      .join('；')
    lines.push('', `本段重点是这些两人关系，请优先为它们找原文证据：${pairs}`)
  }
  lines.push('', '<<<TEXT', text, 'TEXT>>>')
  return lines.join('\n')
}

/**
 * Cast scan: the cheap first stage of the RAG path. It answers "who is in this fragment and what
 * else are they called", never "how are they related", so its output stays a few hundred tokens.
 */
export const CAST_SYSTEM_PROMPT = [
  '你是中文叙事文本的角色名扫描器。只输出一个 JSON 对象，不输出任何其他字符。',
  '',
  'JSON 结构：{"cast":[{"name":"角色名","aliases":["其他称呼"]}]}',
  '',
  '规则：',
  '1. 只列本段文字里实际出现的人物姓名/称呼，不要列地名、门派、商号、官职、物品。',
  '2. aliases 是本段里指向同一个人的其他叫法（小名、排行、诨号、身份称呼），没有就给 []。',
  '3. 不要推断任何关系，不要解释，不要输出 JSON 以外的东西。',
  '4. 最多 20 个角色。',
].join('\n')

export function buildCastPrompt(text, ordinal, total) {
  return [
    `下面是全文的第 ${ordinal + 1}/${total} 段。请列出本段出现的人物名与别名，只输出 JSON。`,
    '',
    '<<<TEXT',
    text,
    'TEXT>>>',
  ].join('\n')
}

/** Parse a cast-scan reply. Tolerates the same damage as the extraction reply. */
export function parseCastJson(raw) {
  const parsed = extractJsonObject(raw, '角色名扫描')
  const list = Array.isArray(parsed.cast) ? parsed.cast : Array.isArray(parsed.nodes) ? parsed.nodes : []
  const cast = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const name = cleanName(entry.name)
    if (name === '') continue
    const aliases = []
    for (const alias of Array.isArray(entry.aliases) ? entry.aliases : []) {
      const key = cleanName(alias)
      if (key !== '' && key !== name && !aliases.includes(key)) aliases.push(key)
    }
    cast.push({ name, aliases })
  }
  return { cast }
}

/**
 * Parse the model reply into a structural shape. Tolerates the usual damage: code fences,
 * prose before/after the object, trailing commas, full-width quotes around names.
 *
 * @param {string} raw
 * @returns {{nodes: {id: string, name: string}[], edges: {source: string, target: string, evidence: string, strength: number}[], modelNodeCount: number, modelEdgeCount: number}}
 */
export function parseModelJson(raw) {
  const parsed = extractJsonObject(raw, '抽取')
  const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes : []
  const rawEdges = Array.isArray(parsed.edges) ? parsed.edges : []

  const nodes = []
  const byId = new Map()
  for (const node of rawNodes) {
    if (!node || typeof node !== 'object') continue
    const id = typeof node.id === 'string' ? node.id.trim() : ''
    const name = cleanName(node.name)
    if (id === '' || name === '') continue
    if (byId.has(id)) continue
    const aliases = []
    const rawAliases = Array.isArray(node.aliases) ? node.aliases : node.alias ? [node.alias] : []
    for (const alias of rawAliases) {
      const key = cleanName(alias)
      if (key !== '' && key !== name && !aliases.includes(key)) aliases.push(key)
    }
    const record = { id, name, aliases }
    byId.set(id, record)
    nodes.push(record)
  }
  if (nodes.length === 0) {
    throw new Error('模型没有给出任何角色节点。')
  }

  const edges = []
  for (const edge of rawEdges) {
    if (!edge || typeof edge !== 'object') continue
    const source = typeof edge.source === 'string' ? edge.source.trim() : ''
    const target = typeof edge.target === 'string' ? edge.target.trim() : ''
    const evidence = typeof edge.evidence === 'string' ? edge.evidence : ''
    if (!byId.has(source) || !byId.has(target) || source === target) continue
    edges.push({
      source,
      target,
      relation: normalizeRelation(edge.relation),
      evidence,
      strength: clampStrength(edge.strength),
    })
  }

  return { nodes, edges, modelNodeCount: rawNodes.length, modelEdgeCount: rawEdges.length }
}

/**
 * Bind every edge to a real span of the source text.
 *
 * @param {string} text the exact text the model was shown
 * @param {{nodes: {id: string, name: string}[], edges: {source: string, target: string, evidence: string, strength: number}[], modelNodeCount: number, modelEdgeCount: number}} parsed
 */
export function verifyAndBind(text, parsed) {
  const index = buildStrippedIndex(text)
  const kept = []
  const seenPairs = new Map()
  const dropped = []

  for (const edge of parsed.edges) {
    const quote = stripWhitespace(edge.evidence)
    if (quote.length < MIN_EVIDENCE_CHARS) {
      dropped.push({ edge, reason: 'evidence-too-short' })
      continue
    }

    let span = locate(index, quote)
    let repaired = false
    if (span === null) {
      span = repair(index, quote)
      repaired = span !== null
    }
    if (span === null) {
      dropped.push({ edge, reason: 'evidence-not-in-source' })
      continue
    }

    const pairKey = edge.source < edge.target ? `${edge.source}|${edge.target}` : `${edge.target}|${edge.source}`
    const evidences = seenPairs.get(pairKey) ?? new Set()
    if (evidences.has(span.start)) continue
    if (evidences.size >= MAX_EDGES_PER_PAIR) {
      dropped.push({ edge, reason: 'too-many-edges-for-pair' })
      continue
    }
    evidences.add(span.start)
    seenPairs.set(pairKey, evidences)

    kept.push({
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
      evidence: text.slice(span.start, span.end),
      strength: edge.strength,
      charStart: span.start,
      repaired,
    })
  }

  // Present edges in narrative order so a two-character view can read like a plot.
  kept.sort((a, b) => a.charStart - b.charStart)

  const connected = new Set()
  for (const edge of kept) {
    connected.add(edge.source)
    connected.add(edge.target)
  }
  const nodes = parsed.nodes.filter((node) => connected.has(node.id))
  const keptIds = new Set(nodes.map((node) => node.id))
  const edges = kept.filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target))

  return {
    nodes,
    edges,
    stats: {
      chars: text.length,
      modelNodes: parsed.modelNodeCount,
      modelEdges: parsed.modelEdgeCount,
      nodes: nodes.length,
      edges: edges.length,
      verified: edges.filter((edge) => !edge.repaired).length,
      repaired: edges.filter((edge) => edge.repaired).length,
      dropped: dropped.length,
      droppedReasons: summarizeDrops(dropped),
    },
  }
}

/** One short, honest sentence about what the model produced and what survived checking. */
export function summarize(stats) {
  const scope = stats.chunks > 1 ? `（分 ${stats.chunks} 块抽取后合并）` : ''
  const parts = [
    `从 ${stats.chars.toLocaleString('en-US')} 字${scope}中抽取 ${stats.nodes} 个角色、${stats.edges} 条关系。`,
  ]
  if (stats.repaired > 0) {
    parts.push(`其中 ${stats.repaired} 条证据与原文有出入，已按原文最长匹配重新锚定到真实位置。`)
  }
  if (stats.dropped > 0) {
    const reasons = (stats.droppedReasons ?? []).map((item) => `${reasonLabel(item.reason)}(${item.count})`).join('、')
    parts.push(`另有 ${stats.dropped} 条因无法在原文中核对而丢弃${reasons ? `：${reasons}` : ''}。`)
  } else if (stats.repaired > 0) {
    parts.push('其余证据都在原文中逐字核对通过。')
  } else {
    parts.push('全部证据都在原文中逐字核对通过。')
  }
  if (typeof stats.evidencePassRate === 'number' && stats.chunks > 1) {
    parts.push(`逐字证据通过率 ${Math.round(stats.evidencePassRate * 100)}%。`)
  }
  if (stats.calls > 0) {
    const prompt = (stats.tokens?.prompt ?? 0).toLocaleString('en-US')
    const completion = (stats.tokens?.completion ?? 0).toLocaleString('en-US')
    const seconds = ((stats.elapsedMs ?? 0) / 1000).toFixed(1)
    const cost = typeof stats.costUsd === 'number' ? `，约 $${stats.costUsd.toFixed(3)}` : ''
    parts.push(`模型调用 ${stats.calls} 次，输入 ${prompt} tokens、输出 ${completion} tokens，耗时 ${seconds}s${cost}。`)
  }
  return parts.join('')
}

const REASON_LABELS = {
  'evidence-not-in-source': '原文里找不到',
  'evidence-too-short': '证据太短',
  'too-many-edges-for-pair': '同一对人物证据过多',
  'duplicate-evidence': '重叠窗口的重复证据',
  'pair-cap': '同一对人物证据超过上限',
  'self-after-merge': '合并后指向自己',
  'node-unmapped': '人物未映射',
}

export function reasonLabel(reason) {
  return REASON_LABELS[reason] ?? reason
}

function summarizeDrops(dropped) {
  const counts = new Map()
  for (const item of dropped) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1)
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
}

function cleanName(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[「」『』“”"']/g, '')
    .replace(/\s+/g, '')
    .trim()
}

function clampStrength(value) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number)) return 3
  return Math.max(1, Math.min(5, Math.round(number)))
}

/**
 * Find and parse the JSON object inside a model reply. Tolerates the usual damage: code fences,
 * prose before/after the object, trailing commas, full-width quotes.
 */
function extractJsonObject(raw, what = '抽取') {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('模型没有返回任何内容。')
  }

  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error(`${what}的回复里没有 JSON 对象。`)
  }

  const candidate = raw.slice(start, end + 1)
  const attempts = [
    candidate,
    candidate.replace(/,\s*([}\]])/g, '$1'),
    candidate.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1'),
  ]

  let parsed
  let lastError
  for (const attempt of attempts) {
    try {
      parsed = JSON.parse(attempt)
      break
    } catch (error) {
      lastError = error
    }
  }
  if (parsed === undefined) {
    throw new Error(`${what}的 JSON 解析失败（${lastError && lastError.message}）。`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${what}的 JSON 根节点不是对象。`)
  }
  return parsed
}

function stripWhitespace(value) {
  return value.replace(/\s+/g, '')
}

/**
 * Whitespace-insensitive view of the source plus the mapping back to original offsets, so a
 * quote that differs only in line breaks or indentation still resolves to a real span.
 */
function buildStrippedIndex(text) {
  const chars = []
  const map = []
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (/\s/.test(char)) continue
    chars.push(char)
    map.push(i)
  }
  return { stripped: chars.join(''), map }
}

function locate(index, strippedQuote) {
  const at = index.stripped.indexOf(strippedQuote)
  if (at < 0) return null
  const start = index.map[at]
  const end = index.map[at + strippedQuote.length - 1] + 1
  return { start, end }
}

function repair(index, strippedQuote) {
  const match = longestCommonSubstring(strippedQuote, index.stripped)
  if (match.length < REPAIR_MIN_CHARS) return null
  const start = index.map[match.end - match.length]
  const end = index.map[match.end - 1] + 1
  return { start, end }
}

/** Longest common substring of `needle` inside `haystack`, by rolling DP rows. */
function longestCommonSubstring(needle, haystack) {
  const n = needle.length
  const m = haystack.length
  let previous = new Int32Array(m + 1)
  let current = new Int32Array(m + 1)
  let best = 0
  let bestEnd = -1
  for (let i = 1; i <= n; i += 1) {
    const char = needle[i - 1]
    for (let j = 1; j <= m; j += 1) {
      if (haystack[j - 1] === char) {
        const value = previous[j - 1] + 1
        current[j] = value
        if (value > best) {
          best = value
          bestEnd = j
        }
      } else {
        current[j] = 0
      }
    }
    const swap = previous
    previous = current
    current = swap
    current.fill(0)
  }
  return { length: best, end: bestEnd }
}
