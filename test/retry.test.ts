import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent/session.js'
import { isTransientError, computeBackoffDelay } from '../src/agent/retry.js'
import { MockProvider } from './mock-provider.js'
import type { AgentEvent } from '../src/types.js'

/** Helper para construir un "error HTTP" duck-typed como los del SDK. */
function httpErr(status: number, message = 'http error') {
  const e = new Error(message) as Error & { status: number }
  e.status = status
  return e
}

function netErr(code: string, message = 'network error') {
  const e = new Error(message) as Error & { code: string }
  e.code = code
  return e
}

describe('isTransientError', () => {
  it('clasifica 429 y 5xx como transientes', () => {
    expect(isTransientError(httpErr(429))).toBe(true)
    expect(isTransientError(httpErr(500))).toBe(true)
    expect(isTransientError(httpErr(503))).toBe(true)
    expect(isTransientError(httpErr(599))).toBe(true)
  })

  it('NO clasifica 4xx (excepto 429) ni 2xx/3xx como transientes', () => {
    expect(isTransientError(httpErr(400))).toBe(false)
    expect(isTransientError(httpErr(401))).toBe(false)
    expect(isTransientError(httpErr(403))).toBe(false)
    expect(isTransientError(httpErr(404))).toBe(false)
  })

  it('detecta códigos de red de Node', () => {
    expect(isTransientError(netErr('ECONNRESET'))).toBe(true)
    expect(isTransientError(netErr('ETIMEDOUT'))).toBe(true)
    expect(isTransientError(netErr('UND_ERR_SOCKET'))).toBe(true)
    expect(isTransientError(netErr('EPERM'))).toBe(false)
  })

  it('detecta nombres APIConnectionError / APIConnectionTimeoutError', () => {
    const e1 = new Error('conn fail')
    e1.name = 'APIConnectionError'
    expect(isTransientError(e1)).toBe(true)

    const e2 = new Error('timeout')
    e2.name = 'APIConnectionTimeoutError'
    expect(isTransientError(e2)).toBe(true)
  })

  it('detecta streams cortados por mensaje', () => {
    expect(isTransientError(new Error('request ended without sending any chunks'))).toBe(true)
    expect(isTransientError(new Error('socket hang up'))).toBe(true)
    expect(isTransientError(new Error('Premature close'))).toBe(true)
  })

  it('AbortError nunca es transiente', () => {
    const e = new Error('aborted')
    e.name = 'AbortError'
    expect(isTransientError(e)).toBe(false)
  })

  it('errores no clasificables propagan (no transientes)', () => {
    expect(isTransientError(new Error('algo raro'))).toBe(false)
    expect(isTransientError(null)).toBe(false)
    expect(isTransientError('string')).toBe(false)
  })

  it('recursa en .cause (fetch wrap)', () => {
    const inner = netErr('ECONNRESET')
    const outer = new Error('wrapper') as Error & { cause?: unknown }
    outer.cause = inner
    expect(isTransientError(outer)).toBe(true)
  })
})

describe('computeBackoffDelay', () => {
  it('respeta el cap y el crecimiento exponencial sin jitter', () => {
    const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, jitter: false }
    expect(computeBackoffDelay(1, policy)).toBe(100)
    expect(computeBackoffDelay(2, policy)).toBe(200)
    expect(computeBackoffDelay(3, policy)).toBe(400)
    expect(computeBackoffDelay(4, policy)).toBe(800)
    expect(computeBackoffDelay(5, policy)).toBe(1000) // capped
  })

  it('con jitter, el delay está en [0, exp]', () => {
    const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, jitter: true }
    for (let i = 0; i < 20; i++) {
      const d = computeBackoffDelay(3, policy)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(400)
    }
  })
})

