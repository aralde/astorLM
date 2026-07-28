import { describe, expect, it, vi } from 'vitest'
import {
  createGuardedProvider,
  DegenerationError,
} from '../src/experimental/edge-boost/index.js'
import type { Provider, ProviderEvent, ProviderStreamOptions } from '../src/types.js'

// ---- scripted provider with per-call control ----

type StreamFn = (opts: ProviderStreamOptions) => AsyncIterable<ProviderEvent>

class ScriptProvider implements Provider {
  readonly name = 'script'
  readonly model = 'script-1'
  readonly contextLimit = 8000
  calls: ProviderStreamOptions[] = []
  private i = 0
  constructor(private readonly scripts: StreamFn[]) {}
  async *stream(opts: ProviderStreamOptions): AsyncIterable<ProviderEvent> {
    this.calls.push(opts)
    const fn = this.scripts[this.i++]
    if (!fn) throw new Error('ScriptProvider: no scripts left')
    yield* fn(opts)
  }
}

const thinking = (t: string): ProviderEvent => ({ type: 'thinking_delta', thinking: t })
const text = (t: string): ProviderEvent => ({ type: 'text_delta', text: t })
const end = (t: string): ProviderEvent => ({
  type: 'message_end',
  stopReason: 'end_turn',
  assistantMessage: { role: 'assistant', content: t ? [{ type: 'text', text: t }] : [] },
})

async function* repeat(ev: ProviderEvent, n: number): AsyncIterable<ProviderEvent> {
  for (let k = 0; k < n; k++) yield ev
}
async function* healthy(answer = 'final answer'): AsyncIterable<ProviderEvent> {
  yield text(answer)
  yield end(answer)
}
const stall: StreamFn = async function* (opts) {
  yield thinking('thinking...')
  await new Promise<void>((_, reject) => {
    if (opts.abortSignal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    opts.abortSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
      once: true,
    })
  })
}

function baseOpts(overrides: Partial<ProviderStreamOptions> = {}): ProviderStreamOptions {
  return {
    systemPrompt: 's',
    messages: [],
    tools: [],
    abortSignal: new AbortController().signal,
    ...overrides,
  }
}

async function drain(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = []
  for await (const e of stream) out.push(e)
  return out
}

const REP_ONLY = { maxRepeatedDeltas: 15, stallTimeoutMs: 0, maxThinkingChars: 0, maxAttempts: 2 }

describe('createGuardedProvider — degeneration guard', () => {
  it('aborts a repetition loop and retries, completing on a healthy attempt', async () => {
    const inner = new ScriptProvider([(o) => repeat(thinking(' \\'), 20), () => healthy()])
    const provider = createGuardedProvider(inner, { guard: REP_ONLY })
    const events = await drain(provider.stream(baseOpts()))
    expect(inner.calls.length).toBe(2) // one degeneration cycle + one retry
    expect(events.some((e) => e.type === 'message_end')).toBe(true)
    expect(events.some((e) => e.type === 'text_delta' && e.text.includes('final'))).toBe(true)
  })

  it('throws DegenerationError(repetition) once attempts are exhausted', async () => {
    const inner = new ScriptProvider([
      (o) => repeat(thinking(' \\'), 20),
      (o) => repeat(thinking(' \\'), 20),
    ])
    const provider = createGuardedProvider(inner, { guard: REP_ONLY })
    const err = await drain(provider.stream(baseOpts())).then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(DegenerationError)
    expect(err.reason).toBe('repetition')
    expect(inner.calls.length).toBe(2)
  })

  it('detects a stall via the timer and throws DegenerationError(stall)', async () => {
    vi.useFakeTimers()
    try {
      const inner = new ScriptProvider([stall])
      const provider = createGuardedProvider(inner, {
        guard: { maxRepeatedDeltas: 0, maxThinkingChars: 0, stallTimeoutMs: 1000, maxAttempts: 1 },
      })
      const p = drain(provider.stream(baseOpts()))
      p.catch(() => {})
      await vi.advanceTimersByTimeAsync(1200)
      const err = await p.then(
        () => null,
        (e) => e,
      )
      expect(err).toBeInstanceOf(DegenerationError)
      expect(err.reason).toBe('stall')
    } finally {
      vi.useRealTimers()
    }
  })

  it('detects a reasoning-budget blowout before any content', async () => {
    const inner = new ScriptProvider([
      async function* () {
        for (let k = 0; k < 10; k++) yield thinking(`block ${k} padding padding`)
      },
    ])
    const provider = createGuardedProvider(inner, {
      guard: { maxRepeatedDeltas: 0, stallTimeoutMs: 0, maxThinkingChars: 50, maxAttempts: 1 },
    })
    const err = await drain(provider.stream(baseOpts())).then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(DegenerationError)
    expect(err.reason).toBe('reasoning-budget')
  })

  it('does not retry once productive output was forwarded', async () => {
    const inner = new ScriptProvider([
      async function* () {
        yield text('partial')
        yield* repeat(thinking(' \\'), 20)
      },
      () => healthy(),
    ])
    const provider = createGuardedProvider(inner, { guard: REP_ONLY })
    const err = await drain(provider.stream(baseOpts())).then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(DegenerationError)
    expect(inner.calls.length).toBe(1) // no retry after visible output
  })

  it('propagates an outer abort as AbortError, not DegenerationError', async () => {
    const outer = new AbortController()
    const inner = new ScriptProvider([stall])
    const provider = createGuardedProvider(inner, {
      guard: { maxRepeatedDeltas: 0, maxThinkingChars: 0, stallTimeoutMs: 0, maxAttempts: 2 },
    })
    const p = drain(provider.stream(baseOpts({ abortSignal: outer.signal })))
    p.catch(() => {})
    await Promise.resolve()
    outer.abort()
    const err = await p.then(
      () => null,
      (e) => e,
    )
    expect(err?.name).toBe('AbortError')
    expect(err).not.toBeInstanceOf(DegenerationError)
    expect(inner.calls.length).toBe(1)
  })

  it('injects sampling defaults only when the call omits them', async () => {
    const inner = new ScriptProvider([() => healthy(), () => healthy()])
    const provider = createGuardedProvider(inner, {
      guard: false,
      sampling: { maxTokens: 1024, frequencyPenalty: 0.2 },
    })
    await drain(provider.stream(baseOpts()))
    expect(inner.calls[0]!.maxTokens).toBe(1024)
    expect(inner.calls[0]!.sampling?.frequencyPenalty).toBe(0.2)

    await drain(provider.stream(baseOpts({ maxTokens: 50, sampling: { frequencyPenalty: 0.9 } })))
    expect(inner.calls[1]!.maxTokens).toBe(50)
    expect(inner.calls[1]!.sampling?.frequencyPenalty).toBe(0.9)
  })
})
