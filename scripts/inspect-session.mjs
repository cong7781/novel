/**
 * Prove what the tool durably persisted, straight from the session log.
 *
 * The log is a sequence of zstd frames (one per append), so a single decompress call only
 * yields the header. This walks every frame, then reports the `tool/result` event's `meta` —
 * the exact payload the browser card draws.
 *
 * Usage: node scripts/inspect-session.mjs <session.v4.jsonl.zstd>
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function readLog(path) {
  const raw = readFileSync(path)
  const offsets = []
  for (let i = 0; i < raw.length - 3; i += 1) {
    if (
      raw[i] === ZSTD_MAGIC[0] &&
      raw[i + 1] === ZSTD_MAGIC[1] &&
      raw[i + 2] === ZSTD_MAGIC[2] &&
      raw[i + 3] === ZSTD_MAGIC[3]
    ) {
      offsets.push(i)
      i += 3
    }
  }
  if (offsets.length === 0) return raw.toString('utf8')
  const chunks = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : raw.length
    try {
      chunks.push(zstdDecompressSync(raw.subarray(start, end)).toString('utf8'))
    } catch {
      /* a partial tail frame is normal while the session is live */
    }
  }
  return chunks.join('\n')
}

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/inspect-session.mjs <session.v4.jsonl.zstd>')
  process.exit(2)
}

const text = readLog(path)
const events = []
for (const line of text.split('\n')) {
  if (!line.startsWith('{')) continue
  try {
    events.push(JSON.parse(line))
  } catch {
    /* ignore malformed lines */
  }
}

console.log(`events: ${events.length}`)

let reported = 0
for (const event of events) {
  const blob = event.data ?? event
  if (!blob || typeof blob !== 'object') continue
  const meta = blob.meta
  if (!meta || !Array.isArray(meta.nodes) || !Array.isArray(meta.edges)) continue

  reported += 1
  console.log(`\n[tool/result seq=${event.seq ?? '?'}] meta.version=${meta.v}`)
  console.log(`  nodes=${meta.nodes.length} edges=${meta.edges.length}`)
  console.log(`  stats=${JSON.stringify(meta.stats)}`)
  console.log(`  source=${JSON.stringify(meta.source)}`)
  for (const edge of meta.edges.slice(0, 4)) {
    console.log(`  ${edge.source}->${edge.target} strength=${edge.strength} @${edge.charStart}: ${edge.evidence.slice(0, 44)}…`)
  }
}

if (reported === 0) {
  console.log('no durable tool/result event carries a graph meta block')
  process.exit(1)
}
