/**
 * dsh-character-graph — browser half.
 *
 * Registers one Tool view for `extract_characters`. The graph comes from `block.meta`
 * (the tool's presentationMeta, persisted with the result), never from model-facing text.
 *
 * d3-force owns the layout only; React owns the DOM. Handing the SVG to d3-selection would
 * fight React for the same nodes on every replay/remount, and buys nothing here.
 */

import React from 'react'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
} from 'd3-force'

import { computeFocus, edgeVisual, nodeVisual, pairRelations, relationsOf } from './highlight.js'

const NODE_RADIUS = 15
const HEIGHT = 430
const ACCENT = '#5b8def'
const LINE = '#8a93a6'
const MUTED = 'rgba(139, 147, 164, 0.95)'

/** Drop reasons in the card's own words — "evidence" failures and merge bookkeeping are different. */
const REASON_TEXT = {
  'evidence-not-in-source': '原文里找不到',
  'evidence-too-short': '证据太短',
  'too-many-edges-for-pair': '同一对人物证据过多',
  'duplicate-evidence': '重叠窗口的重复证据',
  'pair-cap': '每对人物证据超过上限',
  'self-after-merge': '别名合并后指向自己',
  'node-unmapped': '人物未映射',
}

function reasonText(reason) {
  return REASON_TEXT[reason] ?? reason
}

const styles = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '4px 2px 2px',
    color: 'inherit',
    fontSize: '13px',
    lineHeight: 1.55,
  },
  head: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '12px',
    flexWrap: 'wrap',
  },
  title: { fontWeight: 600, fontSize: '13px' },
  stats: { color: MUTED, fontSize: '12px' },
  canvas: {
    width: '100%',
    borderRadius: '10px',
    background: 'rgba(139, 147, 164, 0.07)',
    overflow: 'hidden',
  },
  hint: { color: MUTED, fontSize: '12px' },
  warning: { color: 'rgba(206, 132, 66, 0.95)', fontSize: '12px' },
  notice: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '12px 14px',
    borderRadius: '10px',
    border: '1px solid rgba(139, 147, 164, 0.35)',
    color: 'inherit',
    fontSize: '13px',
    lineHeight: 1.6,
  },
  noticeTitle: { fontWeight: 600 },
  evidenceBox: { display: 'flex', flexDirection: 'column', gap: '8px' },
  evidenceRow: {
    borderLeft: `2px solid ${ACCENT}`,
    padding: '2px 0 2px 10px',
    fontSize: '12px',
  },
  evidenceMeta: { color: MUTED },
}

/** The only service this half needs: the slot registry. */
export const inject = ['slots']

export function apply(ctx) {
  const register = () => {
    const dispose = ctx.slots.register({ name: 'tool.call.toolview', key: 'extract_characters' }, View)
    return dispose
  }
  // `tool.call.toolview` is declared by the conversation UI entry, which may load after this
  // plugin. slots.inject waits for the declaration instead of throwing on registration.
  if (ctx.slots && typeof ctx.slots.inject === 'function') {
    ctx.effect(
      () =>
        ctx.slots.inject('tool.call.toolview', function* () {
          yield register()
        }),
      'dsh-character-graph:toolview',
    )
    return
  }

  ctx.effect(register, 'dsh-character-graph:toolview')
}

export function View(props) {
  const { phase, block } = props

  if (phase !== 'result') {
    return <Notice title="正在读文本" body="正在抽取人物、核对原文证据，稍等一下。" />
  }
  if (!block) {
    return <Notice title="没有拿到结果" body="这次调用没有产生可显示的结果，可以再调用一次。" />
  }
  if (block.isError) {
    return <Notice title="抽取失败" body={errorText(block) || '工具返回了错误，但没有给出原因。'} />
  }

  const meta = block.meta
  if (!meta || !Array.isArray(meta.nodes) || !Array.isArray(meta.edges)) {
    return (
      <Notice
        title="这次运行的图谱数据不可还原"
        body="图谱数据随工具结果一起保存；这次调用没有带上它（例如在代码模式里被嵌套调用）。请直接调用一次 extract_characters。"
      />
    )
  }
  if (meta.nodes.length === 0) {
    return <Notice title="没有抽到人物" body="这段文字里没有足够的双人互动。换一段叙事性更强的文本再试。" />
  }

  return <GraphPanel meta={meta} />
}

