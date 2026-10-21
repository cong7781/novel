/**
 * Standalone viewer: an animated force-directed character graph.
 *
 * Visual rules:
 *   - colour carries meaning: every edge is tinted by its relation *category*, so kinship reads
 *     warm, romance pink, obligation blue, conflict violet, affinity green;
 *   - nothing appears instantly: nodes scale in with a stagger, edges draw themselves on;
 *   - motion never stops: after settling the simulation keeps a very low alpha so the graph
 *     breathes instead of freezing;
 *   - selection is a transition, not a jump: size and opacity animate, and a pulse ring fires
 *     from the node that was clicked.
 *
 * Data comes from either `window.__GRAPH_DATA__` (static build) or POST /api/extract when served
 * by scripts/serve.mjs.
 */

import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import { computeFocus, edgeVisual, nodeVisual, pairRelations, relationsOf } from '../../src/highlight.js'

/** Node radius grows with the canvas: the graph is the page's main content, not a widget. */
function radiusFor(width) {
  if (width > 980) return 23
  if (width > 700) return 20
  return 16
}

const CATEGORY_OF = {
  亲子: 'kinship',
  兄弟姐妹: 'kinship',
  夫妻: 'kinship',
  亲戚: 'kinship',
  情人: 'romance',
  暗恋: 'romance',
  师徒: 'bond',
  主仆: 'bond',
  同僚: 'bond',
  上下级: 'bond',
  敌对: 'conflict',
  宿敌: 'conflict',
  理念冲突: 'conflict',
  朋友: 'affinity',
  盟友: 'affinity',
  暗中保护: 'guard',
  其他: 'other',
}

const COLOR = {
  kinship: '#f4784f',
  romance: '#f2609f',
  bond: '#5b9bff',
  conflict: '#a97bff',
  affinity: '#3fca8d',
  guard: '#2fd2c8',
  other: '#9aa7bd',
}

const CATEGORY_LABEL = {
  kinship: '亲属',
  romance: '情感',
  bond: '师承/主从',
  conflict: '敌对',
  affinity: '交好',
  guard: '守护',
  other: '其他',
}

function categoryOf(relation) {
  return CATEGORY_OF[relation] ?? 'other'
}

