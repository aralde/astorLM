import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent } from '../src/agent/session.js'
import { tool } from '../src/tools/define.js'
import {
  attachMetrics,
  computeCost,
  resolvePricing,
} from '../src/experimental/metrics/index.js'
import { MockProvider } from './mock-provider.js'

describe('pricing', () => {
  it('computes USD cost including cache tokens', () => {
    const cost = computeCost(
      { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000 },
      { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3 },
    )
    // 1*3 + 0.5*15 + 2*0.3 = 3 + 7.5 + 0.6
    expect(cost).toBeCloseTo(11.1, 5)
  })

  it('resolves pricing by exact id then longest prefix', () => {
    const table = { 'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 }, 'gpt-4': { inputPer1M: 30, outputPer1M: 60 } }
    expect(resolvePricing(table, 'gpt-4o')).toEqual(table['gpt-4o'])
    expect(resolvePricing(table, 'gpt-4o-2024-08-06')).toEqual(table['gpt-4o'])
    expect(resolvePricing(table, 'gpt-4-0613')).toEqual(table['gpt-4'])
    expect(resolvePricing(table, 'llama-3')).toBeUndefined()
  })
})

describe('attachMetrics', () => {
  it('aggregates counts, tokens, cost and latency from the bus', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-metrics-'))
    const echo = tool({
      name: 'echo',
      description: 'echoes',
      schema: z.object({ s: z.string() }),
      execute: async ({ s }) => `echo:${s}`,
    })
    const provider = new MockProvider([
      {
        text: 'thinking',
        toolCalls: [{ id: 't1', name: 'echo', input: { s: 'foo' } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 1000, outputTokens: 200 },
      },
      { text: 'done', stopReason: 'end_turn', usage: { inputTokens: 1300, outputTokens: 50 } },
    ])

    const agent = await createAgent({ provider, cwd: dir, tools: [echo] })
    const metrics = attachMetrics(agent, {
      pricing: { 'mock-1': { inputPer1M: 1, outputPer1M: 2 } },
    })

    await agent.run('go')
    const snap = metrics.snapshot()

    expect(snap.runs).toBe(1)
    expect(snap.turns).toBe(2)
    expect(snap.providerCalls).toBe(2)
    expect(snap.toolCalls).toBe(1)
    expect(snap.toolErrors).toBe(0)
    expect(snap.tokens.input).toBe(2300)
    expect(snap.tokens.output).toBe(250)
    // cost = (2300/1e6)*1 + (250/1e6)*2
    expect(snap.costUsd).toBeCloseTo(2300e-6 + 500e-6, 9)
    expect(snap.latency.toolMs.count).toBe(1)
    expect(snap.latency.turnMs.count).toBe(2)
  })

  it('omits costUsd when no pricing is given and counts tool errors', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-metrics-'))
    const boom = tool({
      name: 'boom',
      description: 'throws',
      schema: z.object({}),
      execute: async () => {
        throw new Error('x')
      },
    })
    const provider = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'boom', input: {} }], stopReason: 'tool_use' },
      { text: 'ok', stopReason: 'end_turn' },
    ])
    const agent = await createAgent({ provider, cwd: dir, tools: [boom] })
    const metrics = attachMetrics(agent)
    await agent.run('go')
    const snap = metrics.snapshot()
    expect(snap.costUsd).toBeUndefined()
    expect(snap.toolErrors).toBe(1)
  })
})
