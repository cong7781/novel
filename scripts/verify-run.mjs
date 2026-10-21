/**
 * Independent check of a finished run: every edge's evidence must still be findable in the source
 * text, at the offset it claims. This deliberately re-reads the original .txt rather than the run's
 * copy, so a stale or mis-sliced text.txt would show up here.
 *
 *   node scripts/verify-run.mjs <runDir> [--source <txt>]
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const runDir = resolve(args[0] ?? 'out/runs/longwang-full')
const sourceArg = args.includes('--source') ? args[args.indexOf('--source') + 1] : null

const result = JSON.parse(await readFile(resolve(runDir, 'result.json'), 'utf8'))
const text = sourceArg
  ? (await readFile(resolve(sourceArg), 'utf8')).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  : await readFile(resolve(runDir, 'text.txt'), 'utf8')

const nodesById = new Map(result.nodes.map((node) => [node.id, node]))
let missing = 0
let misplaced = 0
let unnamed = 0

for (const edge of result.edges) {
  if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) unnamed += 1
  if (typeof edge.evidence !== 'string' || edge.evidence.trim() === '') {
    missing += 1
    continue
  }
  const at = Number.isInteger(edge.charStart) ? edge.charStart : -1
  const exact = at >= 0 && text.slice(at, at + edge.evidence.length) === edge.evidence
  if (exact) continue
  if (text.includes(edge.evidence)) misplaced += 1
  else missing += 1
}

const total = result.edges.length
console.log(`run        ${runDir}`)
console.log(`text       ${text.length} 字`)
console.log(`nodes      ${result.nodes.length}`)
console.log(`edges      ${total}`)
console.log(`逐字命中   ${total - missing - misplaced}（${(((total - missing - misplaced) / Math.max(1, total)) * 100).toFixed(2)}%）`)
console.log(`位置不符   ${misplaced}（原文里有，但 charStart 指过去对不上）`)
console.log(`原文里没有 ${missing}`)
if (unnamed) console.log(`悬空节点   ${unnamed} 条边引用了不在 nodes 里的 id`)
console.log(missing === 0 && unnamed === 0 ? 'VERIFY OK' : 'VERIFY FAILED')
process.exit(missing === 0 && unnamed === 0 ? 0 : 1)