const STYLE_ID = 'cg-style'

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    #graph svg { overflow: visible; }
    .cg-node-inner {
      transition: transform 320ms cubic-bezier(.22,1.2,.36,1), opacity 260ms ease;
      transform-box: fill-box;
      transform-origin: center;
    }
    .cg-node { transition: opacity 260ms ease; }
    .cg-halo {
      transition: opacity 260ms ease;
      pointer-events: none;
    }
    @keyframes cg-breathe {
      0%, 100% { opacity: .32; }
      50%      { opacity: .62; }
    }
    .cg-halo--on { animation: cg-breathe 2.6s ease-in-out infinite; }
    .cg-label {
      transition: opacity 260ms ease, font-weight 260ms ease;
      font-weight: 500;
    }
    .cg-edge {
      transition: stroke-opacity 320ms ease, stroke-width 320ms ease, stroke 320ms ease;
    }
    .cg-edge-label {
      transition: opacity 280ms ease;
      font-weight: 600;
      letter-spacing: .04em;
    }
    .cg-pulse {
      pointer-events: none;
      animation: cg-pulse 720ms cubic-bezier(.2,.6,.3,1) forwards;
    }
    @keyframes cg-pulse {
      from { r: 18; opacity: .55; stroke-width: 2; }
      to   { r: 52; opacity: 0;   stroke-width: .5; }
    }
    .cg-row-in { animation: cg-row-in 260ms ease both; }
    @keyframes cg-row-in {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: none; }
    }
    .cg-legend { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 auto 12px; }
    .cg-legend span {
      display: inline-flex; align-items: center; gap: 7px; padding: 3px 10px;
      font-size: 11.5px; color: var(--muted, #94a2ba); border-radius: 999px;
      background: var(--panel, rgba(255, 255, 255, .05));
      border: 1px solid var(--line, rgba(255, 255, 255, .1));
    }
    .cg-legend i { width: 14px; height: 3px; border-radius: 2px; display: inline-block; box-shadow: 0 0 8px currentColor; }
    @keyframes cg-flow { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -30; } }
    @media (prefers-color-scheme: dark) {
      .cg-legend span { color: #9aa2b1; }
    }
    /* Snapshot mode (?still=1) and reduced-motion users get the settled frame with no timeline:
       a headless browser cannot advance CSS animations, and a screenshot should show the result,
       not a random instant of the entrance. */
    .cg-no-motion *, .cg-no-motion *::before, .cg-no-motion *::after {
      transition: none !important;
      animation: none !important;
    }
  `
  document.head.appendChild(style)
}

export function mountGraph(data, graphRoot, evidenceRoot) {
  injectStyles()
  graphRoot.innerHTML = ''
  evidenceRoot.innerHTML = ''

  const nodes = data.nodes.map((node) => ({ ...node }))
  // `edges` keeps string ids: every focus/evidence lookup works on ids, and the layout must not
  // mutate the objects those lookups read.
  const edgeData = data.edges.map((edge, index) => ({ ...edge, index }))
  const edges = edgeData.map((edge) => ({ ...edge }))
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  for (const edge of edges) {
    edge.from = nodesById.get(edge.source)
    edge.to = nodesById.get(edge.target)
  }

  /**
   * One layout spring per *pair*, even when a pair carries three narrative beats.
   *
   * d3's link force treats every link as an independent spring, so three parallel edges between the
   * same two people pull three times as hard. With a 12-person cast that is up to 198 edges over 66
   * pairs: the whole layout collapsed into a small blob, and no amount of "fit to frame" could make
   * the network fill its panel. Rendering still draws every edge; only the physics is deduped.
   */
  const pairLinks = new Map()
  for (const edge of edges) {
    const key = edge.source < edge.target ? `${edge.source}|${edge.target}` : `${edge.target}|${edge.source}`
    const previous = pairLinks.get(key)
    if (!previous || (edge.strength ?? 3) > previous.strength) {
      pairLinks.set(key, { source: edge.from, target: edge.to, strength: edge.strength ?? 3 })
    }
  }
  const layoutLinks = [...pairLinks.values()]
  // Retrieval needs the server (the run's source text lives in its run directory); a static page
  // opened over file:// has no endpoint to ask, and saying so beats showing an empty box.
  const retrievalEnabled =
    Boolean(data.runId) || location.protocol === 'http:' || location.protocol === 'https:'
  let retrievalToken = 0

  const width = Math.max(320, graphRoot.clientWidth || 900)
  const RADIUS = radiusFor(width)
  // The canvas is the graph's frame, and it is meant to be filled rather than decorated with margins.
  // It also stops growing at the viewport: a graph taller than the screen would scroll, and the
  // point of the frame is that the whole network is visible at once.
  const viewportCap = Math.round((window.innerHeight || 900) * 0.8)
  const HEIGHT = Math.max(520, Math.min(Math.round(width * 0.84), 920, viewportCap))

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(HEIGHT))
  // One fixed view box — no post-settle cropping. Fitting happens by mapping the layout onto the
  // canvas (see `fit`), so the drawing area always equals the panel.
  svg.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`)
  svg.style.display = 'block'
  svg.style.touchAction = 'none'
  svg.style.userSelect = 'none'
  graphRoot.appendChild(svg)

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
  defs.innerHTML =
    '<filter id="cg-glow" x="-60%" y="-60%" width="220%" height="220%">' +
    '<feGaussianBlur stdDeviation="5" result="blur"/>' +
    '<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>' +
    '</filter>'
  svg.appendChild(defs)

  const linkLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  // Edges must never win a hit test: a click aimed at a character would otherwise resolve to a
  // line that happens to pass under the cursor.
  linkLayer.style.pointerEvents = 'none'
  const nodeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  svg.append(linkLayer, nodeLayer)

  /**
   * Simulation space → canvas space.
   *
   * A force layout settles into a roughly round blob. Cropping a view box around it (the old
   * `fitToView`) could only ever fill the frame in *one* dimension: the other dimension keeps a
   * margin proportional to the aspect mismatch, so on a wide panel the network covered ~55% of the
   * area no matter how large the panel got.
   *
   * This is a fixed affine map instead: the blob is stretched — bounded, 1.6:1 at most, so it never
   * becomes a ribbon — to fill the panel, and the simulation keeps running in its own coordinates,
   * which is what preserves the breathing motion. `sx`/`sy` are only ever recomputed on settle.
   */
  const bandTop = RADIUS + 18
  const bandBottom = HEIGHT - (RADIUS + 44) // room for the name under the bottom row
  const bandCenterY = (bandTop + bandBottom) / 2
  let fit = { sx: 1, sy: 1, cx: 0, cy: 0 }
  const screenX = (x) => width / 2 + (x - fit.cx) * fit.sx
  const screenY = (y) => bandCenterY + (y - fit.cy) * fit.sy

  // Snapshot mode implies "no motion": everything renders at its settled state, which is also
  // exactly what a headless screenshot needs and what a reduced-motion user asked for.
  const reduceMotion =
    snapshotMode ||
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)

  // A character inherits the colour of his strongest relation, so the idle view already reads as
  // "this one belongs to the conflict side" instead of nine identical grey dots.
  const dominant = new Map()
  for (const edge of edgeData) {
    const category = categoryOf(edge.relation)
    const score = edge.strength ?? 3
    for (const id of [edge.source, edge.target]) {
      const current = dominant.get(id)
      if (!current || score > current.score) dominant.set(id, { category, score })
    }
  }

  // One radial gradient per category: a flat disc reads as a bullet point, a lit sphere reads as
  // an object you can pick up.
  for (const [key, color] of Object.entries(COLOR)) {
    const gradient = document.createElementNS('http://www.w3.org/2000/svg', 'radialGradient')
    gradient.setAttribute('id', `cg-grad-${key}`)
    gradient.setAttribute('cx', '34%')
    gradient.setAttribute('cy', '26%')
    gradient.setAttribute('r', '80%')
    const inner = document.createElementNS('http://www.w3.org/2000/svg', 'stop')
    inner.setAttribute('offset', '0%')
    inner.setAttribute('stop-color', mixWithWhite(color, 0.6))
    const outer = document.createElementNS('http://www.w3.org/2000/svg', 'stop')
    outer.setAttribute('offset', '100%')
    outer.setAttribute('stop-color', color)
    gradient.append(inner, outer)
    defs.appendChild(gradient)
  }

  const lineEls = edges.map((edge, index) => {
    const color = COLOR[categoryOf(edge.relation)]
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('class', 'cg-edge')
    line.setAttribute('stroke', color)
    line.setAttribute('stroke-linecap', 'round')
    line.setAttribute('stroke-width', String(1 + (edge.strength ?? 3) * 0.45))
    line.setAttribute('stroke-opacity', '0')
    if (!reduceMotion) {
      // Draw-on: start fully offset and let paint() animate the dash to zero.
      line.style.strokeDasharray = '1400'
      line.style.strokeDashoffset = '1400'
      line.style.transition =
        'stroke-opacity 320ms ease, stroke-width 320ms ease, ' +
        `stroke-dashoffset 950ms cubic-bezier(.4,0,.2,1) ${120 + index * 26}ms`
    }
    linkLayer.appendChild(line)
    return line
  })

  // Energy dots that travel along a highlighted edge — the cheapest way to make "these two are
  // connected" feel like a live wire instead of a drawn line.
  const flowEls = edges.map(() => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('stroke', '#ffffff')
    line.setAttribute('stroke-opacity', '0')
    line.setAttribute('stroke-width', '2.6')
    line.setAttribute('stroke-linecap', 'round')
    line.setAttribute('stroke-dasharray', '2 13')
    line.style.pointerEvents = 'none'
    linkLayer.appendChild(line)
    return line
  })

  // One label per edge, drawn only while that edge is highlighted — a permanent label cloud is
  // unreadable at nine characters, and the relation type is exactly what a reader wants at the
  // moment they are looking at one edge.
  const labelEls = edges.map((edge) => {
    const color = COLOR[categoryOf(edge.relation)]
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    text.setAttribute('class', 'cg-edge-label')
    text.setAttribute('text-anchor', 'middle')
    text.setAttribute('font-size', '11.5')
    text.setAttribute('fill', color)
    text.setAttribute('stroke', 'var(--bg)')
    text.setAttribute('stroke-width', '3.5')
    text.setAttribute('paint-order', 'stroke')
    text.setAttribute('opacity', '0')
    text.style.pointerEvents = 'none'
    text.textContent = edge.relation ?? ''
    linkLayer.appendChild(text)
    return text
  })

  const nodeEls = nodes.map((node, index) => {
    const outer = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    outer.setAttribute('class', 'cg-node')
    outer.style.cursor = 'grab'

    const inner = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    inner.setAttribute('class', 'cg-node-inner')
    inner.style.transform = 'scale(0.6)'
    outer.style.opacity = '0'

    const halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    halo.setAttribute('class', 'cg-halo')
    halo.setAttribute('r', String(RADIUS + 9))
    halo.setAttribute('fill', 'none')
    halo.setAttribute('stroke', '#5b8def')
    halo.setAttribute('stroke-width', '2')
    halo.setAttribute('opacity', '0')

    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    hit.setAttribute('r', String(RADIUS + 10))
    hit.setAttribute('fill', 'transparent')

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    circle.setAttribute('r', String(RADIUS))
    circle.setAttribute('fill', 'rgba(139, 147, 164, 0.78)')
    circle.setAttribute('stroke', 'rgba(255, 255, 255, 0.75)')
    circle.setAttribute('stroke-width', '1.5')
    circle.style.transition = 'fill 260ms ease, stroke 260ms ease, r 300ms cubic-bezier(.22,1.2,.36,1)'

    inner.append(halo, hit, circle)

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    label.setAttribute('class', 'cg-label')
    label.setAttribute('text-anchor', 'middle')
    label.setAttribute('font-size', '12.5')
    label.setAttribute('fill', 'currentColor')
    label.setAttribute('fill-opacity', '0.95')
    label.setAttribute('stroke', 'var(--bg)')
    label.setAttribute('stroke-width', '3.5')
    label.setAttribute('paint-order', 'stroke')
    label.style.pointerEvents = 'none'
    label.style.opacity = '0'
    label.textContent = node.name

    outer.append(inner, label)
    nodeLayer.appendChild(outer)

    // Staggered entrance: the delay lives on the element, so the first paint() starts it.
    const delay = reduceMotion ? 0 : 90 + index * 55
    outer.style.transition = `opacity 420ms ease ${delay}ms`
    inner.style.transition = `transform 520ms cubic-bezier(.22,1.4,.36,1) ${delay}ms`
    label.style.transition = `opacity 420ms ease ${delay + 120}ms`

    outer.addEventListener('pointerenter', () => {
      if (drag) return
      inner.style.transform = 'scale(1.12)'
      halo.setAttribute('opacity', '0.5')
      label.style.fontWeight = '600'
    })
    outer.addEventListener('pointerleave', () => {
      if (drag && drag.node === node) return
      const visual = nodeVisual(focus, node.id)
      inner.style.transform = `scale(${focus.mode === 'none' ? 1 : visual.radiusFactor})`
      halo.setAttribute('opacity', isFocused(node.id) ? '0.55' : '0')
      label.style.fontWeight = '500'
    })

    return { outer, inner, halo, hit, circle, label, node }
  })

  // Layout springs scale with the canvas so a bigger frame spreads the graph instead of leaving a
  // small cluster in the middle of a large empty panel.
  const spread = RADIUS / 18
  const simulation = forceSimulation(nodes)
    .force(
      'link',
      forceLink(layoutLinks)
        .id((node) => node.id)
        .distance((link) => (158 - (link.strength ?? 3) * 9) * (0.85 + spread * 0.35))
        .strength(0.32),
    )
    .force('charge', forceManyBody().strength(-1600 * spread).distanceMax(760 * spread))
    .force('center', forceCenter(width / 2, HEIGHT / 2))
    .force('collide', forceCollide().radius(RADIUS + 26))
    .alphaDecay(0.045)

  let first = null
  let second = null
  let focus = computeFocus(nodes, edgeData, null)
  let fitted = false
  let drag = null

  function isFocused(id) {
    return id === focus.firstId || id === focus.secondId
  }

  function paint() {
    edges.forEach((edge, index) => {
      const source = edge.from
      const target = edge.to
      const visual = edgeVisual(focus, index)
      const line = lineEls[index]
      const x1 = screenX(source.x ?? 0)
      const y1 = screenY(source.y ?? 0)
      const x2 = screenX(target.x ?? 0)
      const y2 = screenY(target.y ?? 0)
      line.setAttribute('x1', String(x1))
      line.setAttribute('y1', String(y1))
      line.setAttribute('x2', String(x2))
      line.setAttribute('y2', String(y2))
      line.setAttribute('stroke-opacity', String(visual.opacity))
      line.setAttribute('stroke-width', String((1 + (edge.strength ?? 3) * 0.45) * visual.widthFactor))
      if (!reduceMotion) line.style.strokeDashoffset = '0'

      const flow = flowEls[index]
      flow.setAttribute('x1', String(x1))
      flow.setAttribute('y1', String(y1))
      flow.setAttribute('x2', String(x2))
      flow.setAttribute('y2', String(y2))
      flow.setAttribute('stroke-opacity', visual.highlighted ? '0.9' : '0')
      flow.style.animation =
        visual.highlighted && !reduceMotion ? 'cg-flow 1.15s linear infinite' : 'none'

      const label = labelEls[index]
      label.setAttribute('x', String((x1 + x2) / 2))
      label.setAttribute('y', String((y1 + y2) / 2 - 7))
      label.setAttribute('opacity', visual.highlighted ? '1' : '0')
    })

    nodes.forEach((node, index) => {
      const element = nodeEls[index]
      const visual = nodeVisual(focus, node.id)
      const selected = isFocused(node.id)
      element.outer.setAttribute(
        'transform',
        `translate(${screenX(node.x ?? 0)}, ${screenY(node.y ?? 0)})`,
      )
      element.outer.style.opacity = String(visual.opacity)
      if (!drag || drag.node !== node) {
        element.inner.style.transform = `scale(${focus.mode === 'none' ? 1 : visual.radiusFactor})`
      }
      const tintCategory = dominant.get(node.id)?.category ?? 'other'
      const hitTint = COLOR[tintCategory]
      element.circle.setAttribute('fill', `url(#cg-grad-${tintCategory})`)
      element.circle.setAttribute('stroke', selected ? '#ffffff' : hexToRgba(hitTint, 0.5))
      element.circle.setAttribute('stroke-width', selected ? '2.5' : '1.4')
      element.circle.style.filter = selected
        ? `drop-shadow(0 0 18px ${hexToRgba(hitTint, 0.9)})`
        : 'drop-shadow(0 6px 12px rgba(0, 0, 0, 0.45))'
      element.halo.setAttribute('opacity', selected ? '0.55' : '0')
      element.halo.classList.toggle('cg-halo--on', selected && !reduceMotion)
      element.label.setAttribute('y', String(RADIUS * (focus.mode === 'none' ? 1 : visual.radiusFactor) + 22))
      element.label.style.opacity = visual.opacity > 0.5 ? '1' : '0.45'
    })
  }

  function pulse(id) {
    if (reduceMotion) return
    const node = nodesById.get(id)
    // A deep link calls select() before the first simulation tick, when positions do not exist
    // yet — a ring at (0,0) would be a stray circle in the corner of the canvas.
    if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    ring.setAttribute('class', 'cg-pulse')
    ring.setAttribute('cx', String(screenX(node.x ?? 0)))
    ring.setAttribute('cy', String(screenY(node.y ?? 0)))
    ring.setAttribute('r', '18')
    ring.setAttribute('fill', 'none')
    ring.setAttribute('stroke', '#5b8def')
    ring.addEventListener('animationend', () => ring.remove())
    nodeLayer.appendChild(ring)
  }

  function paintEvidence() {
    evidenceRoot.innerHTML = ''
    const hint = document.createElement('p')
    hint.className = 'hint'
    evidenceRoot.appendChild(hint)

    const nameOf = (id) => nodesById.get(id)?.name ?? id

    if (!first) {
      hint.textContent = '先点一个人物看他的关系；再点第二个人物，看这两人之间的情节。按住可以拖动。'
      return
    }

    if (!second) {
      const relations = relationsOf(edgeData, nodesById, first)
      const people = [...new Set(relations.map((relation) => relation.otherName))]
      hint.textContent = `已选中 ${nameOf(first)}：与 ${people.length} 人有关系。再点第二个人物，看两人之间的情节。`
      const others = document.createElement('p')
      others.className = 'hint muted cg-row-in'
      others.textContent = `相关：${people.join('、') || '（没有直接关系）'}`
      evidenceRoot.appendChild(others)
      return
    }

    const relations = pairRelations(edgeData, first, second)
    hint.textContent = `${nameOf(first)} ↔ ${nameOf(second)}：${
      relations.length > 0 ? `${relations.length} 段原文证据（按叙事顺序）` : '原文中没有直接关系'
    }`

    if (relations.length === 0) {
      const note = document.createElement('p')
      note.className = 'hint muted cg-row-in'
      note.textContent = '这两个人没有通过校验的直接关系。下面是从原文里检索到的共现片段（只检索，不判定关系）。'
      evidenceRoot.appendChild(note)
    }

    relations.forEach((relation, index) => {
      const row = document.createElement('div')
      row.className = 'row cg-row-in'
      row.style.animationDelay = `${index * 60}ms`
      const color = COLOR[categoryOf(relation.relation)]
      row.style.borderLeftColor = color
      const head = document.createElement('div')
      head.innerHTML =
        `<strong>${escapeHtml(nameOf(first))} ↔ ${escapeHtml(nameOf(second))}</strong> ` +
        `<span class="tag" style="color:${color};background:${hexToRgba(color, 0.14)}">${escapeHtml(relation.relation)}</span> ` +
        `<span class="muted">强度 ${relation.strength} · 位置 ${relation.charStart}</span>`
      const quote = document.createElement('div')
      quote.className = 'quote'
      quote.textContent = relation.evidence
      row.append(head, quote)
      evidenceRoot.appendChild(row)
    })

    // Retrieval is a different claim from extraction: these are passages where the two names appear
    // together, sliced verbatim from the source. They are labelled as such and never drawn as edges.
    if (retrievalEnabled) void renderRetrieval(nameOf(first), nameOf(second))
  }

  async function renderRetrieval(leftName, rightName) {
    const token = ++retrievalToken
    const section = document.createElement('section')
    section.className = 'cg-retrieval cg-row-in'
    const title = document.createElement('p')
    title.className = 'hint'
    title.textContent = `正在检索 ${leftName} 与 ${rightName} 在原文里的共现片段…`
    section.appendChild(title)
    evidenceRoot.appendChild(section)

    try {
      const params = new URLSearchParams({ a: leftName, b: rightName })
      if (currentRunId) params.set('run', currentRunId)
      const response = await fetch(`/api/pair?${params}`)
      const payload = await response.json()
      if (token !== retrievalToken) return
      section.innerHTML = ''

      if (payload.error) {
        title.textContent = `检索失败：${payload.error}`
        section.appendChild(title)
        return
      }
      if (!payload.passages || payload.passages.length === 0) {
        title.textContent = payload.note ?? '原文里没有找到两人共现的片段（可能分处不同的段落）。'
        section.appendChild(title)
        return
      }

      const chunkCount = new Set(payload.passages.map((passage) => passage.chunkIndex)).size
      title.textContent =
        `原文检索：${payload.passages.length} 段共现片段（分布在 ${chunkCount} 个分块，检索结果，未经关系判定）`
      section.appendChild(title)
      payload.passages.forEach((passage, index) => {
        const row = document.createElement('div')
        row.className = 'row cg-row-in'
        row.style.borderLeftColor = '#4a5a78'
        row.style.animationDelay = `${index * 50}ms`
        const head = document.createElement('div')
        head.className = 'muted'
        head.textContent = `块 #${passage.chunkIndex} · 位置 ${passage.charStart} · 两人相距 ${passage.distance} 字`
        const quote = document.createElement('div')
        quote.className = 'quote'
        quote.textContent = passage.snippet
        row.append(head, quote)
        section.appendChild(row)
      })
    } catch (error) {
      if (token !== retrievalToken) return
      section.innerHTML = ''
      title.textContent = `检索失败：${error.message}`
      section.appendChild(title)
    }
  }

  /**
   * Two clicks, two questions. First click focuses one person; the second announces "these two";
   * clicking the partner again drops back to the single focus, clicking the anchored person (or
   * the background, or Esc) clears everything, and clicking a third person re-pairs with the
   * anchored one.
   */
  function pick(id) {
    if (!first) {
      first = id
      second = null
    } else if (!second) {
      if (id === first) {
        first = null
      } else {
        second = id
      }
    } else if (id === first) {
      first = null
      second = null
    } else if (id === second) {
      second = null
    } else {
      second = id
    }
    pulse(id)
    focus = computeFocus(nodes, edgeData, first, second)
    paint()
    paintEvidence()
    // The graph is tall now, so the plot list it just produced is usually below the fold. Bring it
    // into view on the second click (only when it is actually off-screen, and never in snapshot mode
    // where a scroll would move the frame being captured).
    if (second && !reduceMotion) {
      const rect = evidenceRoot.getBoundingClientRect()
      if (rect.top > window.innerHeight * 0.75) {
        evidenceRoot.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }
  }

  function clearSelection() {
    first = null
    second = null
    focus = computeFocus(nodes, edgeData, null)
    paint()
    paintEvidence()
  }

  /** Screen pixels → simulation coordinates (drag targets live in simulation space). */
  function toGraphPoint(event) {
    const point = svg.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const matrix = svg.getScreenCTM()
    if (!matrix) return { x: event.clientX, y: event.clientY }
    const mapped = point.matrixTransform(matrix.inverse())
    return {
      x: fit.cx + (mapped.x - width / 2) / fit.sx,
      y: fit.cy + (mapped.y - bandCenterY) / fit.sy,
    }
  }

  /**
   * Fit the settled layout into the panel by stretching it — not by cropping.
   *
   * A cropped view box can only fill one dimension: on a wide panel the network would keep the same
   * fraction of the area no matter how big the panel was (which is exactly the complaint this fixes).
   * Here the blob is scaled on both axes to fill the frame, with the ratio bounded at 1.6:1 so the
   * graph never turns into a ribbon; labels and circles keep their size because only positions map.
   */
  function fitToView() {
    if (nodes.length === 0) return
    const xs = nodes.map((node) => node.x ?? 0)
    const ys = nodes.map((node) => node.y ?? 0)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    // The margins below already reserve room for the circles and the names, so the *centre* span is
    // what gets stretched to the full inner rect — otherwise the radii would be counted twice and
    // the graph would stop ~9% short of the edge on every side.
    const spanX = Math.max(1, maxX - minX)
    const spanY = Math.max(1, maxY - minY)
    const targetW = Math.max(1, width - (RADIUS + 10) * 2)
    const targetH = Math.max(1, bandBottom - bandTop)
    let sx = targetW / spanX
    let sy = targetH / spanY

    const distortion = sx / sy
    if (distortion > 1.6) sx = sy * 1.6
    else if (distortion < 1 / 1.6) sy = sx * 1.6
    // A three-node graph should not be flung to the corners of a 1100px canvas either.
    const cap = 3.4
    sx = Math.min(sx, cap)
    sy = Math.min(sy, cap)

    fit = { sx, sy, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
    svg.dataset.fit = JSON.stringify({ sx: +sx.toFixed(3), sy: +sy.toFixed(3), spanX: Math.round(spanX), spanY: Math.round(spanY), targetW: Math.round(targetW), targetH: Math.round(targetH), width, HEIGHT })
    paint()
  }

  let blankPress = false

  svg.addEventListener('pointerdown', (event) => {
    const hit = nodeEls.find((element) =>
      element.outer === event.target.closest('.cg-node'),
    )
    if (!hit) {
      // Empty canvas: remember it so pointerup can clear the selection. Doing this in a `click`
      // listener instead would race the selection made by pointerup — the click that follows a
      // node press targets the capturing <svg>, so it would immediately undo the selection.
      blankPress = true
      return
    }
    const node = hit.node
    event.stopPropagation()
    node.fx = node.x
    node.fy = node.y
    simulation.alphaTarget(0.22).restart()
    drag = { node, moved: false }
    hit.outer.style.cursor = 'grabbing'
    hit.inner.style.transform = 'scale(1.08)'
    svg.setPointerCapture(event.pointerId)
  })

  svg.addEventListener('pointermove', (event) => {
    if (!drag) return
    const point = toGraphPoint(event)
    if (Math.abs(point.x - drag.node.x) > 3 || Math.abs(point.y - drag.node.y) > 3) drag.moved = true
    drag.node.fx = point.x
    drag.node.fy = point.y
  })

  svg.addEventListener('pointerup', (event) => {
    if (blankPress) {
      blankPress = false
      clearSelection()
      return
    }
    if (!drag) return
    const { node, moved } = drag
    drag = null
    simulation.alphaTarget(0.012)
    node.fx = null
    node.fy = null
    const element = nodeEls.find((candidate) => candidate.node === node)
    if (element) element.outer.style.cursor = 'grab'
    if (!moved) pick(node.id)
    paint()
    try {
      svg.releasePointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
  })

  const onKeyDown = (event) => {
    if (event.key === 'Escape') clearSelection()
  }
  window.addEventListener('keydown', onKeyDown)

  simulation.on('tick', paint)

  // Force the browser to compute the "before" styles (opacity 0, scale .6, dash fully offset) so
  // the first paint runs a real transition instead of collapsing both states into one frame.
  void svg.getBoundingClientRect()

  /**
   * Settle synchronously instead of animating for four seconds.
   *
   * The layout is a pure function of the forces, so ticking it here gives the fit an *exact*
   * bounding box. The previous version fitted at "simulation end" and then let the layout keep
   * drifting, which made the fitted area depend on how far the settle happened to have progressed
   * when the fit ran — the graph then covered an unpredictable share of the panel.
   */
  simulation.stop()
  for (let i = 0; i < 320; i += 1) simulation.tick()
  fitted = true
  fitToView()

  paint()
  paintEvidence()
  renderLegend(graphRoot)

  // Keep the layout alive instead of freezing it: a barely-there drift makes the graph read as a
  // living map rather than a diagram that stopped. The fit map is fixed, so the drift never changes
  // how much of the panel the graph covers.
  if (!reduceMotion) simulation.alphaTarget(0.008).restart()

  return {
    destroy() {
      window.removeEventListener('keydown', onKeyDown)
      simulation.stop()
      graphRoot.innerHTML = ''
      evidenceRoot.innerHTML = ''
    },
    /** Programmatic selection, used by the `?pair=a,b` deep link. */
    select(firstId, secondId = null) {
      first = firstId && nodesById.has(firstId) ? firstId : null
      second = secondId && nodesById.has(secondId) ? secondId : null
      focus = computeFocus(nodes, edgeData, first, second)
      if (first) pulse(first)
      paint()
      paintEvidence()
    },
  }
}

function renderLegend(graphRoot) {
  const existing = document.getElementById('cg-legend')
  if (existing) existing.remove()
  const legend = document.createElement('div')
  legend.id = 'cg-legend'
  legend.className = 'cg-legend'
  for (const [key, label] of Object.entries(CATEGORY_LABEL)) {
    const item = document.createElement('span')
    const swatch = document.createElement('i')
    swatch.style.background = COLOR[key]
    swatch.style.color = COLOR[key]
    item.append(swatch, document.createTextNode(label))
    legend.appendChild(item)
  }
  // The legend belongs to the graph, so it sits directly under it — the page opens with the paste
  // box and the graph, and everything explanatory comes after.
  const slot = document.getElementById('legend-slot')
  if (slot) slot.appendChild(legend)
  else graphRoot.parentNode.insertBefore(legend, graphRoot)
}

function hexToRgba(hex, alpha) {
  const value = hex.replace('#', '')
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Mix a colour toward white — the highlight stop of a node's radial gradient. */
function mixWithWhite(hex, amount) {
  const value = hex.replace('#', '')
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16))
  const mixed = channels.map((channel) => Math.round(channel + (255 - channel) * amount))
  return `rgb(${mixed.join(', ')})`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])
}

