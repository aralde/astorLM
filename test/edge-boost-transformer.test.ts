import { describe, expect, it, vi } from 'vitest'
import { edgeBoost } from '../src/experimental/edge-boost/index.js'
import { MockProvider } from './mock-provider.js'
import type { CreateAgentOptions } from '../src/agent/session.js'
import type { Logger, SessionHooks } from '../src/types.js'

function baseOptions(overrides: Partial<CreateAgentOptions> = {}): CreateAgentOptions {
  return { provider: new MockProvider([{ text: 'ok', stopReason: 'end_turn' }]), ...overrides }
}

describe('edgeBoost transformer', () => {
  it('returns a new object and does not mutate the input', () => {
    const input = baseOptions()
    const originalProvider = input.provider
    const out = edgeBoost(input)
    expect(out).not.toBe(input)
    expect(input.provider).toBe(originalProvider) // input untouched
    expect(input.contextOptimizer).toBeUndefined()
  })

  it('wraps the provider (delegating name/model/contextLimit)', () => {
    const input = baseOptions()
    const out = edgeBoost(input)
    expect(out.provider).not.toBe(input.provider)
    expect(out.provider.name).toBe(input.provider.name)
    expect(out.provider.model).toBe(input.provider.model)
    expect(out.provider.contextLimit).toBe(input.provider.contextLimit)
  })

  it('keeps user hooks (run first) and adds edge-boost hooks', async () => {
    const spy = vi.fn(async () => {})
    const userHooks: SessionHooks = { beforeTurn: spy }
    const out = edgeBoost(baseOptions({ hooks: userHooks }))
    expect(out.hooks!.beforeTurn).toBeTypeOf('function')
    expect(out.hooks!.beforeProviderCall).toBeTypeOf('function') // from diet/synthesis
    await out.hooks!.beforeTurn!({
      turn: 1,
      accumulatedTurns: 1,
      messages: [],
      sessionUsage: { inputTokens: 0, outputTokens: 0 },
      cwd: '/',
    })
    expect(spy).toHaveBeenCalledOnce()
  })

  it('sets a tightened contextOptimizer only when the caller left it unset', () => {
    const auto = edgeBoost(baseOptions())
    expect(auto.contextOptimizer).toMatchObject({ compressThreshold: 0.6, keepRecentTurns: 2 })

    const userObj = { maxTokens: 1234 }
    const kept = edgeBoost(baseOptions({ contextOptimizer: userObj }))
    expect(kept.contextOptimizer).toBe(userObj)

    const off = edgeBoost(baseOptions({ contextOptimizer: false }))
    expect(off.contextOptimizer).toBe(false)
  })

  it('does not wrap the provider when guard and sampling are both disabled', () => {
    const input = baseOptions()
    const out = edgeBoost(input, { guard: false, sampling: false })
    expect(out.provider).toBe(input.provider)
  })

  it('is a no-op on a second application and warns', () => {
    const warn = vi.fn()
    const logger: Logger = { debug() {}, info() {}, warn, error() {} }
    const once = edgeBoost(baseOptions({ logger }))
    const twice = edgeBoost(once)
    expect(twice).toBe(once)
    expect(warn).toHaveBeenCalledOnce()
  })
})
