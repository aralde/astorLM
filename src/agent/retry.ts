import type { EventBus } from './events.js'
import type {
  Provider,
  ProviderEvent,
  ProviderStreamOptions,
  RetryPolicy,
} from '../types.js'

/**
 * Node network error codes considered transient.
 * Deliberately not exhaustive: if we can't classify it with confidence, we let
 * it propagate so as not to hide bugs.
 */
const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

/**
 * True if the error represents a cooperative abort rather than a real failure.
 * Our own code raises DOMException `AbortError`; the OpenAI SDK raises
 * `APIUserAbortError` when its request is cancelled via an AbortSignal, while
 * Anthropic + the WHATWG fetch path surface `AbortError`. Recognise all of
 * them so an aborted turn is never reported as a hard error.
 */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: string }).name
  return name === 'AbortError' || name === 'APIUserAbortError'
}

/** Heuristic over Anthropic/OpenAI SDK errors + Node network errors. */
export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as {
    status?: number
    code?: string | number
    name?: string
    message?: string
    cause?: unknown
  }

  // HTTP status: 429 (rate limit) + 5xx (server errors / overloaded).
  if (typeof e.status === 'number') {
    if (e.status === 429) return true
    if (e.status >= 500 && e.status < 600) return true
  }

  // SDK-specific connection / timeout errors (Anthropic + OpenAI follow
  // the same naming).
  if (typeof e.name === 'string') {
    if (e.name === 'APIConnectionError') return true
    if (e.name === 'APIConnectionTimeoutError') return true
    if (e.name === 'AbortError' || e.name === 'APIUserAbortError') return false
  }

  // Node network error codes.
  if (typeof e.code === 'string' && TRANSIENT_NET_CODES.has(e.code)) return true

  // Message for a stream cut without chunks (Anthropic/OpenAI via undici).
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : ''
  if (
    msg.includes('request ended without sending any chunks') ||
    msg.includes('socket hang up') ||
    msg.includes('terminated') ||
    msg.includes('premature close')
  ) {
    return true
  }

  // Recurse into cause (fetch often wraps the real error there).
  if (e.cause && e.cause !== err) return isTransientError(e.cause)

  return false
}

/** Exponential backoff with a cap and optional jitter. */
export function computeBackoffDelay(attempt: number, policy: RetryPolicy): number {
  const base = policy.baseDelayMs ?? 500
  const cap = policy.maxDelayMs ?? 10_000
  const exp = Math.min(cap, base * 2 ** (attempt - 1))
  if (policy.jitter === false) return exp
  // Full jitter (AWS-style): uniform [0, exp].
  return Math.floor(Math.random() * exp)
}

/** Abortable sleep: resolves after ms, or rejects if the signal aborts first. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface StreamWithRetryOptions {
  provider: Provider
  streamOpts: ProviderStreamOptions
  policy?: RetryPolicy
  bus: EventBus
  abortSignal: AbortSignal
}

/**
 * Wraps `provider.stream()` with opt-in retries.
 *
 * Rules:
 *  - Only retries if `policy.maxAttempts > 1` and the error is classifiable
 *    as transient.
 *  - **Does not retry if any event was already yielded in the current attempt**:
 *    retrying would mean duplicating text/tool_uses to the bus consumer.
 *    This is the same criterion as pi-agent ("stream ended without chunks").
 *  - The abort signal always wins: during the sleep or between attempts, if it
 *    was aborted, it propagates `AbortError` without retrying.
 *  - Emits `provider_retry` before each wait so the consumer sees the retries
 *    in the stream.
 */
export async function* streamWithRetry(
  opts: StreamWithRetryOptions,
): AsyncIterable<ProviderEvent> {
  const policy = opts.policy
  const maxAttempts = Math.max(1, policy?.maxAttempts ?? 1)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let emittedAnything = false
    try {
      const stream = opts.provider.stream(opts.streamOpts)
      for await (const ev of stream) {
        emittedAnything = true
        yield ev
      }
      return
    } catch (err) {
      // Abort: do not retry, propagate.
      if (opts.abortSignal.aborted) throw err
      if (isAbortError(err)) throw err

      // If we already yielded something, we can't retry without duplicating.
      if (emittedAnything) throw err

      // Last chance used up.
      if (attempt >= maxAttempts) throw err

      // Non-classifiable errors propagate.
      if (!policy || !isTransientError(err)) throw err

      const delayMs = computeBackoffDelay(attempt, policy)
      opts.bus.emit({
        type: 'provider_retry',
        attempt,
        maxAttempts,
        delayMs,
        error: err,
      })
      await abortableSleep(delayMs, opts.abortSignal)
    }
  }
}
