/**
 * Headless assertions for the selection behaviour and the evidence gate.
 * Run with: node scripts/test-host.mjs && node scripts/test-highlight.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { RELATION_LABELS, SYSTEM_PROMPT, buildPrompt, normalizeRelation, parseModelJson, summarize, verifyAndBind } from '../lib/extract.js'

const fixture = readFileSync(fileURLToPath(new URL('../fixtures/sample.txt', import.meta.url)), 'utf8')

const reply = JSON.stringify({
  nodes: [
    { id: 'n1', name: '沈砚' },
    { id: 'n2', name: '沈鹤年' },
    { id: 'n3', name: '苏晚' },
    { id: 'n4', name: '周砚秋' },
    { id: 'n5', name: '柳氏' },
  ],
  edges: [
    {
      // verbatim quote
      source: 'n1',
      target: 'n2',
      relation: '父子',
      evidence: '沈砚用指背试了试碗壁的温度，才把碗递过去，说，爹，这帖药要趁热喝，凉了伤胃。',
      strength: 5,
    },
    {
      // paraphrase: must be re-anchored onto the real span, not kept as written
      source: 'n3',
      target: 'n2',
      relation: '养父女',
      evidence: '沈鹤年却抓住了苏晚的手腕，说，晚娘，照看好他。',
      strength: 4,
    },
    {
      // fabricated: must be dropped
      source: 'n4',
      target: 'n1',
      evidence: '周砚秋在雪夜里跪了三天三夜，只求沈砚把祖传方子烧掉。',
      strength: 2,
    },
    {
      // unknown node id: must be dropped at parse time
      source: 'n9',
      target: 'n1',
      evidence: '沈砚说，铺子里还有我。',
      strength: 3,
    },
    {
      // self loop: must be dropped at parse time
      source: 'n1',
      target: 'n1',
      evidence: '沈砚说，铺子里还有我。',
      strength: 3,
    },
    {
      // same pair, different real quote: kept (narrative beats are the point)
      source: 'n2',
      target: 'n1',
      evidence: '这句话他今年说了四遍。沈砚应了四遍，每次应完都要到廊下去站一会儿，看着檐水一笔一笔地把石阶画出黑线。',
      strength: 5,
    },
    {
      // duplicate of an already-kept span for the same pair: deduped
      source: 'n1',
      target: 'n2',
      evidence: '这句话他今年说了四遍。沈砚应了四遍，每次应完都要到廊下去站一会儿，看着檐水一笔一笔地把石阶画出黑线。',
      strength: 5,
    },
  ],
})

const parsed = parseModelJson(`模型说：\n\`\`\`json\n${reply}\n\`\`\`\n以上。`)
assert.equal(parsed.nodes.length, 5, 'nodes parsed')
assert.equal(parsed.edges.length, 5, 'self-loop and unknown-id edges dropped during parse')

const bound = verifyAndBind(fixture, parsed)

assert.equal(bound.edges.length, 3, 'three evidence-backed edges survive')
assert.ok(bound.stats.dropped >= 1, 'the fabricated edge is counted as dropped')

const fabricated = bound.edges.find((edge) => edge.source === 'n4')
assert.equal(fabricated, undefined, 'fabricated relation never reaches the graph')

for (const edge of bound.edges) {
  assert.ok(edge.evidence.length > 0, 'every kept edge carries evidence')
  assert.equal(fixture.slice(edge.charStart, edge.charStart + edge.evidence.length), edge.evidence, 'evidence is an exact slice of the source')
  assert.ok(Number.isInteger(edge.strength) && edge.strength >= 1 && edge.strength <= 5, 'strength is a 1..5 integer')
}

const paraphrased = bound.edges.find((edge) => edge.source === 'n3' || edge.target === 'n3')
assert.ok(paraphrased, 'the paraphrased quote was re-anchored rather than dropped')
assert.equal(paraphrased.repaired, true, 'the re-anchored edge is marked repaired')
assert.ok(fixture.includes(paraphrased.evidence), 'the repaired evidence exists verbatim in the source')

const narrativeOrder = bound.edges.map((edge) => edge.charStart)
assert.deepEqual(narrativeOrder, [...narrativeOrder].sort((a, b) => a - b), 'edges are in narrative order')

const summary = summarize(bound.stats)
assert.ok(summary.includes('条关系'), 'summary mentions edges')
assert.ok(summary.includes('丢弃'), 'summary is honest about dropped edges')

const prompt = buildPrompt(fixture)
assert.ok(prompt.includes(fixture), 'the prompt carries the whole text')
assert.ok(prompt.length > fixture.length, 'the prompt wraps the text with instructions')

// ── relation vocabulary ──────────────────────────────────────────────────────────────────
assert.equal(normalizeRelation('父子'), '亲子', 'a concrete kinship word collapses to 亲子')
assert.equal(normalizeRelation('老师'), '师徒', 'a phrasal synonym maps onto its canonical label')
assert.equal(normalizeRelation('仇人'), '敌对')
assert.equal(normalizeRelation(''), '其他', 'a missing relation is honest, not invented')
assert.equal(normalizeRelation('他觉得这人不错'), '其他', 'free-form prose never leaks into the label set')
assert.ok(normalizeRelation('养父女') !== undefined)
for (const edge of bound.edges) {
  assert.ok(RELATION_LABELS.includes(edge.relation), `edge relation ${edge.relation} stays inside the vocabulary`)
}
assert.equal(bound.edges.find((edge) => edge.source === 'n1' || edge.target === 'n1')?.relation !== undefined, true)
assert.ok(SYSTEM_PROMPT.includes('关系类型'), 'the system prompt asks for the relation type')
for (const label of RELATION_LABELS) {
  assert.ok(SYSTEM_PROMPT.includes(label), `the closed vocabulary lists ${label}`)
}

console.log('host ok')
console.log(
  `  nodes=${bound.nodes.length} edges=${bound.edges.length} verified=${bound.stats.verified} repaired=${bound.stats.repaired} dropped=${bound.stats.dropped}`,
)
console.log(`  ${summary}`)

// ── the tool definition itself, driven through a fake Cordis ctx ────────────────────────────
// The host half cannot be exercised inside DSH from a script, so it is registered against a stub
// ctx here: this catches import errors, schema drift, and the presentationMeta contract.
{
  const { apply } = await import('../lib/index.js')
  const registered = []
  const ctx = {
    effect: (factory) => factory(),
    tools: { register: (tool) => (registered.push(tool), () => {}) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    llm: {
      stream() {
        return (async function* gen() {
          yield { type: 'text-delta', text: reply }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }

  apply(ctx)
  assert.equal(registered.length, 1, 'one tool is registered')
  const tool = registered[0]
  assert.equal(tool.name, 'extract_characters')
  assert.ok(tool.output?.schema && typeof tool.output.render === 'function', 'output contract is declared')

  const normalizedFixture = fixture.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  const value = await tool.execute({ text: fixture }, { signal: undefined })
  assert.equal(value.source.chars, normalizedFixture.length, 'the tool normalises line endings before extracting')
  assert.ok(value.nodes.length >= 1, 'the fake model still produces a graph')
  assert.ok(value.stats.chunks > 1, 'an 8.8k text is chunked in the host tool too')
  assert.equal(value.stats.mode, 'chunk', '8k–50k defaults to plain chunking; retrieval starts above 50k')
  for (const edge of value.edges) {
    assert.equal(
      normalizedFixture.slice(edge.charStart, edge.charStart + edge.evidence.length),
      edge.evidence,
      'host-tool evidence is an exact slice of the normalised text',
    )
  }
  const meta = tool.output.presentationMeta({}, value)
  assert.equal(meta.v, 2, 'the card gets contract version 2')
  assert.deepEqual(Object.keys(meta).sort(), ['edges', 'nodes', 'source', 'stats', 'v'])
  assert.ok(tool.output.render({}, value)[0].text.includes('条关系'), 'the model-facing summary stays short')
}
