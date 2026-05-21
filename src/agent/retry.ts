import type { EventBus } from './events.js'
import type {
  Provider,
  ProviderEvent,
  ProviderStreamOptions,
  RetryPolicy,
} from '../types.js'

/**
 * Códigos de error de red Node considerados transientes.
 * No es exhaustivo a propósito: si no podemos clasificarlo con confianza,
 * dejamos que propague para no esconder bugs.
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

/** Heurística sobre errores del SDK de Anthropic/OpenAI + errores de red de Node. */
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

  // SDK-specific connection / timeout errors (Anthropic + OpenAI siguen
  // el mismo naming).
  if (typeof e.name === 'string') {
    if (e.name === 'APIConnectionError') return true
    if (e.name === 'APIConnectionTimeoutError') return true
    if (e.name === 'AbortError') return false
  }

  // Node network error codes.
  if (typeof e.code === 'string' && TRANSIENT_NET_CODES.has(e.code)) return true

  // Mensaje de stream cortado sin chunks (Anthropic/OpenAI vía undici).
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : ''
  if (
    msg.includes('request ended without sending any chunks') ||
    msg.includes('socket hang up') ||
    msg.includes('terminated') ||
    msg.includes('premature close')
  ) {
    return true
  }

  // Recursar en cause (fetch suele envolver el error real ahí).
  if (e.cause && e.cause !== err) return isTransientError(e.cause)

  return false
}

/** Backoff exponencial con tope y jitter opcional. */
export function computeBackoffDelay(attempt: number, policy: RetryPolicy): number {
  const base = policy.baseDelayMs ?? 500
  const cap = policy.maxDelayMs ?? 10_000
  const exp = Math.min(cap, base * 2 ** (attempt - 1))
  if (policy.jitter === false) return exp
  // Full jitter (AWS-style): uniform [0, exp].
  return Math.floor(Math.random() * exp)
}

/** Sleep abortable: resuelve al cumplirse ms, o rechaza si el signal aborta antes. */
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
 * Envuelve `provider.stream()` con reintentos opt-in.
 *
 * Reglas:
 *  - Sólo reintenta si `policy.maxAttempts > 1` y el error es clasificable
 *    como transiente.
 *  - **No reintenta si ya se yieldeó algún evento en el intento actual**:
 *    reintentar significaría duplicar texto/tool_uses al consumidor del bus.
 *    Este es el mismo criterio que pi-agent ("stream ended without chunks").
 *  - El signal de abort gana siempre: durante el sleep o entre intentos,
 *    si se abortó, propaga `AbortError` sin reintentar.
 *  - Emite `provider_retry` antes de cada espera para que el consumidor vea
 *    los reintentos en el stream.
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
      // Abort: no reintenta, propaga.
      if (opts.abortSignal.aborted) throw err
      const errName = (err as { name?: string } | null)?.name
      if (errName === 'AbortError') throw err

      // Si ya yieldeamos algo, no podemos reintentar sin duplicar.
      if (emittedAnything) throw err

      // Última oportunidad usada.
      if (attempt >= maxAttempts) throw err

      // Errores no clasificables propagan.
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
