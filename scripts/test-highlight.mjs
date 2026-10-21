import assert from 'node:assert/strict'

import {
  FADED_OPACITY,
  computeFocus,
  edgeVisual,
  nodeVisual,
  pairRelations,
  relationsOf,
} from '../src/highlight.js'

const nodes = [
  { id: 'n1', name: '沈砚' },
  { id: 'n2', name: '沈鹤年' },
  { id: 'n3', name: '苏晚' },
  { id: 'n4', name: '周砚秋' },
]
const edges = [
  { source: 'n1', target: 'n2', evidence: 'a', strength: 5, charStart: 10 },
  { source: 'n2', target: 'n3', evidence: 'b', strength: 4, charStart: 30 },
  { source: 'n1', target: 'n4', evidence: 'c', strength: 3, charStart: 20 },
  { source: 'n4', target: 'n1', evidence: 'd', strength: 2, charStart: 40 },
]

// ── nobody selected ────────────────────────────────────────────────────────────────────────
const idle = computeFocus(nodes, edges, null)
assert.equal(idle.mode, 'none')
for (const node of nodes) {
  assert.equal(nodeVisual(idle, node.id).opacity, 1, 'nothing fades while nothing is selected')
  assert.equal(nodeVisual(idle, node.id).radiusFactor, 1)
}
assert.equal(edgeVisual(idle, 0).highlighted, false)

// ── one click: focus one character and its relations ──────────────────────────────────────
const single = computeFocus(nodes, edges, 'n1')
assert.equal(single.mode, 'single')
assert.deepEqual([...single.neighbourIds].sort(), ['n1', 'n2', 'n4'])
assert.deepEqual([...single.edgeIndexes].sort((a, b) => a - b), [0, 2, 3])

assert.equal(nodeVisual(single, 'n1').radiusFactor, 1.75, 'the clicked character grows')
assert.equal(nodeVisual(single, 'n2').radiusFactor, 1.15, 'a neighbour grows a little')
assert.equal(nodeVisual(single, 'n3').opacity, FADED_OPACITY, 'an unrelated character fades')
assert.equal(edgeVisual(single, 0).widthFactor, 2.1, 'a related edge thickens')
assert.ok(edgeVisual(single, 1).opacity < 0.2, 'an unrelated edge fades back')

// ── second click: the pair, and ONLY what joins them ──────────────────────────────────────
const pair = computeFocus(nodes, edges, 'n1', 'n4')
assert.equal(pair.mode, 'pair')
assert.deepEqual([...pair.neighbourIds].sort(), ['n1', 'n4'])
assert.deepEqual(
  [...pair.edgeIndexes].sort((a, b) => a - b),
  [2, 3],
  'both directions between the pair stay highlighted',
)

assert.equal(nodeVisual(pair, 'n1').radiusFactor, 1.75, 'the anchored character stays big')
assert.equal(nodeVisual(pair, 'n4').radiusFactor, 1.55, 'the second character grows too')
assert.equal(nodeVisual(pair, 'n2').opacity, FADED_OPACITY, 'an ex-neighbour now fades in pair mode')
assert.equal(edgeVisual(pair, 2).widthFactor, 2.7, 'the pair edge is emphasised harder')
assert.ok(edgeVisual(pair, 0).opacity <= 0.12, 'relations outside the pair go quiet')

// A pair that shares no edge: nothing is highlighted, nothing throws.
const stranger = computeFocus(nodes, edges, 'n3', 'n4')
assert.equal(stranger.mode, 'pair')
assert.equal(stranger.edgeIndexes.size, 0)

// Selecting the same character twice is a single focus, not a degenerate pair.
assert.equal(computeFocus(nodes, edges, 'n1', 'n1').mode, 'single')

// ── evidence ─────────────────────────────────────────────────────────────────────────────
const relations = relationsOf(edges, new Map(nodes.map((node) => [node.id, node])), 'n1')
assert.equal(relations.length, 3, 'relationsOf is edge-level: n1-n4 is recorded in both directions here')
assert.deepEqual(
  [...new Set(relations.map((relation) => relation.otherName))],
  ['沈鹤年', '周砚秋'],
  'the people on the other end are deduped',
)
assert.equal(relations[0].evidence, 'a')

const between = pairRelations(edges, 'n1', 'n4')
assert.deepEqual(between.map((relation) => relation.evidence), ['c', 'd'], 'pair evidence is in narrative order')
assert.equal(pairRelations(edges, 'n2', 'n4').length, 0, 'no invented relation between strangers')

console.log('highlight ok')
