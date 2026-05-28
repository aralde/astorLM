import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent } from '../src/agent/session.js'
import { tool } from '../src/tools/define.js'
import { MockProvider } from './mock-provider.js'
import type { AgentEvent } from '../src/types.js'
import { ContractViolationError, createContractHooks } from '../src/experimental/contract/index.js'

describe('Agent Contract', () => {
  describe('Presupuesto (Budget)', () => {
    it('detiene la ejecución si se supera maxTurns', async () => {
      const provider = new MockProvider([
        { text: 'turno 1', stopReason: 'end_turn' },
        { text: 'turno 2', stopReason: 'end_turn' },
      ])

      const contract = {
        budget: {
          maxTurns: 1,
        },
      }

      const events: AgentEvent[] = []
      const session = await createAgent({ provider, hooks: createContractHooks(contract) })
      session.on('event', (e) => events.push(e))

      // El primer run consume 1 turno.
      await session.run('go')
      expect(session.getMessages()).toHaveLength(2)

      // El segundo run intentaría ejecutar un segundo turno.
      // Debe lanzar ContractViolationError.
      await expect(session.run('go')).rejects.toThrow(ContractViolationError)

      const violation = events.find((e) => e.type === 'contract_violation')
      expect(violation).toBeDefined()
      expect(violation?.type).toBe('contract_violation')
      expect((violation as any).rule).toBe('budget.maxTurns')
    })

    it('detiene la ejecución si se supera maxTotalTokens', async () => {
      const provider = new MockProvider([
        {
          text: 'respuesta 1',
          usage: { inputTokens: 50, outputTokens: 60 },
          stopReason: 'end_turn',
        },
      ])

      const contract = {
        budget: {
          maxTotalTokens: 100, // 50+60=110 > 100
        },
      }

      const events: AgentEvent[] = []
      const session = await createAgent({ provider, hooks: createContractHooks(contract) })
      session.on('event', (e) => events.push(e))

      // En el turno 1, el usage reportado es 110. Al iniciar el turno 2 (en una run posterior, o al evaluarse en el loop):
      // Primero hacemos el run 1, que debería tener éxito porque la validación se hace al inicio del turno.
      // Esperamos que en el run 1 pase la validación del turno 1 (donde sessionUsage es 0).
      await session.run('go')
      expect(session.getUsage().inputTokens).toBe(50)
      expect(session.getUsage().outputTokens).toBe(60)

      // Intentamos run 2, debe lanzar error por superar límite total
      await expect(session.run('go')).rejects.toThrow(ContractViolationError)

      const violation = events.find((e) => e.type === 'contract_violation')
      expect(violation).toBeDefined()
      expect((violation as any).rule).toBe('budget.maxTotalTokens')
    })
  })

  describe('Control de Herramientas (Tools)', () => {
    it('filtra las herramientas expuestas al provider', async () => {
      const toolA = tool({
        name: 'toolA',
        description: 'a',
        schema: z.object({}),
        execute: async () => 'a',
      })
      const toolB = tool({
        name: 'toolB',
        description: 'b',
        schema: z.object({}),
        execute: async () => 'b',
      })

      const provider = new MockProvider([{ text: 'ok' }])
      const contract = {
        tools: {
          allow: ['toolA'],
        },
      }

      const session = await createAgent({
        provider,
        tools: [toolA, toolB],
        hooks: createContractHooks(contract),
      })

      await session.run('go')

      // Verificar las herramientas enviadas al provider en la última llamada
      const lastCall = provider.calls[provider.calls.length - 1]
      expect(lastCall?.tools).toHaveLength(1)
      expect(lastCall?.tools[0]?.name).toBe('toolA')
    })

    it('bloquea la ejecución de herramientas denegadas', async () => {
      const toolA = tool({
        name: 'toolA',
        description: 'a',
        schema: z.object({}),
        execute: async () => 'a',
      })

      const provider = new MockProvider([
        {
          toolCalls: [{ id: 'tc1', name: 'toolA', input: {} }],
          stopReason: 'tool_use',
        },
        { text: 'done' },
      ])

      const contract = {
        tools: {
          deny: ['toolA'],
        },
      }

      const events: AgentEvent[] = []
      const session = await createAgent({ provider, tools: [toolA], hooks: createContractHooks(contract) })
      session.on('event', (e) => events.push(e))

      await expect(session.run('go')).rejects.toThrow(ContractViolationError)

      const violation = events.find((e) => e.type === 'contract_violation')
      expect(violation).toBeDefined()
      expect((violation as any).rule).toBe('tools.toolA')
    })
  })

  describe('Sandbox - Filesystem Paths', () => {
    it('permite rutas dentro de allowedPaths', async () => {
      const dummyRead = tool({
        name: 'read',
        description: 'lee un archivo',
        schema: z.object({ path: z.string() }),
        execute: async ({ path }) => `contenido de ${path}`,
      })

      const provider = new MockProvider([
        {
          toolCalls: [
            { id: 'tc1', name: 'read', input: { path: 'src/index.ts' } },
          ],
          stopReason: 'tool_use',
        },
        { text: 'fin' },
      ])

      const contract = {
        sandbox: {
          allowedPaths: ['src/**/*'],
        },
      }

      const session = await createAgent({
        provider,
        tools: [dummyRead],
        hooks: createContractHooks(contract),
        cwd: '/app',
      })

      await session.run('go')

      const msgs = session.getMessages()
      const results = msgs[2]?.content

      const res1 = results?.find((r: any) => r.tool_use_id === 'tc1')
      expect(res1?.type).toBe('tool_result')
      expect((res1 as any).is_error).toBeFalsy()
      expect((res1 as any).content).toBe('contenido de src/index.ts')
    })

    it('bloquea rutas fuera de allowedPaths', async () => {
      const dummyRead = tool({
        name: 'read',
        description: 'lee un archivo',
        schema: z.object({ path: z.string() }),
        execute: async ({ path }) => `contenido de ${path}`,
      })

      const provider = new MockProvider([
        {
          toolCalls: [
            { id: 'tc2', name: 'read', input: { path: 'secrets.json' } },
          ],
          stopReason: 'tool_use',
        },
        { text: 'fin' },
      ])

      const contract = {
        sandbox: {
          allowedPaths: ['src/**/*'],
        },
      }

      const session = await createAgent({
        provider,
        tools: [dummyRead],
        hooks: createContractHooks(contract),
        cwd: '/app',
      })

      await expect(session.run('go')).rejects.toThrow(ContractViolationError)
    })

    it('bloquea rutas explícitamente en deniedPaths', async () => {
      const dummyWrite = tool({
        name: 'write',
        description: 'escribe un archivo',
        schema: z.object({ path: z.string() }),
        execute: async ({ path }) => `escribi en ${path}`,
      })

      const provider = new MockProvider([
        {
          toolCalls: [
            { id: 'tc1', name: 'write', input: { path: 'secrets.json' } },
          ],
          stopReason: 'tool_use',
        },
        { text: 'fin' },
      ])

      const contract = {
        sandbox: {
          deniedPaths: ['secrets.json'],
        },
      }

      const session = await createAgent({
        provider,
        tools: [dummyWrite],
        hooks: createContractHooks(contract),
        cwd: '/app',
      })

      await expect(session.run('go')).rejects.toThrow(ContractViolationError)
    })
  })

  describe('Sandbox - Bash Commands', () => {
    it('permite comandos aprobados', async () => {
      const dummyBash = tool({
        name: 'bash',
        description: 'ejecuta comandos',
        schema: z.object({ command: z.string() }),
        execute: async ({ command }) => `run ${command}`,
      })

      const provider = new MockProvider([
        {
          toolCalls: [
            { id: 'tc1', name: 'bash', input: { command: 'npm test' } },
          ],
          stopReason: 'tool_use',
        },
        { text: 'done' },
      ])

      const contract = {
        sandbox: {
          bash: {
            allowedCommands: ['npm test'],
          },
        },
      }

      const session = await createAgent({
        provider,
        tools: [dummyBash],
        hooks: createContractHooks(contract),
      })

      await session.run('go')

      const msgs = session.getMessages()
      const results = msgs[2]?.content

      const res1 = results?.find((r: any) => r.tool_use_id === 'tc1')
      expect((res1 as any).is_error).toBeFalsy()
      expect((res1 as any).content).toBe('run npm test')
    })

    it('bloquea comandos no aprobados', async () => {
      const dummyBash = tool({
        name: 'bash',
        description: 'ejecuta comandos',
        schema: z.object({ command: z.string() }),
        execute: async ({ command }) => `run ${command}`,
      })

      const provider = new MockProvider([
        {
          toolCalls: [
            { id: 'tc2', name: 'bash', input: { command: 'rm -rf /' } },
          ],
          stopReason: 'tool_use',
        },
        { text: 'done' },
      ])

      const contract = {
        sandbox: {
          bash: {
            allowedCommands: ['npm test'],
          },
        },
      }

      const session = await createAgent({
        provider,
        tools: [dummyBash],
        hooks: createContractHooks(contract),
      })

      await expect(session.run('go')).rejects.toThrow(ContractViolationError)
    })

    it('bloquea comandos en deniedCommands', async () => {
      const dummyBash = tool({
        name: 'bash',
        description: 'ejecuta comandos',
        schema: z.object({ command: z.string() }),
        execute: async ({ command }) => `run ${command}`,
      })

      const provider = new MockProvider([
        {
          toolCalls: [
            { id: 'tc1', name: 'bash', input: { command: 'curl google.com' } },
          ],
          stopReason: 'tool_use',
        },
        { text: 'done' },
      ])

      const contract = {
        sandbox: {
          bash: {
            deniedCommands: ['curl', 'wget'],
          },
        },
      }

      const session = await createAgent({
        provider,
        tools: [dummyBash],
        hooks: createContractHooks(contract),
      })

      await expect(session.run('go')).rejects.toThrow(ContractViolationError)
    })
  })
})