/* ── bootstrap ──────────────────────────────────────────────────────────────────────────── */

const graphRoot = document.getElementById('graph')
const evidenceRoot = document.getElementById('evidence')
const params = new URLSearchParams(location.search)
const snapshotMode = params.get('still') === '1'
if (snapshotMode) document.documentElement.classList.add('cg-no-motion')
let current = null
/** The run directory the page is looking at — /api/pair needs it to find the source text. */
let currentRunId = params.get('run') ?? null

const MODE_LABEL = { single: '单次调用', chunk: '分块', rag: '检索式 RAG' }

function show(data) {
  if (current) current.destroy()
  current = mountGraph(data, graphRoot, evidenceRoot)
  if (data.runId) currentRunId = data.runId
  renderHeadline(data)
  renderStats(data)
  const pairParam = new URLSearchParams(location.search).get('pair')
  if (pairParam) {
    const [a, b] = pairParam.split(',').map((value) => value.trim())
    current.select(a, b)
  }
}

function renderHeadline(data) {
  const statsEl = document.getElementById('stats')
  if (!statsEl) return
  const stats = data.stats ?? {}
  const size = stats.chars ? `（${stats.chars.toLocaleString('en-US')} 字）` : ''
  const mode = MODE_LABEL[stats.mode ?? data.mode] ?? ''
  statsEl.textContent =
    `${stats.nodes ?? data.nodes.length} 个角色 · ${stats.edges ?? data.edges.length} 条关系 · ` +
    `${data.source?.name ?? '文本'}${size}${mode ? ` · ${mode}` : ''}`
}

