import { createHash } from 'crypto'
import { clipForModel, sanitizeOneLiner } from './bonsai-text'

/**
 * Client for the ONE shared local Bonsai server (the bonsai plugin's
 * OpenAI-compatible endpoint). The app only *detects* it — starting/stopping
 * stays the plugin's job — and every feature built on it degrades to raw text
 * when it's down. Requests are queued (small model; don't starve interactive
 * CLI use) and answers are cached by content hash.
 */

const PROBE_TTL_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000
const MAX_CONCURRENT = 2
const MAX_QUEUE = 32
const CACHE_MAX = 200

interface Endpoint {
  base: string
  model: string
}

let endpoint: Endpoint | null = null
let probedAt = 0
let probing: Promise<Endpoint | null> | null = null

function candidateBases(): string[] {
  const override = process.env['BONSAI_BASE_URL']
  if (override) return [override.replace(/\/+$/, '')]
  // MLX serves :8081 on Apple Silicon, llama.cpp :8080 elsewhere
  return ['http://127.0.0.1:8081/v1', 'http://127.0.0.1:8080/v1']
}

/** GET /models doubles as health check and model-id resolution — the served
 *  id is whatever the user loaded, never hardcoded. */
async function tryBase(base: string): Promise<Endpoint | null> {
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(1_500) })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: { id?: string }[] }
    const model = body.data?.[0]?.id
    return model ? { base, model } : null
  } catch {
    return null
  }
}

async function discover(): Promise<Endpoint | null> {
  for (const base of candidateBases()) {
    const ep = await tryBase(base)
    if (ep) return ep
  }
  return null
}

/** Resolve the endpoint, re-probing at most once a minute while it's down so
 *  a stopped server costs one cheap request per minute, not error spam. */
async function resolve(): Promise<Endpoint | null> {
  if (endpoint) return endpoint
  if (!probing) {
    if (Date.now() - probedAt < PROBE_TTL_MS) return null
    probing = discover().finally(() => {
      probedAt = Date.now()
      probing = null
    })
  }
  endpoint = await probing
  return endpoint
}

interface Job {
  prompt: string
  wanted: () => boolean
  resolve: (out: string | null) => void
}

const queue: Job[] = []
let running = 0

function pump(): void {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift()!
    // drop-on-staleness: a tab that closed while queued doesn't need its answer
    if (!job.wanted()) {
      job.resolve(null)
      continue
    }
    running++
    void complete(job.prompt)
      .then(job.resolve)
      .catch(() => job.resolve(null))
      .finally(() => {
        running--
        pump()
      })
  }
}

async function complete(prompt: string): Promise<string | null> {
  const ep = await resolve()
  if (!ep) return null
  try {
    const res = await fetch(`${ep.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ep.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 80,
        temperature: 0.2
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    return body.choices?.[0]?.message?.content ?? null
  } catch {
    // the server went away mid-run — forget it and let the next call re-probe
    endpoint = null
    probedAt = Date.now()
    return null
  }
}

// LRU by content hash: re-rendering the same text never re-asks the model
const cache = new Map<string, string>()

function cacheGet(key: string): string | undefined {
  const hit = cache.get(key)
  if (hit !== undefined) {
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

function cachePut(key: string, value: string): void {
  cache.set(key, value)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

/**
 * One-line summary (≤ `maxLen` chars) of `text`, or null when Bonsai is down,
 * the queue is saturated, or the reply was unusable — callers must have a
 * degraded path. `wanted` is re-checked when the job leaves the queue.
 */
export async function bonsaiOneLiner(
  text: string,
  maxLen = 120,
  wanted: () => boolean = () => true
): Promise<string | null> {
  const clipped = clipForModel(text)
  const key = createHash('sha1').update(`${maxLen}:${clipped}`).digest('hex')
  const hit = cacheGet(key)
  if (hit !== undefined) return hit
  if ((await resolve()) === null) return null
  if (queue.length >= MAX_QUEUE) return null
  const raw = await new Promise<string | null>((resolve) => {
    queue.push({
      prompt:
        'Compress this assistant status into ONE line of at most ' +
        `${maxLen} characters describing what is being worked on. ` +
        'Plain text only, no quotes, no preamble.\n\n' +
        clipped,
      wanted,
      resolve
    })
    pump()
  })
  const clean = sanitizeOneLiner(raw, maxLen)
  if (clean) cachePut(key, clean)
  return clean
}
