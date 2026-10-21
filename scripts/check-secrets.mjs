/**
 * Fail if any commit in this repository contains a credential-shaped string.
 *
 * Run before publishing (and in CI) so a key that once slipped into a file cannot be pushed back
 * out silently: it reads the object database, so it covers every commit, not just the working tree.
 *
 *   node scripts/check-secrets.mjs
 *
 * Exits 1 on a hit. Only the first 6 characters of a match are ever printed.
 */
import { execFileSync } from 'node:child_process'

const PATTERNS = [
  { name: 'deepseek-style key', re: /sk-[A-Za-z0-9]{16,}/g },
  { name: 'env assignment', re: /DEEPSEEK_API_KEY["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/g },
  { name: 'bearer token', re: /Bearer\s+[A-Za-z0-9._-]{24,}/g },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'github token', re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'quoted secret', re: /(?:api[_-]?key|secret)["']?\s*[:=]\s*["'][A-Za-z0-9_-]{24,}["']/gi },
]

const objects = execFileSync('git', ['rev-list', '--all', '--objects'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const space = line.indexOf(' ')
    return { sha: line.slice(0, space), path: line.slice(space + 1) || '(commit)' }
  })

const batch = execFileSync('git', ['cat-file', '--batch'], {
  input: objects.map((entry) => entry.sha).join('\n'),
  maxBuffer: 512 * 1024 * 1024,
})

const findings = []
let offset = 0
let index = 0
while (offset < batch.length && index < objects.length) {
  const newline = batch.indexOf(0x0a, offset)
  const header = batch.subarray(offset, newline).toString('utf8')
  const size = Number(header.split(' ')[2])
  const start = newline + 1
  if (!Number.isFinite(size)) break
  const content = batch.subarray(start, start + size)
  offset = start + size + 1
  const entry = objects[index]
  index += 1
  if (size === 0) continue

  // Binary blobs are read as latin1 so a stray ASCII token is still caught.
  const text = content.toString('latin1')
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0
    const match = pattern.re.exec(text)
    if (match) {
      findings.push({
        path: entry.path,
        commit: entry.sha.slice(0, 8),
        pattern: pattern.name,
        preview: `${match[0].slice(0, 6)}…(${match[0].length} chars)`,
      })
    }
  }
}

console.log(`scanned ${objects.length} objects across all commits`)
if (findings.length === 0) {
  console.log('no credential-shaped strings found')
} else {
  for (const finding of findings) console.log('FOUND', JSON.stringify(finding))
  console.error('refusing to publish: remove the secret, rotate it, and rewrite history if it is already pushed')
  process.exit(1)
}
