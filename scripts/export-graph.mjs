/**
 * Pull the most recent graph meta out of a session log and write it as JSON.
 *
 * Usage: node scripts/export-graph.mjs <session.v4.jsonl.zstd> <out.json>
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { dirname } from 'node:path'

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
      /* live tail */
    }
  }
  return chunks.join('\n')
}

const [logPath, outPath] = process.argv.slice(2)
if (!logPath || !outPath) {
  console.error('usage: node scripts/export-graph.mjs <session.v4.jsonl.zstd> <out.json>')
  process.exit(2)
}

const text = readLog(logPath)
let latest = null

for (const line of text.split('\n')) {
  if (!line.startsWith('{') || !line.includes('"meta"')) continue
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  const meta = (event.data ?? event).meta
  if (!meta || !Array.isArray(meta.nodes) || !Array.isArray(meta.edges)) continue
  if (meta.nodes.length === 0) continue
  latest = meta
}

if (!latest) {
  console.error('no graph meta found in that session log')
  process.exit(1)
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(latest, null, 2), 'utf8')
console.log(`wrote ${outPath}: ${latest.nodes.length} nodes, ${latest.edges.length} edges, ${latest.stats?.chars} chars`)
