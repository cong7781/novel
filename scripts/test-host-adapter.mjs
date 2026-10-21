/**
 * The host adapter's two rules, asserted against fake streams.
 *
 * A thinking model answers a cheap call with reasoning first. If the budget is too small, the reply
 * arrives as an empty string with real usage attached — which the pipeline used to accept as a
 * success, so an entire RAG run could plan on an empty cast list. The adapter must retry with a
 * bigger budget, then fail with a message that names the cause instead of returning ''.
 *
 * Run with: node scripts/test-host-adapter.mjs
 */

import assert from 'node:assert/strict'

import { callModelWithCtx } from '../lib/index.js'

/** A ctx whose stream behaviour is a plain function of the request. */
function fakeCtx(reply) {
  return {
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
    llm: {
      stream(request) {
        return reply(request)
      },
    },
  }
}

function chunks(parts) {
  return (async function* () {
    for (const part of parts) yield part
  })()
}

/** Reasoning fills the whole budget, then the model stops without ever writing text. */
function thinkingOnly({ maxTokens }) {
  return chunks([
    { type: 'reasoning-delta', index: 0, text: '思考'.repeat(Math.ceil(maxTokens / 2)) },
    { type: 'usage', usage: { inputTokens: 3000, outputTokens: maxTokens, reasoningTokens: maxTokens } },
    { type: 'finish', reason: { kind: 'length' } },
  ])
}

/** Reasoning first, then real text — the normal case for a thinking model with enough room. */
function thinkingThenText({ maxTokens }) {
  const roomy = maxTokens >= 4096
  return chunks([
    { type: 'reasoning-delta', index: 0, text: '先想一下'.repeat(20) },
    ...(roomy ? [{ type: 'text-delta', index: 1, text: '{"nodes":[],"edges":[]}' }] : []),
    { type: 'usage', usage: { inputTokens: 3000, outputTokens: roomy ? 3200 : maxTokens, reasoningTokens: 3000 } },
    { type: 'finish', reason: { kind: roomy ? 'stop' : 'length' } },
  ])
}

const request = { system: '系统', user: '正文', maxTokens: 2048, label: 'cast 3' }

// ── 1. a working call costs one request and reports the provider's own usage ─────────────────
{
  const budgets = []
  const reply = await callModelWithCtx(
    fakeCtx((req) => {
      budgets.push(req.maxTokens)
      return chunks([
        { type: 'text-delta', index: 0, text: '{"cast":["楚子航"]}' },
        { type: 'usage', usage: { inputTokens: 2800, outputTokens: 24, cacheReadTokens: 1024 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ])
    }),
    request,
  )
  assert.deepEqual(budgets, [2048], 'one call when the first reply has text')
  assert.match(reply.text, /楚子航/, 'text returned as written')
  assert.equal(reply.usage.prompt, 2800, 'prompt tokens come from the usage chunk')
  assert.equal(reply.usage.completion, 24, 'completion tokens come from the usage chunk')
  assert.equal(reply.usage.estimated, false, 'real usage is not flagged as estimated')
}

// ── 2. an empty reply is retried with double the budget, and the second one wins ─────────────
{
  const budgets = []
  const reply = await callModelWithCtx(
    fakeCtx((req) => {
      budgets.push(req.maxTokens)
      return thinkingThenText(req)
    }),
    request,
  )
  assert.deepEqual(budgets, [2048, 4096], 'an empty reply doubles the budget')
  assert.match(reply.text, /nodes/, 'the second attempt text is returned')
  assert.equal(reply.attempts, 2, 'attempt count reported')
}

// ── 3. a model that only ever thinks fails loudly, after the budgets are exhausted ───────────
{
  const budgets = []
  const error = await callModelWithCtx(
    fakeCtx((req) => {
      budgets.push(req.maxTokens)
      return thinkingOnly(req)
    }),
    request,
  ).then(
    () => null,
    (value) => value,
  )
  assert.deepEqual(budgets, [2048, 4096, 8192], 'three attempts, each with double the budget')
  assert.ok(error instanceof Error, 'an empty reply must throw, never return ""')
  assert.match(error.message, /空正文/, 'the message says the body was empty')
  assert.match(error.message, /思考/, 'the message names the likely cause')
  assert.match(error.message, /cast 3/, 'the label is kept for attribution')
}

// ── 4. no text and no reasoning is not a budget problem: fail after one try ─────────────────
{
  const budgets = []
  const error = await callModelWithCtx(
    fakeCtx((req) => {
      budgets.push(req.maxTokens)
      return chunks([{ type: 'finish', reason: { kind: 'stop' } }])
    }),
    request,
  ).then(
    () => null,
    (value) => value,
  )
  assert.deepEqual(budgets, [2048], 'a genuinely empty answer is not retried three times')
  assert.ok(error instanceof Error, 'it still throws')
  assert.match(error.message, /空正文/, 'and it still says why')
}

console.log('host adapter ok')