const fmt = (value) => (typeof value === 'number' ? value.toLocaleString('en-US') : '—')
const pct = (value) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : '—')

const REASON_TEXT = {
  'evidence-not-in-source': '原文里找不到',
  'evidence-too-short': '证据太短',
  'too-many-edges-for-pair': '同一对人物证据过多',
  'duplicate-evidence': '重叠窗口的重复证据',
  'pair-cap': '同一对人物证据超过上限',
  'self-after-merge': '别名合并后指向自己',
  'node-unmapped': '人物未映射',
}

/**
 * The numbers that make the run checkable: what was read, what it cost, and — most importantly —
 * how many of the model's proposed edges failed the verbatim check, broken down by reason.
 */
function renderStats(data) {
  const panel = document.getElementById('run-stats')
  if (!panel) return
  panel.innerHTML = ''
  const stats = data.stats ?? {}
  const add = (label, value, tone) => {
    const cell = document.createElement('div')
    cell.className = 'cg-metric'
    const key = document.createElement('div')
    key.className = 'cg-metric-key'
    key.textContent = label
    const val = document.createElement('div')
    val.className = 'cg-metric-value'
    if (tone) val.style.color = tone
    val.textContent = value
    cell.append(key, val)
    panel.appendChild(cell)
  }

  const per10k = stats.per10k
  add('字数', fmt(stats.chars))
  add('分块 / 抽取', `${fmt(stats.chunks ?? 1)} / ${fmt(stats.chunksExtracted ?? 1)}`)
  add('模型调用', fmt(stats.calls ?? 1))
  add('输入 tokens', fmt(stats.tokens?.prompt ?? 0))
  add('输出 tokens', fmt(stats.tokens?.completion ?? 0))
  add('成本', typeof stats.costUsd === 'number' ? `$${stats.costUsd.toFixed(4)}` : '—')
  add('模型耗时', typeof stats.modelMs === 'number' ? `${(stats.modelMs / 1000).toFixed(1)}s` : '—')
  if (per10k) add('每万字', `$${(per10k.costUsd ?? 0).toFixed(4)} · ${per10k.seconds ?? 0}s`)
  add(
    '逐字证据通过率',
    pct(stats.evidencePassRate),
    (stats.evidencePassRate ?? 1) >= 0.99 ? 'var(--ok, #3fca8d)' : '#f0a35e',
  )
  add('丢弃', fmt(stats.dropped ?? 0), (stats.dropped ?? 0) > 0 ? '#f0a35e' : undefined)
  add('重锚', fmt(stats.repaired ?? 0))
  add('别名合并', fmt(stats.aliasMerges ?? 0))

  const notes = []
  if (stats.tokens?.estimated) {
    notes.push('tokens 为字符数估算（宿主半没有 usage 回传），CLI/本地服务的数字是接口实测值。')
  }
  if (stats.chunksReused > 0) {
    notes.push(
      `本次是断点续跑的合并：复用了 ${stats.chunksReused} 个已完成分块的中间产物，没有再调用模型（模型耗时合计 ${(
        (stats.modelMs ?? 0) / 1000
      ).toFixed(0)}s 是所有分块调用的总和）。`,
    )
  }
  if ((stats.chunksFailed ?? 0) > 0) {
    notes.push(`有 ${stats.chunksFailed} 个分块调用失败，当前图谱少这部分内容；加 --resume 可补跑。`)
  }
  if (stats.rag?.enabled) {
    notes.push(
      `检索式抽取：先扫 ${stats.rag.castSamples} 块得到 ${stats.rag.castSize} 个角色、${stats.rag.pairs} 组候选关系，` +
        `候选块 ${stats.rag.candidateBlocks}，实际精细抽取 ${stats.rag.selectedBlocks}，` +
        `跳过 ${stats.rag.skippedBlocks} 块` +
        (stats.rag.skippedByReason?.length
          ? `（${stats.rag.skippedByReason.map((item) => `${item.reason === 'too-few-characters' ? '不足两个角色' : item.reason === 'over-budget' ? '超出预算' : item.reason}×${item.count}`).join('，')}）`
          : '') +
        (typeof stats.rag.estimatedSavedUsd === 'number' && stats.rag.estimatedSavedUsd > 0
          ? `，估算省下 $${stats.rag.estimatedSavedUsd}`
          : ''),
    )
  }
  if ((stats.dropped ?? 0) > 0) {
    const reasons = (stats.droppedReasons ?? [])
      .map((item) => `${REASON_TEXT[item.reason] ?? item.reason} ${item.count} 条`)
      .join('、')
    notes.push(
      `被丢弃的 ${stats.dropped} 条边都计数在这里：${reasons || '（无明细）'}。` +
        '只有「原文里找不到 / 证据太短」是核对失败，其余是重复证据或每对人物的条数上限——证据本身都对过原文。',
    )
  }
  if (stats.aliasMerges > 0) {
    notes.push(
      `同一人物的不同称呼合并了 ${stats.aliasMerges} 次（例：「${data.nodes?.[0]?.name ?? ''}」的别名 ${(
        data.nodes?.[0]?.aliases ?? []
      ).join('、') || '—'}）；拿不准的称呼不会合并，${stats.suspects ?? 0} 组疑似同一人仍分开显示。`,
    )
  }

  if (notes.length > 0) {
    const list = document.createElement('ul')
    list.className = 'cg-notes'
    for (const note of notes) {
      const item = document.createElement('li')
      item.textContent = note
      list.appendChild(item)
    }
    panel.appendChild(list)
  }
}

