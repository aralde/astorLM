import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgentSession } from '../src/agent/session.js'
import { defineTool } from '../src/tools/define.js'
import { MockProvider } from './mock-provider.js'
import type { AgentEvent } from '../src/types.js'

describe('agent loop', () => {
  it('ejecuta tool_use y continúa hasta end_turn', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-'))

    const calls: string[] = []
    const greet = defineTool({
      name: 'greet',
      description: 'saluda',
      schema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        calls.push(name)
        return `hola ${name}`
      },
    })

    const provider = new MockProvider([
      {
        toolCalls: [{ id: 'tu_1', name: 'greet', input: { name: 'ariel' } }],
        stopReason: 'tool_use',
      },
      { text: 'Listo, te saludé.', stopReason: 'end_turn' },
    ])

    const events: AgentEvent[] = []
    const session = createAgentSession({ provider, cwd: dir, tools: [greet] })
    session.subscribe((e) => events.push(e))

    const final = await session.prompt('saludá a ariel')

    expect(calls).toEqual(['ariel'])
    expect(provider.calls).toHaveLength(2)
    expect(final.content.some((b) => b.type === 'text' && b.text.includes('Listo'))).toBe(true)

    const types = events.map((e) => e.type)
    expect(types).toContain('turn_start')
    expect(types).toContain('tool_execution_start')
    expect(types).toContain('tool_execution_end')
    expect(types).toContain('assistant_message')
    expect(types[types.length - 1]).toBe('session_end')
  })

  it('tool_result se reinyecta como mensaje user', async () => {
    const echo = defineTool({
      name: 'echo',
      description: '',
      schema: z.object({ s: z.string() }),
      execute: async ({ s }) => `echo:${s}`,
    })
    const provider = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'echo', input: { s: 'foo' } }] },
      { text: 'ok' },
    ])
    const session = createAgentSession({ provider, tools: [echo] })
    await session.prompt('go')

    const msgs = session.getMessages()
    // user prompt + assistant(tool_use) + user(tool_result) + assistant(text)
    expect(msgs.length).toBe(4)
    const toolResult = msgs[2]!
    expect(toolResult.role).toBe('user')
    expect(toolResult.content[0]?.type).toBe('tool_result')
  })

  it('captura errores de tool como tool_result is_error=true', async () => {
    const bad = defineTool({
      name: 'bad',
      description: '',
      schema: z.object({}),
      execute: async () => {
        throw new Error('kaboom')
      },
    })
    const provider = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'bad', input: {} }] },
      { text: 'me enteré' },
    ])
    const events: AgentEvent[] = []
    const session = createAgentSession({ provider, tools: [bad] })
    session.subscribe((e) => events.push(e))
    await session.prompt('go')
    const errEv = events.find((e) => e.type === 'tool_execution_end') as Extract<
      AgentEvent,
      { type: 'tool_execution_end' }
    >
    expect(errEv.isError).toBe(true)
    expect(errEv.output).toContain('kaboom')
  })
})
