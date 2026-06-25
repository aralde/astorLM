import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent } from '../src/agent/session.js'
import { tool } from '../src/tools/define.js'
import { MockProvider } from './mock-provider.js'
import type { AgentEvent } from '../src/types.js'
import { ContractViolationError, createContractHooks } from '../src/experimental/contract/index.js'

describe('Agent Contract', () => {
  describe('Budget', () => {
    it('stops execution if maxTurns is exceeded', async () => {
      const provider = new MockProvider([
        { text: 'turn 1', stopReason: 'end_turn' },
        { text: 'turn 2', stopReason: 'end_turn' },
      ])

      const contract = {
        budget: {
          maxTurns: 1,
        },
      }

      const events: AgentEvent[] = []
      const session = await createAgent({ provider, hooks: createContractHooks(contract) })
      session.on('event', (e) => events.push(e))

      // The first run consumes 1 turn.
      await session.run('go')
      expect(session.getMessages()).toHaveLength(2)

      // The second run would try to execute a second turn.
      // It must throw ContractViolationError.
      await expect(session.run('go')).rejects.toThrow(ContractViolationError)

      const violation = events.find((e) => e.type === 'contract_violation')
      expect(violation).toBeDefined()
      expect(violation?.type).toBe('contract_violation')
      expect((violation as any).rule).toBe('budget.maxTurns')
    })

    it('stops execution if maxTotalTokens is exceeded', async () => {
      const provider = new MockProvider([
        {
          text: 'response 1',
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

      // On turn 1, the reported usage is 110. When starting turn 2 (in a later run, or when evaluated in the loop):
      // First we do run 1, which should succeed because validation happens at the start of the turn.
      // We expect run 1 to pass turn 1's validation (where sessionUsage is 0).
      await session.run('go')
      expect(session.getUsage().inputTokens).toBe(50)
      expect(session.getUsage().outputTokens).toBe(60)

      // We attempt run 2, it must throw an error for exceeding the total limit
      await expect(session.run('go')).rejects.toThrow(ContractViolationError)

      const violation = events.find((e) => e.type === 'contract_violation')
      expect(violation).toBeDefined()
      expect((violation as any).rule).toBe('budget.maxTotalTokens')
    })
  })

  describe('Tool Control', () => {
    it('filters the tools exposed to the provider', async () => {
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

      // Verify the tools sent to the provider on the last call
      const lastCall = provider.calls[provider.calls.length - 1]
      expect(lastCall?.tools).toHaveLength(1)
      expect(lastCall?.tools[0]?.name).toBe('toolA')
    })

    it('blocks the execution of denied tools', async () => {
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
    it('allows paths inside allowedPaths', async () => {
      const dummyRead = tool({
        name: 'read',
        description: 'reads a file',
        schema: z.object({ path: z.string() }),
        execute: async ({ path }) => `content of ${path}`,
      })

      const provider = new MockProvider([
        {
          toolCalls: [
            { id: 'tc1', name: 'read', input: { path: 'src/index.ts' } },
          ],
          stopReason: 'tool_use',
        },
        { text: 'end' },
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
      expect((res1 as any).content).toBe('content of src/index.ts')
    })

    it('blocks paths outside allowedPaths', async () => {
      const dummyRead = tool({
        name: 'read',
        description: 'reads a file',
        schema: z.object({ path: z.string() }),
        execute: async ({ path }) => `content of ${path}`,
      })

      const provider = new MockProvider([
        {
          toolCalls: [
            { id: 'tc2', name: 'read', input: { path: 'secrets.json' } },
          ],
          stopReason: 'tool_use',
        },
        { text: 'end' },
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

    it('blocks paths explicitly listed in deniedPaths', async () => {
      const dummyWrite = tool({
        name: 'write',
        description: 'writes a file',
        schema: z.object({ path: z.string() }),
        execute: async ({ path }) => `wrote to ${path}`,
      })

      const provider = new MockProvider([
        {
          toolCalls: [
            { id: 'tc1', name: 'write', input: { path: 'secrets.json' } },
          ],
          stopReason: 'tool_use',
        },
        { text: 'end' },
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
    it('allows approved commands', async () => {
      const dummyBash = tool({
        name: 'bash',
        description: 'runs commands',
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

    it('blocks unapproved commands', async () => {
      const dummyBash = tool({
        name: 'bash',
        description: 'runs commands',
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

    it('blocks commands in deniedCommands', async () => {
      const dummyBash = tool({
        name: 'bash',
        description: 'runs commands',
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