/* ── run picker + extraction (jobs with progress) ────────────────────────────────────────── */

function isServed() {
  return location.protocol === 'http:' || location.protocol === 'https:'
}

async function wireRunPicker() {
  const select = document.getElementById('runs')
  if (!select || !isServed()) return
  try {
    const response = await fetch('/api/runs')
    const payload = await response.json()
    select.innerHTML = ''
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = `历史产物（${payload.runs.length}）`
    select.appendChild(placeholder)
    for (const run of payload.runs) {
      const option = document.createElement('option')
      option.value = run.id
      option.textContent =
        `${run.id} · ${(run.chars ?? 0).toLocaleString('en-US')} 字 · ` +
        `${run.nodes ?? '?'}人/${run.edges ?? '?'}边` +
        (run.costUsd ? ` · $${Number(run.costUsd).toFixed(3)}` : '')
      select.appendChild(option)
    }
    select.addEventListener('change', async () => {
      if (!select.value) return
      select.disabled = true
      try {
        const loaded = await fetch(`/api/runs/${encodeURIComponent(select.value)}`).then((r) => r.json())
        if (loaded.error) throw new Error(loaded.error)
        loaded.runId = select.value
        show(loaded)
        const status = document.getElementById('upload-status')
        if (status) status.textContent = `已载入 ${select.value}`
      } catch (error) {
        const status = document.getElementById('upload-status')
        if (status) status.textContent = `载入失败：${error.message}`
      } finally {
        select.disabled = false
      }
    })
  } catch {
    /* no run directory yet: nothing to pick */
  }
}

