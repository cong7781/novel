/**
 * Selection → visual state, as pure functions.
 *
 * Two modes, because the graph answers two different questions:
 *   - single: "who is this person connected to?" — the clicked node grows, its edges light up,
 *     its neighbours are emphasised, everything else fades.
 *   - pair:   "what is between these two?" — only the two people and the edges that actually
 *     join them stay loud; every other relation goes quiet and the evidence list narrows to
 *     that one pair. Two clicks, in that order.
 *
 * These live apart from the components so both behaviours can be asserted in Node.
 */

export const FADED_OPACITY = 0.33
export const RESTING_EDGE_OPACITY = 0.6

export const SINGLE_SELECTED_RADIUS = 1.75
export const SINGLE_NEIGHBOUR_RADIUS = 1.15
export const PAIR_FIRST_RADIUS = 1.75
export const PAIR_SECOND_RADIUS = 1.55

export const SINGLE_EDGE_WIDTH = 2.1
export const PAIR_EDGE_WIDTH = 2.7

/**
 * @param {{id: string}[]} nodes
 * @param {{source: string, target: string}[]} edges id-based view (never the d3-mutated copy)
 * @param {string | null} firstId
 * @param {string | null} secondId
 */
export function computeFocus(nodes, edges, firstId, secondId = null) {
  const neighbourIds = new Set()
  const edgeIndexes = new Set()

  if (!firstId) {
    return { mode: 'none', firstId: null, secondId: null, neighbourIds, edgeIndexes }
  }

  if (secondId && secondId !== firstId) {
    neighbourIds.add(firstId)
    neighbourIds.add(secondId)
    edges.forEach((edge, index) => {
      const joins =
        (edge.source === firstId && edge.target === secondId) ||
        (edge.source === secondId && edge.target === firstId)
      if (joins) edgeIndexes.add(index)
    })
    return { mode: 'pair', firstId, secondId, neighbourIds, edgeIndexes }
  }

  neighbourIds.add(firstId)
  edges.forEach((edge, index) => {
    if (edge.source === firstId || edge.target === firstId) {
      edgeIndexes.add(index)
      neighbourIds.add(edge.source === firstId ? edge.target : edge.source)
    }
  })
  return { mode: 'single', firstId, secondId: null, neighbourIds, edgeIndexes }
}

/** Radius multiplier and opacity for one node under the current focus. */
export function nodeVisual(focus, nodeId) {
  if (focus.mode === 'none') return { opacity: 1, radiusFactor: 1, emphasised: false }

  if (focus.mode === 'pair') {
    if (nodeId === focus.firstId) return { opacity: 1, radiusFactor: PAIR_FIRST_RADIUS, emphasised: true }
    if (nodeId === focus.secondId) return { opacity: 1, radiusFactor: PAIR_SECOND_RADIUS, emphasised: true }
    return { opacity: FADED_OPACITY, radiusFactor: 1, emphasised: false }
  }

  if (nodeId === focus.firstId) return { opacity: 1, radiusFactor: SINGLE_SELECTED_RADIUS, emphasised: true }
  if (focus.neighbourIds.has(nodeId)) return { opacity: 1, radiusFactor: SINGLE_NEIGHBOUR_RADIUS, emphasised: true }
  return { opacity: FADED_OPACITY, radiusFactor: 1, emphasised: false }
}

/** Opacity, width multiplier and highlight flag for one edge under the current focus. */
export function edgeVisual(focus, edgeIndex) {
  const highlighted = focus.edgeIndexes.has(edgeIndex)
  if (focus.mode === 'none') {
    return { opacity: RESTING_EDGE_OPACITY, widthFactor: 1, highlighted: false }
  }
  if (highlighted) {
    return {
      opacity: 1,
      widthFactor: focus.mode === 'pair' ? PAIR_EDGE_WIDTH : SINGLE_EDGE_WIDTH,
      highlighted: true,
    }
  }
  return { opacity: focus.mode === 'pair' ? 0.1 : 0.12, widthFactor: 1, highlighted: false }
}

/** Relations of one character, in narrative order — used to describe a single selection. */
export function relationsOf(edges, nodesById, characterId) {
  return edges
    .filter((edge) => edge.source === characterId || edge.target === characterId)
    .map((edge) => {
      const otherId = edge.source === characterId ? edge.target : edge.source
      return {
        otherId,
        otherName: nodesById.get(otherId)?.name ?? otherId,
        evidence: edge.evidence,
        strength: edge.strength,
        charStart: edge.charStart,
      }
    })
    .sort((a, b) => (a.charStart ?? 0) - (b.charStart ?? 0))
}

/** Only the evidences that actually join two characters, in narrative order. */
export function pairRelations(edges, firstId, secondId) {
  return edges
    .filter(
      (edge) =>
        (edge.source === firstId && edge.target === secondId) ||
        (edge.source === secondId && edge.target === firstId),
    )
    .map((edge) => ({
      relation: edge.relation ?? '其他',
      evidence: edge.evidence,
      strength: edge.strength,
      charStart: edge.charStart,
    }))
    .sort((a, b) => (a.charStart ?? 0) - (b.charStart ?? 0))
}
