import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent } from '../src/agent/session.js'
import { tool } from '../src/tools/define.js'
import {
  attachTracer,
  createInMemoryExporter,
} from '../src/experimental/tracing/index.js'
import type { Span } from '../src/experimental/tracing/index.js'
import { MockProvider } from './mock-provider.js'

function childrenByKind(spans: Span[], parent: Span, kind: Span['kind']): Span[] {
  return spans.filter((s) => s.parentSpanId === parent.spanId && s.kind === kind)
}

describe('experimental tracing', () => {
  it('derives a session → turn → (provider_call | tool_execution) span tree from the bus', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-trace-'))

    const greet = tool({
      name: 'greet',
      description: 'greets',
      schema: z.object({ name: z.string() }),
      execute: async ({ name }) => `hi ${name}`,
    })

    const provider = new MockProvider([
      {
        toolCalls: [{ id: 'tu_1', name: 'greet', input: { name: 'ariel' } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 },
      },
      { text: 'done', stopReason: 'end_turn', usage: { inputTokens: 130, outputTokens: 5 } },
    ])

    const exporter = createInMemoryExporter()
    const agent = await createAgent({ provider, cwd: dir, tools: [greet] })
    const attached = attachTracer(agent, { exporter })

    await agent.run('greet ariel')
    attached.detach()

    const { spans } = exporter

    // One session span, two turn spans, two provider spans, one tool span.
    const session = exporter.root()
    expect(session).toBeDefined()
    expect(spans.filter((s) => s.kind === 'session')).toHaveLength(1)
    expect(spans.filter((s) => s.kind === 'turn')).toHaveLength(2)
    expect(spans.filter((s) => s.kind === 'provider_call')).toHaveLength(2)
    expect(spans.filter((s) => s.kind === 'tool_execution')).toHaveLength(1)

    // All spans share the run's trace id and every span ended.
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1)
    expect(session!.traceId).toBe(attached.currentTraceId())
    expect(spans.every((s) => typeof s.endTime === 'number')).toBe(true)

    // Hierarchy: turns hang off the session; tool + provider hang off a turn.
    const turns = childrenByKind(spans, session!, 'turn')
    expect(turns).toHaveLength(2)
    const tool0 = childrenByKind(spans, turns[0], 'tool_execution')
    expect(tool0).toHaveLength(1)
    expect(tool0[0].attributes['astor.tool.name']).toBe('greet')
    expect(tool0[0].status).toBe('ok')

    // Usage lands on the turn span as gen_ai.* attributes.
    expect(turns[0].attributes['gen_ai.usage.input_tokens']).toBe(100)
    expect(turns[0].attributes['gen_ai.usage.cache_read_tokens']).toBe(50)
    expect(turns[0].attributes['gen_ai.request.model']).toBeUndefined() // model lives on session/provider
    expect(session!.attributes['gen_ai.request.model']).toBe('mock-1')

    // Session closed cleanly.
    expect(session!.status).toBe('ok')
    expect(session!.attributes['astor.session.end_reason']).toBe('completed')
  })

  it('marks a failing tool span as error', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-trace-'))

    const boom = tool({
      name: 'boom',
      description: 'always throws',
      schema: z.object({}),
      execute: async () => {
        throw new Error('kaboom')
      },
    })

    const provider = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'boom', input: {} }], stopReason: 'tool_use' },
      { text: 'recovered', stopReason: 'end_turn' },
    ])

    const exporter = createInMemoryExporter()
    const agent = await createAgent({ provider, cwd: dir, tools: [boom] })
    attachTracer(agent, { exporter })

    await agent.run('run boom')

    const toolSpan = exporter.spans.find((s) => s.kind === 'tool_execution')
    expect(toolSpan?.status).toBe('error')
    expect(toolSpan?.attributes['astor.tool.is_error']).toBe(true)
  })

  it('gives each run its own trace id', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-trace-'))
    const provider = new MockProvider([
      { text: 'one', stopReason: 'end_turn' },
      { text: 'two', stopReason: 'end_turn' },
    ])

    const exporter = createInMemoryExporter()
    const agent = await createAgent({ provider, cwd: dir })
    attachTracer(agent, { exporter })

    await agent.run('first')
    await agent.run('second')

    const sessions = exporter.spans.filter((s) => s.kind === 'session')
    expect(sessions).toHaveLength(2)
    expect(sessions[0].traceId).not.toBe(sessions[1].traceId)
  })
})