function setProgress(percent, label, detail = '') {
  const panel = document.getElementById('progress')
  if (!panel) return
  panel.hidden = false
  panel.querySelector('i').style.width = `${Math.max(0, Math.min(100, percent))}%`
  const text = panel.querySelector('#progress-label')
  if (text) text.textContent = label
  const sub = panel.querySelector('#progress-detail')
  if (sub) sub.textContent = detail
}

function hideProgressSoon() {
  setTimeout(() => {
    const panel = document.getElementById('progress')
    if (panel) panel.hidden = true
  }, 1600)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function submitJob(text) {
  const mode = document.getElementById('mode')?.value ?? 'auto'
  const budget = document.getElementById('budget')?.value
  const body = { text, mode }
  if (budget) body.maxBlocks = Number(budget)
  const response = await fetch('/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const job = await response.json()
  if (!response.ok || job.error) throw new Error(job.error ?? `HTTP ${response.status}`)
  return job
}

async function pollJob(id, onProgress) {
  for (;;) {
    const job = await fetch(`/api/jobs/${id}`).then((response) => response.json())
    if (job.error && !job.status) throw new Error(job.error)
    onProgress(job)
    if (job.status === 'done') return job
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.error ?? `任务 ${job.status}`)
    }
    await sleep(800)
  }
}

