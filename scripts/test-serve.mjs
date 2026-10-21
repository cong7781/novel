/**
 * Exercise the companion server end to end with the built-in fixture, then leave the result in
 * out/latest-graph.json so the static page can be rebuilt from it.
 *
 * Usage: node scripts/test-serve.mjs [http://127.0.0.1:19401] [fixture path]
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import { RELATION_LABELS } from '../lib/extract.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const base = process.argv[2] ?? 'http://127.0.0.1:19401'
const fixturePath = resolve(ROOT, process.argv[3] ?? 'fixtures/sample.txt')

// The server extracts from the normalised text (CRLF → LF), and evidence is sliced from exactly
// that text, so the verbatim assertion has to look at the same normalised string.
const text = (await readFile(fixturePath, 'utf8')).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
console.log(`posting ${text.length} chars to ${base}/api/extract`)

const started = Date.now()
const response = await fetch(`${base}/api/extract`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text }),
  signal: AbortSignal.timeout(600000),
})
const payload = await response.json()
const seconds = Math.round((Date.now() - started) / 1000)

if (!response.ok || payload.error) {
  console.error(`FAILED after ${seconds}s: ${payload.error ?? response.status}`)
  process.exit(1)
}

assert.ok(Array.isArray(payload.nodes) && payload.nodes.length >= 5, 'at least 5 characters')
assert.ok(Array.isArray(payload.edges) && payload.edges.length >= 5, 'at least 5 relations')
for (const edge of payload.edges) {
  assert.ok(edge.evidence && edge.evidence.length > 0, 'every edge carries evidence')
  assert.ok(RELATION_LABELS.includes(edge.relation), `relation ${edge.relation} is in the vocabulary`)
  assert.equal(
    text.slice(edge.charStart, edge.charStart + edge.evidence.length),
    edge.evidence,
    'evidence is verbatim from the source, at the recorded offset',
  )
}

const out = resolve(ROOT, 'out/latest-graph.json')
await writeFile(out, JSON.stringify(payload, null, 2), 'utf8')

console.log(`ok in ${seconds}s: ${payload.stats.nodes} characters, ${payload.stats.edges} relations`)
console.log(
  `  chunks=${payload.stats.chunks ?? 1} calls=${payload.stats.calls ?? 1} ` +
    `dropped=${payload.stats.dropped} repaired=${payload.stats.repaired} ` +
    `passRate=${Math.round((payload.stats.evidencePassRate ?? 1) * 100)}%`,
)
for (const edge of payload.edges.slice(0, 8)) {
  const from = payload.nodes.find((node) => node.id === edge.source)?.name ?? edge.source
  const to = payload.nodes.find((node) => node.id === edge.target)?.name ?? edge.target
  console.log(`  ${from} —[${edge.relation}]→ ${to}  强度${edge.strength}  ${edge.evidence.slice(0, 28)}…`)
}
console.log(`wrote ${out}`)