function GraphPanel({ meta }) {
  const nodes = meta.nodes
  const edges = meta.edges
  const stats = meta.stats ?? {}

  const [pair, setPair] = React.useState({ first: null, second: null })
  const [width, setWidth] = React.useState(640)
  const [, bump] = React.useReducer((value) => value + 1, 0)

  const boxRef = React.useRef(null)
  const svgRef = React.useRef(null)
  const simRef = React.useRef(null)
  const dragRef = React.useRef(null)
  const blankPressRef = React.useRef(false)

  const dataKey = React.useMemo(
    () => `${nodes.map((node) => node.id).join(',')}#${edges.length}`,
    [nodes, edges],
  )

  // Stable, simulation-owned copies. d3-force mutates them; React only reads.
  const model = React.useMemo(() => {
    const simNodes = nodes.map((node) => ({ id: node.id, name: node.name }))
    const simLinks = edges.map((edge, index) => ({
      index,
      source: edge.source,
      target: edge.target,
      strength: edge.strength ?? 3,
      evidence: edge.evidence,
    }))
    return { simNodes, simLinks }
  }, [dataKey])

  const nodesById = React.useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [dataKey],
  )
  const focus = React.useMemo(
    () => computeFocus(nodes, edges, pair.first, pair.second),
    [nodes, edges, pair],
  )

  React.useEffect(() => {
    const element = boxRef.current
    if (!element) return undefined
    const measure = () => {
      const next = Math.max(300, Math.round(element.clientWidth || 640))
      setWidth((current) => (Math.abs(current - next) > 2 ? next : current))
    }
    measure()
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      return () => observer.disconnect()
    }
    return undefined
  }, [])

  React.useEffect(() => {
    const simulation = forceSimulation(model.simNodes)
      .force(
        'link',
        forceLink(model.simLinks)
          .id((node) => node.id)
          .distance((link) => 118 - (link.strength ?? 3) * 7)
          .strength(0.35),
      )
      .force('charge', forceManyBody().strength(-360))
      .force('center', forceCenter(width / 2, HEIGHT / 2))
      .force('collide', forceCollide().radius(NODE_RADIUS + 20))
      .alphaDecay(0.05)

    simRef.current = simulation

    let frame = 0
    let scheduled = false
    const onTick = () => {
      if (scheduled) return
      scheduled = true
      frame = requestAnimationFrame(() => {
        scheduled = false
        bump()
      })
    }
    simulation.on('tick', onTick)

    return () => {
      simulation.on('tick', null)
      simulation.stop()
      if (frame) cancelAnimationFrame(frame)
      simRef.current = null
    }
  }, [model, width])

  const toLocal = React.useCallback((event) => {
    const svg = svgRef.current
    if (!svg) return [0, 0]
    const rect = svg.getBoundingClientRect()
    return [event.clientX - rect.left, event.clientY - rect.top]
  }, [])

  const onPointerDown = (event, node) => {
    event.stopPropagation()
    if (event.currentTarget.setPointerCapture) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        /* pointer capture is a nicety, not a requirement */
      }
    }
    node.fx = node.x
    node.fy = node.y
    if (simRef.current) simRef.current.alphaTarget(0.22).restart()
    dragRef.current = { node, moved: false }
  }

  const onPointerMove = (event) => {
    const drag = dragRef.current
    if (!drag) return
    const [x, y] = toLocal(event)
    if (Math.abs(x - drag.node.x) > 3 || Math.abs(y - drag.node.y) > 3) drag.moved = true
    drag.node.fx = x
    drag.node.fy = y
    if (simRef.current) {
      simRef.current.alpha(0.3)
    }
  }

  const onPointerUp = () => {
    if (blankPressRef.current) {
      blankPressRef.current = false
      setPair({ first: null, second: null })
      return
    }
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    if (simRef.current) simRef.current.alphaTarget(0)
    drag.node.fx = null
    drag.node.fy = null
    if (!drag.moved) pickCharacter(drag.node.id)
  }

  /**
   * Two clicks, two questions: the first focuses one person, the second announces "these two".
   * Clicking the partner again drops back to the single focus, clicking the anchored person (or
   * the background, or Esc) clears everything, and clicking a third person re-pairs with the
   * anchored one.
   */
  function pickCharacter(id) {
    setPair((current) => {
      const { first, second } = current
      if (!first) return { first: id, second: null }
      if (!second) return id === first ? { first: null, second: null } : { first, second: id }
      if (id === first) return { first: null, second: null }
      if (id === second) return { first, second: null }
      return { first, second: id }
    })
  }

  React.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setPair({ first: null, second: null })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const firstRelations = pair.first ? relationsOf(edges, nodesById, pair.first) : []
  const secondRelations = pair.first && pair.second ? pairRelations(edges, pair.first, pair.second) : []

  return (
    <div style={styles.panel}>
      <div style={styles.head}>
        <span style={styles.title}>角色关系网</span>
        <span style={styles.stats}>
          {stats.nodes ?? nodes.length} 个角色 · {stats.edges ?? edges.length} 条关系 ·{' '}
          {String(meta.source?.name ?? '文本')} {stats.chars ? `（${stats.chars} 字）` : ''}
          {stats.chunks > 1
            ? ` · ${stats.chunks} 块 / ${stats.calls ?? '?'} 次调用 / $${Number(stats.costUsd ?? 0).toFixed(3)}`
            : ''}
        </span>
      </div>

      {/* The gate is the point of this card, so its result is stated, not implied. Duplicates and the
          per-pair cap are not quote failures — saying they were would be a false accusation. */}
      {stats.dropped > 0 ? (
        <span style={styles.warning}>
          {stats.dropped} 条边被丢弃（
          {(stats.droppedReasons ?? []).map((item) => `${reasonText(item.reason)} ${item.count} 条`).join('、') ||
            '无明细'}
          ）；图上只画通过逐字校验的边。逐字证据通过率 {Math.round((stats.evidencePassRate ?? 1) * 100)}%。
        </span>
      ) : stats.chunks > 1 ? (
        <span style={styles.stats}>
          全部 {stats.edges ?? edges.length} 条边的证据都在原文里逐字核对通过（通过率{' '}
          {Math.round((stats.evidencePassRate ?? 1) * 100)}%）；{stats.chunks} 个分块合并，认出了{' '}
          {stats.aliasMerges ?? 0} 个重复称呼。
        </span>
      ) : null}

      <div ref={boxRef} style={styles.canvas}>
        <svg
          ref={svgRef}
          width={width}
          height={HEIGHT}
          role="img"
          aria-label="角色关系网，点击某个人物可以只看他的关系"
          style={{ display: 'block', touchAction: 'none', userSelect: 'none' }}
          onPointerDown={() => {
            // Background press: cleared on pointerup. A `click` handler would race the
            // selection pointerup just made, because the click targets the capturing <svg>.
            blankPressRef.current = true
          }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <g style={{ pointerEvents: 'none' }}>
            {model.simLinks.map((link) => {
              const source = link.source
              const target = link.target
              if (!source || !target || typeof source !== 'object' || typeof target !== 'object') {
                return null
              }
              const visual = edgeVisual(focus, link.index)
              return (
                <line
                  key={`e${link.index}`}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke={visual.highlighted ? ACCENT : LINE}
                  strokeWidth={(1 + (link.strength ?? 3) * 0.45) * visual.widthFactor}
                  strokeOpacity={visual.opacity}
                  strokeLinecap="round"
                />
              )
            })}
          </g>

          <g>
            {model.simNodes.map((node) => {
              const visual = nodeVisual(focus, node.id)
              const radius = NODE_RADIUS * visual.radiusFactor
              const isSelected = node.id === focus.firstId || node.id === focus.secondId
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x ?? 0}, ${node.y ?? 0})`}
                  opacity={visual.opacity}
                  style={{ cursor: 'pointer' }}
                  onPointerDown={(event) => onPointerDown(event, node)}
                >
                  <circle r={NODE_RADIUS + 10} fill="transparent" />
                  <circle
                    r={radius}
                    fill={isSelected || visual.emphasised ? ACCENT : 'rgba(139, 147, 164, 0.75)'}
                    fillOpacity={isSelected ? 0.95 : visual.emphasised ? 0.75 : 0.55}
                    stroke={isSelected ? ACCENT : 'rgba(255, 255, 255, 0.55)'}
                    strokeWidth={isSelected ? 2.5 : 1.5}
                  />
                  <text
                    y={radius + 13}
                    textAnchor="middle"
                    fontSize={11.5}
                    fill="currentColor"
                    fillOpacity={0.92}
                    style={{ pointerEvents: 'none' }}
                  >
                    {node.name}
                  </text>
                </g>
              )
            })}
          </g>
        </svg>
      </div>

      <div style={styles.hint}>
        {!pair.first
          ? '先点一个人物看他的关系；再点第二个人物，看这两人之间的情节。按住可以拖动。'
          : !pair.second
            ? `已选中 ${nodesById.get(pair.first)?.name ?? pair.first}：与 ${
                new Set(firstRelations.map((relation) => relation.otherId)).size
              } 人有关系。再点第二个人物。`
            : `${nodesById.get(pair.first)?.name ?? pair.first} ↔ ${
                nodesById.get(pair.second)?.name ?? pair.second
              }：${
                secondRelations.length > 0
                  ? `${secondRelations.length} 段原文证据（按叙事顺序）`
                  : '原文中没有直接关系'
              }`}
      </div>

      {pair.first && pair.second ? (
        secondRelations.length > 0 ? (
          <div style={styles.evidenceBox}>
            {secondRelations.slice(0, 8).map((relation, index) => (
              <div key={`${relation.charStart}-${index}`} style={styles.evidenceRow}>
                <div>
                  {nodesById.get(pair.first)?.name ?? pair.first} ↔{' '}
                  {nodesById.get(pair.second)?.name ?? pair.second}{' '}
                  <span style={styles.evidenceMeta}>（强度 {relation.strength}）</span>
                </div>
                <div style={styles.evidenceMeta}>{relation.evidence}</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={styles.evidenceMeta}>
            这两个人没有直接对话或直接往来的原文证据。共现但未直接互动的间接关系，留给下一期的语义检索。
          </div>
        )
      ) : null}
    </div>
  )
}

function Notice({ title, body }) {
  return (
    <div style={styles.notice}>
      <span style={styles.noticeTitle}>{title}</span>
      <span>{body}</span>
    </div>
  )
}

function errorText(block) {
  if (!Array.isArray(block.content)) return ''
  return block.content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
}