describe('agent loop con RetryPolicy', () => {
  it('default (sin retry): propaga el error y emite session_end:error', async () => {
    const provider = new MockProvider([{ failBeforeStream: httpErr(503) }])
    const events: AgentEvent[] = []
    const session = await createAgent({ provider })
    session.on('event', (e) => events.push(e))

    await expect(session.run('go')).rejects.toMatchObject({ status: 503 })

    const last = events[events.length - 1]
    expect(last?.type).toBe('session_end')
    expect((last as Extract<AgentEvent, { type: 'session_end' }>).reason).toBe('error')
    expect(events.find((e) => e.type === 'provider_retry')).toBeUndefined()
  })

  it('con retry: reintenta errores 503 y emite provider_retry', async () => {
    const provider = new MockProvider([
      { failBeforeStream: httpErr(503) },
      { failBeforeStream: httpErr(503) },
      { text: 'finalmente respondí' },
    ])
    const events: AgentEvent[] = []
    const session = await createAgent({
      provider,
      retry: { maxAttempts: 3, baseDelayMs: 1, jitter: false },
    })
    session.on('event', (e) => events.push(e))

    const result = await session.run('go')
    expect(result.content[0]).toEqual({ type: 'text', text: 'finalmente respondí' })

    const retries = events.filter((e) => e.type === 'provider_retry')
    expect(retries).toHaveLength(2)
    const r0 = retries[0] as Extract<AgentEvent, { type: 'provider_retry' }>
    expect(r0.attempt).toBe(1)
    expect(r0.maxAttempts).toBe(3)
    expect(r0.delayMs).toBe(1)
    expect((r0.error as { status: number }).status).toBe(503)
  })

  it('reintenta 429 y errores de red ECONNRESET', async () => {
    const provider = new MockProvider([
      { failBeforeStream: httpErr(429) },
      { failBeforeStream: netErr('ECONNRESET') },
      { text: 'ok' },
    ])
    const session = await createAgent({
      provider,
      retry: { maxAttempts: 3, baseDelayMs: 1, jitter: false },
    })
    const events: AgentEvent[] = []
    session.on('event', (e) => events.push(e))

    await session.run('go')
    expect(events.filter((e) => e.type === 'provider_retry')).toHaveLength(2)
  })

  it('NO reintenta errores no transientes (4xx que no sean 429)', async () => {
    const provider = new MockProvider([
      { failBeforeStream: httpErr(401, 'unauthorized') },
      { text: 'no debería llegar' },
    ])
    const session = await createAgent({
      provider,
      retry: { maxAttempts: 3, baseDelayMs: 1, jitter: false },
    })
    const events: AgentEvent[] = []
    session.on('event', (e) => events.push(e))

    await expect(session.run('go')).rejects.toMatchObject({ status: 401 })
    expect(events.find((e) => e.type === 'provider_retry')).toBeUndefined()
    expect(provider.calls).toHaveLength(1)
  })

  it('NO reintenta si ya se emitió algo del stream', async () => {
    // failAfterPartial dispara el error después del text_delta inicial:
    // como ya yieldeamos al bus, no se puede reintentar sin duplicar.
    const provider = new MockProvider([
      { text: 'hola...', failAfterPartial: httpErr(503) },
      { text: 'no debería llegar' },
    ])
    const session = await createAgent({
      provider,
      retry: { maxAttempts: 3, baseDelayMs: 1, jitter: false },
    })
    const events: AgentEvent[] = []
    session.on('event', (e) => events.push(e))

    await expect(session.run('go')).rejects.toMatchObject({ status: 503 })
    expect(events.find((e) => e.type === 'provider_retry')).toBeUndefined()
    // Verificamos que el text_delta sí se emitió antes del error.
    expect(events.find((e) => e.type === 'text_delta')).toBeDefined()
  })

  it('propaga el error si se agotan los intentos', async () => {
    const provider = new MockProvider([
      { failBeforeStream: httpErr(503) },
      { failBeforeStream: httpErr(503) },
    ])
    const session = await createAgent({
      provider,
      retry: { maxAttempts: 2, baseDelayMs: 1, jitter: false },
    })
    const events: AgentEvent[] = []
    session.on('event', (e) => events.push(e))

    await expect(session.run('go')).rejects.toMatchObject({ status: 503 })
    expect(events.filter((e) => e.type === 'provider_retry')).toHaveLength(1)
    const last = events[events.length - 1]
    expect((last as Extract<AgentEvent, { type: 'session_end' }>).reason).toBe('error')
  })

  it('abort durante el backoff propaga AbortError sin más reintentos', async () => {
    const provider = new MockProvider([
      { failBeforeStream: httpErr(503) },
      { failBeforeStream: httpErr(503) },
      { text: 'no llega' },
    ])
    const session = await createAgent({
      provider,
      retry: { maxAttempts: 3, baseDelayMs: 200, jitter: false },
    })
    const events: AgentEvent[] = []
    session.on('event', (e) => events.push(e))

    const pending = session.run('go')
    // Abortamos durante el sleep del primer backoff.
    setTimeout(() => session.abort(), 20)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const last = events[events.length - 1]
    expect((last as Extract<AgentEvent, { type: 'session_end' }>).reason).toBe('aborted')
  })

  it('maxAttempts: 1 deshabilita reintentos aunque haya policy', async () => {
    const provider = new MockProvider([
      { failBeforeStream: httpErr(503) },
      { text: 'no llega' },
    ])
    const session = await createAgent({
      provider,
      retry: { maxAttempts: 1, baseDelayMs: 1, jitter: false },
    })
    const events: AgentEvent[] = []
    session.on('event', (e) => events.push(e))

    await expect(session.run('go')).rejects.toMatchObject({ status: 503 })
    expect(events.find((e) => e.type === 'provider_retry')).toBeUndefined()
  })
})
