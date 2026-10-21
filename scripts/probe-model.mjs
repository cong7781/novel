/**
 * Connectivity + latency probe for the DeepSeek endpoint.
 *
 * It reads the same credential the viewer server uses, calls the model with a trivial prompt and
 * with the full fixture, and prints only numbers: latency, prompt/completion tokens, chars/second.
 * The key itself is never printed and never leaves this process.
 *
 *   node scripts/probe-model.mjs            # tiny prompt, then the 8.8k fixture
 *   node scripts/probe-model.mjs --tiny     # tiny prompt only
 */

import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SYSTEM_PROMPT, buildPrompt } from '../lib/extract.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODEL = process.env.CHARACTER_GRAPH_MODEL ?? 'deepseek-chat'
const BASE_URL = process.env.CHARACTER_GRAPH_BASE ?? 'https://api.deepseek.com'

function apiKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim()
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const match = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(text)
  if (!match) throw new Error('no DEEPSEEK_API_KEY in credentials file')
  return match[1].trim()
}

async function call(label, system, user, maxTokens) {
  const started = Date.now()
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(300000),
  })
  const seconds = (Date.now() - started) / 1000
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`${label}: http ${response.status} ${body.slice(0, 300)}`)
  }
  const payload = await response.json()
  const reply = payload?.choices?.[0]?.message?.content ?? ''
  const usage = payload?.usage ?? {}
  const promptTokens = usage.prompt_tokens ?? 0
  const completionTokens = usage.completion_tokens ?? 0
  console.log(
    `${label}: ${seconds.toFixed(1)}s  prompt=${promptTokens} completion=${completionTokens} ` +
      `replyChars=${reply.length} finish=${payload?.choices?.[0]?.finish_reason}`,
  )
  if (process.argv.includes('--show')) console.log(`   reply head: ${JSON.stringify(reply.slice(0, 160))}`)
  return { seconds, promptTokens, completionTokens, reply }
}

const mode = process.argv[2] ?? ''
await call('tiny', '只回答一个数字。', '1+1=?（只输出数字）', 16)

if (mode !== '--tiny') {
  const fixture = await readFile(resolve(ROOT, 'fixtures/sample.txt'), 'utf8')
  const text = fixture.replace(/\r\n?/g, '\n')
  await call(`fixture(${text.length}字)`, SYSTEM_PROMPT, buildPrompt(text), 8192)
}