if (window.__GRAPH_DATA__) show(window.__GRAPH_DATA__)

void wireRunPicker()

function wireUploader() {
  const panel = document.getElementById('upload')
  if (!panel) return

  // A file:// page has no host to ask, and the browser cannot reach the model on its own.
  if (!isServed()) {
    panel.innerHTML =
      '<p class="hint">这是静态页面：要换文本，双击「角色关系网」由本地服务打开，或把 txt 路径发给助手。</p>'
    return
  }

  const form = panel.querySelector('form')
  const fileInput = panel.querySelector('input[type=file]')
  const textarea = panel.querySelector('textarea')
  const button = panel.querySelector('button[type=submit]')
  const status = panel.querySelector('#upload-status')

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    if (!file) return
    const text = await file.text()
    textarea.value = text
    const chars = text.length
    status.textContent =
      `已读入 ${file.name}：${chars.toLocaleString('en-US')} 字` +
      (chars > 20000 ? '（长文本，会分块抽取并显示进度）' : '')
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const text = textarea.value.trim()
    if (!text) {
      status.textContent = '先选一个 txt，或者把文本粘进来。'
      return
    }
    button.disabled = true
    status.textContent = `已提交 ${text.length.toLocaleString('en-US')} 字，正在排队…`
    try {
      const job = await submitJob(text)
      const done = await pollJob(job.id, (state) => {
        const progress = state.progress ?? { done: 0, total: 0 }
        const percent = progress.total > 0 ? (progress.done / progress.total) * 100 : 6
        const phaseText =
          state.phase === 'cast'
            ? '扫描角色表'
            : state.phase === 'planned'
              ? '规划要抽取的块'
              : state.phase === 'extract'
                ? '抽取中'
                : state.phase
        const tokens = state.usage ? ` · 输入 ${fmt(state.usage.prompt)} tokens` : ''
        setProgress(
          percent,
          `${phaseText} ${progress.done}/${progress.total || '?'} · ${state.elapsedSeconds}s${tokens}`,
          state.status === 'running' ? '长文本会按块推进，完成一块就能看到一块的计数。' : '',
        )
        status.textContent = `${phaseText}…`
      })
      if (!done.result) throw new Error('任务完成但没有返回图谱。')
      done.result.runId = done.id
      show(done.result)
      setProgress(100, '完成', `$${(done.stats?.costUsd ?? 0).toFixed(4)} · ${done.elapsedSeconds}s`)
      hideProgressSoon()
      const dropped = done.stats?.dropped ?? 0
      status.textContent =
        `完成：${done.stats.nodes} 个角色、${done.stats.edges} 条关系` +
        (dropped > 0 ? `，${dropped} 条被丢弃（原因见统计面板）` : '，全部证据通过原文核对')
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (error) {
      status.textContent = `失败：${error.message}`
      setProgress(0, '失败', error.message)
    } finally {
      button.disabled = false
    }
  })
}

wireUploader()
