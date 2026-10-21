/**
 * Print the tail of a DSH session log in a readable form: one line per event, with the
 * interesting part of each payload (message text, tool name, result size).
 *
 * The log is a sequence of zstd *frames* (one per append), so a single decompress only yields
 * the first frame — this walks every frame in the file.
 *
 * Usage: node scripts/session-tail.mjs <session.v4.jsonl.zstd> [count]
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

const [logPath, countArg] = process.argv.slice(2)
if (!logPath) {
  console.error('usage: node scripts/session-tail.mjs <session.v4.jsonl.zstd> [count]')
  process.exit(2)
}
const want = Number.parseInt(countArg ?? '40', 10)

const events = []
for (const line of readLog(logPath).split('\n')) {
  if (!line.startsWith('{')) continue
  try {
    events.push(JSON.parse(line))
  } catch {
    /* ignore malformed lines */
  }
}

const textOf = (value) => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
      .join('')
  }
  return ''
}

const oneLine = (text, max = 150) => {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed
}

console.log(`events: ${events.length}`)
for (const event of events.slice(-want)) {
  const type = event.type ?? event.kind ?? '?'
  const data = event.data ?? event

  if (type === 'user/message') {
    console.log(`\n[user] ${oneLine(textOf(data.content), 300)}`)
  } else if (type === 'assistant/message') {
    console.log(`[assistant] ${oneLine(textOf(data.content), 400)}`)
  } else if (type === 'tool/call') {
    console.log(`[tool] ${data.name} ${oneLine(data.arguments, 200)}`)
  } else if (type === 'tool/result') {
    const content = Array.isArray(data.content) ? textOf(data.content) : ''
    console.log(`[result${data.isError ? ' ERROR' : ''}] ${oneLine(content, 220)}`)
  } else if (type === 'turn/end') {
    console.log(`[turn end] ${JSON.stringify(event.reason ?? data.reason ?? '')}`)
  }
}
