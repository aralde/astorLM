import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent/session.js'
import { isTransientError, isAbortError, computeBackoffDelay } from '../src/agent/retry.js'
import { MockProvider } from './mock-provider.js'
import type { AgentEvent } from '../src/types.js'

/** Helper to build a duck-typed "HTTP error" like the SDK ones. */
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
  it('classifies 429 and 5xx as transient', () => {
    expect(isTransientError(httpErr(429))).toBe(true)
    expect(isTransientError(httpErr(500))).toBe(true)
    expect(isTransientError(httpErr(503))).toBe(true)
    expect(isTransientError(httpErr(599))).toBe(true)
  })

  it('does NOT classify 4xx (except 429) nor 2xx/3xx as transient', () => {
    expect(isTransientError(httpErr(400))).toBe(false)
    expect(isTransientError(httpErr(401))).toBe(false)
    expect(isTransientError(httpErr(403))).toBe(false)
    expect(isTransientError(httpErr(404))).toBe(false)
  })

  it('detects Node network codes', () => {
    expect(isTransientError(netErr('ECONNRESET'))).toBe(true)
    expect(isTransientError(netErr('ETIMEDOUT'))).toBe(true)
    expect(isTransientError(netErr('UND_ERR_SOCKET'))).toBe(true)
    expect(isTransientError(netErr('EPERM'))).toBe(false)
  })

  it('detects the APIConnectionError / APIConnectionTimeoutError names', () => {
    const e1 = new Error('conn fail')
    e1.name = 'APIConnectionError'
    expect(isTransientError(e1)).toBe(true)

    const e2 = new Error('timeout')
    e2.name = 'APIConnectionTimeoutError'
    expect(isTransientError(e2)).toBe(true)
  })

  it('detects streams cut by message', () => {
    expect(isTransientError(new Error('request ended without sending any chunks'))).toBe(true)
    expect(isTransientError(new Error('socket hang up'))).toBe(true)
    expect(isTransientError(new Error('Premature close'))).toBe(true)
  })

  it('AbortError is never transient', () => {
    const e = new Error('aborted')
    e.name = 'AbortError'
    expect(isTransientError(e)).toBe(false)
  })

  it('non-classifiable errors propagate (not transient)', () => {
    expect(isTransientError(new Error('something weird'))).toBe(false)
    expect(isTransientError(null)).toBe(false)
    expect(isTransientError('string')).toBe(false)
  })

  it('recurses into .cause (fetch wrap)', () => {
    const inner = netErr('ECONNRESET')
    const outer = new Error('wrapper') as Error & { cause?: unknown }
    outer.cause = inner
    expect(isTransientError(outer)).toBe(true)
  })
})

describe('isAbortError', () => {
  it('recognises the WHATWG/Anthropic AbortError', () => {
    expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true)
  })

  it('recognises the OpenAI SDK APIUserAbortError', () => {
    const e = new Error('Request was aborted.') as Error & { name: string }
    e.name = 'APIUserAbortError'
    expect(isAbortError(e)).toBe(true)
  })

  it('does not flag unrelated errors', () => {
    expect(isAbortError(new Error('boom'))).toBe(false)
    expect(isAbortError(httpErr(500))).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })

  it('abort errors are never classified as transient', () => {
    const e = new Error('Request was aborted.') as Error & { name: string }
    e.name = 'APIUserAbortError'
    expect(isTransientError(e)).toBe(false)
    expect(isTransientError(new DOMException('Aborted', 'AbortError'))).toBe(false)
  })
})

describe('computeBackoffDelay', () => {
  it('respects the cap and exponential growth without jitter', () => {
    const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, jitter: false }
    expect(computeBackoffDelay(1, policy)).toBe(100)
    expect(computeBackoffDelay(2, policy)).toBe(200)
    expect(computeBackoffDelay(3, policy)).toBe(400)
    expect(computeBackoffDelay(4, policy)).toBe(800)
    expect(computeBackoffDelay(5, policy)).toBe(1000) // capped
  })

  it('with jitter, the delay is in [0, exp]', () => {
    const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, jitter: true }
    for (let i = 0; i < 20; i++) {
      const d = computeBackoffDelay(3, policy)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(400)
    }
  })
})

describe('agent loop with RetryPolicy', () => {
  it('default (no retry): propagates the error and emits session_end:error', async () => {
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

  it('with retry: retries 503 errors and emits provider_retry', async () => {
    const provider = new MockProvider([
      { failBeforeStream: httpErr(503) },
      { failBeforeStream: httpErr(503) },
      { text: 'finally responded' },
    ])
    const events: AgentEvent[] = []
    const session = await createAgent({
      provider,
      retry: { maxAttempts: 3, baseDelayMs: 1, jitter: false },
    })
    session.on('event', (e) => events.push(e))

    const result = await session.run('go')
    expect(result.content[0]).toEqual({ type: 'text', text: 'finally responded' })

    const retries = events.filter((e) => e.type === 'provider_retry')
    expect(retries).toHaveLength(2)
    const r0 = retries[0] as Extract<AgentEvent, { type: 'provider_retry' }>
    expect(r0.attempt).toBe(1)
    expect(r0.maxAttempts).toBe(3)
    expect(r0.delayMs).toBe(1)
    expect((r0.error as { status: number }).status).toBe(503)
  })

  it('retries 429 and ECONNRESET network errors', async () => {
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

  it('does NOT retry non-transient errors (4xx other than 429)', async () => {
    const provider = new MockProvider([
      { failBeforeStream: httpErr(401, 'unauthorized') },
      { text: 'should not be reached' },
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

  it('does NOT retry if something was already emitted from the stream', async () => {
    // failAfterPartial fires the error after the initial text_delta:
    // since we already yielded to the bus, it cannot be retried without duplicating.
    const provider = new MockProvider([
      { text: 'hi...', failAfterPartial: httpErr(503) },
      { text: 'should not be reached' },
    ])
    const session = await createAgent({
      provider,
      retry: { maxAttempts: 3, baseDelayMs: 1, jitter: false },
    })
    const events: AgentEvent[] = []
    session.on('event', (e) => events.push(e))

    await expect(session.run('go')).rejects.toMatchObject({ status: 503 })
    expect(events.find((e) => e.type === 'provider_retry')).toBeUndefined()
    // Verify the text_delta was indeed emitted before the error.
    expect(events.find((e) => e.type === 'text_delta')).toBeDefined()
  })

  it('propagates the error if attempts are exhausted', async () => {
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

  it('abort during the backoff propagates AbortError with no further retries', async () => {
    const provider = new MockProvider([
      { failBeforeStream: httpErr(503) },
      { failBeforeStream: httpErr(503) },
      { text: 'not reached' },
    ])
    const session = await createAgent({
      provider,
      retry: { maxAttempts: 3, baseDelayMs: 200, jitter: false },
    })
    const events: AgentEvent[] = []
    session.on('event', (e) => events.push(e))

    const pending = session.run('go')
    // Abort during the sleep of the first backoff.
    setTimeout(() => session.abort(), 20)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const last = events[events.length - 1]
    expect((last as Extract<AgentEvent, { type: 'session_end' }>).reason).toBe('aborted')
  })

  it('maxAttempts: 1 disables retries even if a policy is present', async () => {
    const provider = new MockProvider([
      { failBeforeStream: httpErr(503) },
      { text: 'not reached' },
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
