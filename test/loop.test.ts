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
    const session = await createAgentSession({ provider, cwd: dir, tools: [greet] })
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
    const session = await createAgentSession({ provider, tools: [echo] })
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
    const session = await createAgentSession({ provider, tools: [bad] })
    session.subscribe((e) => events.push(e))
    await session.prompt('go')
    const errEv = events.find((e) => e.type === 'tool_execution_end') as Extract<
      AgentEvent,
      { type: 'tool_execution_end' }
    >
    expect(errEv.isError).toBe(true)
    expect(errEv.output).toContain('kaboom')
  })

  it('session.abort() cancela el prompt en vuelo', async () => {
    const slow = defineTool({
      name: 'slow',
      description: 'demora',
      schema: z.object({}),
      execute: async (_input, ctx) => {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 500)
          ctx.abortSignal.addEventListener(
            'abort',
            () => {
              clearTimeout(t)
              resolve()
            },
            { once: true },
          )
        })
        return 'done'
      },
    })
    const provider = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'slow', input: {} }] },
      { text: 'no debería llegar acá' },
    ])
    const events: AgentEvent[] = []
    const session = await createAgentSession({ provider, tools: [slow] })
    session.subscribe((e) => events.push(e))

    const pending = session.prompt('go')
    setTimeout(() => session.abort(), 20)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    const last = events[events.length - 1]
    expect(last?.type).toBe('session_end')
    expect((last as Extract<AgentEvent, { type: 'session_end' }>).reason).toBe('aborted')
  })

  it('session.abort() sin prompt en vuelo es no-op', async () => {
    const provider = new MockProvider([])
    const session = await createAgentSession({ provider })
    expect(() => session.abort()).not.toThrow()
  })

  it('ejecuta los SessionHooks correctamente y permite interceptar el ciclo de vida', async () => {
    const double = defineTool({
      name: 'double',
      description: 'duplica',
      schema: z.object({ n: z.number() }),
      execute: async ({ n }) => `${n * 2}`,
    })

    const provider = new MockProvider([
      {
        toolCalls: [{ id: 'tu_double', name: 'double', input: { n: 10 } }],
        stopReason: 'tool_use',
      },
      { text: 'Resultado final.', stopReason: 'end_turn' },
    ])

    const hooksLog: string[] = []
    const session = await createAgentSession({
      provider,
      tools: [double],
      systemPrompt: 'Original prompt',
      hooks: {
        beforeTurn: async ({ turn, messages }) => {
          hooksLog.push(`beforeTurn:${turn}:${messages.length}`)
        },
        beforeProviderCall: async ({ messages, systemPrompt }) => {
          hooksLog.push(`beforeProviderCall:${systemPrompt}`)
          return { messages, systemPrompt: `${systemPrompt} + Hooked` }
        },
        beforeToolExecution: async ({ toolName, input, toolUseId }) => {
          hooksLog.push(`beforeToolExecution:${toolName}:${input.n}`)
          if (toolName === 'double' && input.n === 999) {
            return { authorize: false } // won't happen here
          }
          return { authorize: true }
        },
        afterToolExecution: async ({ toolName, input, output, durationMs }) => {
          hooksLog.push(`afterToolExecution:${toolName}:${output}`)
          return `${output} + HookedOutput`
        },
        afterTurn: async ({ turn, lastMessage }) => {
          hooksLog.push(`afterTurn:${turn}`)
        },
      },
    })

    await session.prompt('Calcula el doble de 10')

    expect(hooksLog).toHaveLength(8)
    expect(hooksLog[0]).toBe('beforeTurn:1:1')
    expect(hooksLog[1]).toContain('Original prompt')
    expect(hooksLog[2]).toBe('beforeToolExecution:double:10')
    expect(hooksLog[3]).toBe('afterToolExecution:double:20')
    expect(hooksLog[4]).toBe('afterTurn:1')
    expect(hooksLog[5]).toBe('beforeTurn:2:3')
    expect(hooksLog[6]).toContain('Original prompt')
    expect(hooksLog[7]).toBe('afterTurn:2')

    const msgs = session.getMessages()
    // Verify tool result got modified by afterToolExecution
    const toolResultMsg = msgs[2]!
    expect(toolResultMsg.role).toBe('user')
    expect(toolResultMsg.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_double',
      content: '20 + HookedOutput',
      is_error: false,
    })
  })

  it('beforeToolExecution puede denegar autorizacion o mockear resultados', async () => {
    const compute = defineTool({
      name: 'compute',
      description: 'calcula',
      schema: z.object({ x: z.number() }),
      execute: async () => 'real result',
    })

    const provider = new MockProvider([
      {
        toolCalls: [
          { id: 'tu_deny', name: 'compute', input: { x: 1 } },
          { id: 'tu_mock', name: 'compute', input: { x: 2 } },
        ],
        stopReason: 'tool_use',
      },
      { text: 'Fin.', stopReason: 'end_turn' },
    ])

    const session = await createAgentSession({
      provider,
      tools: [compute],
      hooks: {
        beforeToolExecution: async ({ toolUseId }) => {
          if (toolUseId === 'tu_deny') {
            return { authorize: false }
          }
          if (toolUseId === 'tu_mock') {
            return { authorize: true, mockResult: 'mocked result' }
          }
          return { authorize: true }
        },
      },
    })

    await session.prompt('Ejecuta las tools')
    const msgs = session.getMessages()
    const toolResultMsg = msgs[2]!
    expect(toolResultMsg.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_deny',
        content: 'Execution rejected by user policy.',
        is_error: true,
      },
      {
        type: 'tool_result',
        tool_use_id: 'tu_mock',
        content: 'mocked result',
        is_error: false,
      },
    ])
  })
})
