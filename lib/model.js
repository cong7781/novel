/**
 * One model call, with the bookkeeping a long run needs: token usage, wall time, retries.
 *
 * This module is only used by the CLI and the local viewer server, which both talk to the provider
 * directly. The DSH host tool goes through `ctx.llm` instead, but it shapes the same
 * `{ text, usage, seconds }` result, so the pipeline never knows which route it is on.
 *
 * The API key is read here and never logged, echoed, or written into a run artifact.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_BASE_URL = process.env.CHARACTER_GRAPH_BASE ?? 'https://api.deepseek.com'
export const DEFAULT_MODEL = process.env.CHARACTER_GRAPH_MODEL ?? 'deepseek-chat'

/**
 * USD per 1M tokens. Defaults are the published peak rates for the fast DeepSeek model
 * (input cache-miss $0.30, output $1.20 as of the pricing page shipped with this plugin), so the
 * reported cost is an upper bound; off-peak is half. Override with env vars if the account differs.
 */
export const PRICES = {
  inputMissPerM: Number(process.env.CHARACTER_GRAPH_PRICE_INPUT ?? 0.3),
  inputHitPerM: Number(process.env.CHARACTER_GRAPH_PRICE_CACHE_HIT ?? 0.006),
  outputPerM: Number(process.env.CHARACTER_GRAPH_PRICE_OUTPUT ?? 1.2),
}

export function readApiKey() {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim()
  const file = join(homedir(), '.dsh', '.credentials.yaml')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`读不到 ${file}。请设置环境变量 DEEPSEEK_API_KEY 后重试。`)
  }
  const match = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(text)
  if (!match) throw new Error('凭据文件里没有 DEEPSEEK_API_KEY。请设置环境变量后重试。')
  return match[1].trim()
}

/** Normalise provider usage into the three numbers the cost model needs. */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return { prompt: 0, completion: 0, cacheHit: 0 }
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0
  const cacheHit = Number(usage.prompt_cache_hit_tokens ?? usage.cache_hit_tokens ?? 0) || 0
  return { prompt, completion, cacheHit: Math.min(cacheHit, prompt) }
}

export function costOf(usage) {
  const miss = Math.max(0, usage.prompt - usage.cacheHit)
  const input =
    (miss * PRICES.inputMissPerM) / 1e6 + (usage.cacheHit * PRICES.inputHitPerM) / 1e6
  const output = (usage.completion * PRICES.outputPerM) / 1e6
  return { input, output, total: input + output }
}

export function emptyUsage() {
  return { prompt: 0, completion: 0, cacheHit: 0 }
}

export function addUsage(a, b) {
  return {
    prompt: a.prompt + b.prompt,
    completion: a.completion + b.completion,
    cacheHit: a.cacheHit + b.cacheHit,
  }
}

/**
 * Call a chat-completions endpoint.
 *
 * @param {{apiKey?: string, baseUrl?: string, model?: string, system: string, user: string,
 *   maxTokens?: number, temperature?: number, signal?: AbortSignal, retries?: number,
 *   timeoutMs?: number, label?: string}} options
 * @returns {Promise<{text: string, usage: {prompt: number, completion: number, cacheHit: number}, seconds: number, attempts: number}>}
 */
export async function callChat(options) {
  const apiKey = options.apiKey ?? readApiKey()
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const model = options.model ?? DEFAULT_MODEL
  const retries = options.retries ?? 2
  const timeoutMs = options.timeoutMs ?? 240000
  let lastError = null

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const started = Date.now()
    try {
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 8192,
          messages: [
            { role: 'system', content: options.system },
            { role: 'user', content: options.user },
          ],
        }),
        signal,
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        const error = new Error(`模型接口返回 ${response.status}：${body.slice(0, 200)}`)
        // 4xx that is not 429 will not get better by retrying.
        if (response.status !== 429 && response.status < 500) throw Object.assign(error, { fatal: true })
        lastError = error
        await sleep(600 * attempt)
        continue
      }

      const payload = await response.json()
      const text = payload?.choices?.[0]?.message?.content
      if (typeof text !== 'string' || text.trim() === '') {
        lastError = new Error('模型没有返回内容。')
        await sleep(400 * attempt)
        continue
      }
      return {
        text,
        usage: normalizeUsage(payload.usage),
        seconds: (Date.now() - started) / 1000,
        attempts: attempt,
        finishReason: payload?.choices?.[0]?.finish_reason,
      }
    } catch (error) {
      if (error.fatal) throw error
      lastError = error
      if (options.signal?.aborted) throw error
      await sleep(600 * attempt)
    }
  }

  throw new Error(`${options.label ? `${options.label}: ` : ''}模型调用失败（重试 ${retries} 次）：${lastError?.message ?? '未知错误'}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
