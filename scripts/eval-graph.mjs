/**
 * Score a run against the long-text fixture's ground truth.
 *
 * The synthetic fixture ships a manifest that names the cast and states every declared relation
 * explicitly, which is exactly what an extraction run can be checked against:
 *
 *   - cast coverage: how many of the known characters made it into the graph?
 *   - alias resolution: did 苏晚 / 晚娘 / 三姑娘 collapse into one node, and did two different
 *     characters get wrongly merged (over-merge is the dangerous failure)?
 *   - relation recall: of the relations the text states, how many are edges in the graph?
 *   - pair coverage: which co-occurring pairs were found, and how many beats per pair?
 *
 *   node scripts/eval-graph.mjs out/runs/m2-100k/result.json out/texts/novel-100k.manifest.json
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const [resultPath, manifestPath] = process.argv.slice(2)
if (!resultPath || !manifestPath) {
  console.error('用法: node scripts/eval-graph.mjs <result.json> <manifest.json>')
  process.exit(2)
}

const result = JSON.parse(await readFile(resolve(resultPath), 'utf8'))
const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8'))

const nodes = result.nodes ?? []
const edges = result.edges ?? []
const stats = result.stats ?? {}

/** A character is "covered" when some node's name or alias list contains the known name. */
function nodeFor(knownName) {
  const direct = nodes.find((node) => node.name === knownName)
  if (direct) return direct
  return nodes.find((node) => (node.aliases ?? []).includes(knownName)) ?? null
}

const castNames = manifest.cast.map((character) => character.name)
const coverage = castNames.map((name) => ({ name, node: nodeFor(name) }))
const covered = coverage.filter((entry) => entry.node)
const missing = coverage.filter((entry) => !entry.node)

// Over-merge: one node covering two *different* known characters would mean the resolver collapsed
// two people. That is worse than splitting one, so it is reported loudly.
const overMerged = []
for (const node of nodes) {
  const keys = new Set([node.name, ...(node.aliases ?? [])])
  const matched = castNames.filter((name) => keys.has(name))
  if (matched.length > 1) overMerged.push({ node: node.name, matched })
}

const pairBetween = (leftName, rightName) => {
  const left = nodeFor(leftName)
  const right = nodeFor(rightName)
  if (!left || !right) return null
  const found = edges.filter(
    (edge) =>
      (edge.source === left.id && edge.target === right.id) || (edge.source === right.id && edge.target === left.id),
  )
  return { left, right, edges: found }
}

const declared = manifest.relations.filter((relation) => relation.declared > 0)
const recall = declared.map((relation) => {
  const paired = pairBetween(relation.a, relation.b)
  return {
    ...relation,
    found: paired?.edges.length ?? 0,
    ok: (paired?.edges.length ?? 0) > 0,
  }
})
const recalled = recall.filter((entry) => entry.ok)

const edgePairs = new Set(
  edges.map((edge) => {
    const a = nodes.find((node) => node.id === edge.source)?.name ?? edge.source
    const b = nodes.find((node) => node.id === edge.target)?.name ?? edge.target
    return [a, b].sort().join('|')
  }),
)
const manifestPairs = manifest.pairs.filter((entry) => entry.count >= 2)
const pairRecall = manifestPairs.filter((entry) => {
  const [a, b] = entry.pair.split('|')
  const left = nodeFor(a)
  const right = nodeFor(b)
  if (!left || !right) return false
  return edgePairs.has([left.name, right.name].sort().join('|'))
})

const pct = (value) => `${Math.round(value * 100)}%`

console.log(`result:   ${resultPath}`)
console.log(`manifest: ${manifestPath}`)
console.log('')
console.log(`字数          ${(stats.chars ?? 0).toLocaleString('en-US')} / 分块 ${stats.chunks ?? 1} / 抽取块 ${stats.chunksExtracted ?? 1}`)
console.log(`角色节点      ${nodes.length}（manifest 里 ${castNames.length} 人，命中 ${covered.length}）`)
console.log(`关系边        ${edges.length}（覆盖 ${edgePairs.size} 组人物对）`)
console.log(`逐字通过      ${stats.verified ?? 0} 条，重锚 ${stats.repaired ?? 0} 条，通过率 ${pct(stats.evidencePassRate ?? 1)}`)
console.log(`丢弃          ${stats.dropped ?? 0} 条：${(stats.droppedReasons ?? []).map((item) => `${item.reason}×${item.count}`).join('，') || '无'}`)
console.log(
  `成本/耗时     $${(stats.costUsd ?? 0).toFixed(4)} / ${((stats.elapsedMs ?? 0) / 1000).toFixed(1)}s` +
    `（每万字 $${(stats.per10k?.costUsd ?? 0).toFixed(4)} / ${stats.per10k?.seconds ?? 0}s）`,
)
console.log('')
console.log(`角色召回      ${covered.length}/${castNames.length}` + (missing.length ? `  缺：${missing.map((entry) => entry.name).join('、')}` : ''))
console.log(`明写关系召回  ${recalled.length}/${declared.length}`)
console.log(`同现人物对    ${pairRecall.length}/${manifestPairs.length}（manifest 中同现 ≥2 次的对）`)
console.log(`错误合并      ${overMerged.length === 0 ? '无' : overMerged.map((item) => `${item.node} ← ${item.matched.join('+')}`).join('；')}`)

const lost = recall.filter((entry) => !entry.ok)
if (lost.length > 0) {
  console.log('')
  console.log('未抽到的明写关系：')
  for (const entry of lost) console.log(`  ${entry.a} —[${entry.kind}]→ ${entry.b}（原文明写 ${entry.declared} 处）`)
}

const covered_pairs = edges.reduce((sum, edge) => sum + 1, 0) / Math.max(1, edgePairs.size)
console.log('')
console.log(`平均每组人物对的证据条数  ${covered_pairs.toFixed(2)}`)
console.log(
  `别名合并      ${stats.aliasMerges ?? 0} 个重复称呼；疑似未合并 ${stats.suspects ?? 0} 组` +
    ((stats.suspectExamples ?? []).length ? `（${stats.suspectExamples.map((item) => `${item.a}/${item.b}`).join('、')}）` : ''),
)
