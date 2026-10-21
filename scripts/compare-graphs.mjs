/**
 * Compare two extraction results: what did the second run gain or lose?
 *
 * Written for the "chunked must be equivalent or better than single-pass" question, but it is the
 * general tool for comparing any two runs (single vs chunk, budget vs full, rerun vs rerun).
 *
 *   node scripts/compare-graphs.mjs out/runs/m1-single/result.json out/runs/m1-chunk/result.json
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const [leftPath, rightPath] = process.argv.slice(2)
if (!leftPath || !rightPath) {
  console.error('用法: node scripts/compare-graphs.mjs <base result.json> <candidate result.json>')
  process.exit(2)
}

const left = JSON.parse(await readFile(resolve(leftPath), 'utf8'))
const right = JSON.parse(await readFile(resolve(rightPath), 'utf8'))

const pairKeys = (graph) =>
  new Set(
    graph.edges.map((edge) => {
      const a = graph.nodes.find((node) => node.id === edge.source)?.name ?? edge.source
      const b = graph.nodes.find((node) => node.id === edge.target)?.name ?? edge.target
      return [a, b].sort().join(' ↔ ')
    }),
  )

const nameSet = (graph) => new Set(graph.nodes.map((node) => node.name))
const leftPairs = pairKeys(left)
const rightPairs = pairKeys(right)
const leftNames = nameSet(left)
const rightNames = nameSet(right)

const gainedPairs = [...rightPairs].filter((pair) => !leftPairs.has(pair))
const lostPairs = [...leftPairs].filter((pair) => !rightPairs.has(pair))
const gainedNames = [...rightNames].filter((name) => !leftNames.has(name))
const lostNames = [...leftNames].filter((name) => !rightNames.has(name))

const row = (label, a, b) => console.log(`${label.padEnd(18)} ${String(a).padStart(10)} ${String(b).padStart(10)} ${delta(a, b)}`)

console.log(`base:      ${leftPath}`)
console.log(`candidate: ${rightPath}`)
console.log('')
console.log(`${''.padEnd(18)} ${'base'.padStart(10)} ${'candidate'.padStart(10)} Δ`)
row('字数', left.stats.chars, right.stats.chars)
row('角色', left.nodes.length, right.nodes.length)
row('关系边', left.edges.length, right.edges.length)
row('不同人物对', leftPairs.size, rightPairs.size)
row('逐字通过', left.stats.verified, right.stats.verified)
row('重锚', left.stats.repaired, right.stats.repaired)
row('丢弃', left.stats.dropped, right.stats.dropped)
row('模型调用', left.stats.calls ?? 1, right.stats.calls ?? 1)
row('输入 tokens', left.stats.tokens?.prompt ?? 0, right.stats.tokens?.prompt ?? 0)
row('输出 tokens', right.stats.tokens?.completion ?? 0, right.stats.tokens?.completion ?? 0)
row('成本 USD', left.stats.costUsd ?? 0, right.stats.costUsd ?? 0)

console.log('')
console.log(`证据通过率   ${percent(left.stats.evidencePassRate)}  →  ${percent(right.stats.evidencePassRate)}`)
console.log(`新增人物     ${gainedNames.join('、') || '（无）'}`)
console.log(`丢失人物     ${lostNames.join('、') || '（无）'}`)
console.log(`新增人物对   ${gainedPairs.join('；') || '（无）'}`)
console.log(`丢失人物对   ${lostPairs.join('；') || '（无）'}`)

function percent(value) {
  return value === undefined ? '—' : `${Math.round(value * 100)}%`
}

function delta(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return ''
  const diff = b - a
  if (diff === 0) return ''
  return `${diff > 0 ? '+' : ''}${typeof a === 'number' && Number.isInteger(a) && Number.isInteger(b) ? diff : diff.toFixed(4)}`
}
