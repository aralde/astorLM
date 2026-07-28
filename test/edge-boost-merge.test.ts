import { describe, expect, it, vi } from 'vitest'
import { mergeSessionHooks } from '../src/experimental/edge-boost/mergeHooks.js'
import type { Message, SessionHooks } from '../src/types.js'

const provCtx = () => ({
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }] as Message[],
  systemPrompt: 'sys',
  tools: [{ name: 'a', description: '', inputSchema: {} }],
  cwd: '/',
})

const toolCtx = () => ({ toolName: 't', input: {}, toolUseId: 'u1', cwd: '/' })

describe('mergeSessionHooks', () => {
  it('runs beforeTurn/afterTurn first then second', async () => {
    const order: string[] = []
    const a: SessionHooks = {
      beforeTurn: async () => void order.push('a.before'),
      afterTurn: async () => void order.push('a.after'),
    }
    const b: SessionHooks = {
      beforeTurn: async () => void order.push('b.before'),
      afterTurn: async () => void order.push('b.after'),
    }
    const m = mergeSessionHooks(a, b)
    await m.beforeTurn!({ turn: 1, accumulatedTurns: 1, messages: [], sessionUsage: { inputTokens: 0, outputTokens: 0 }, cwd: '/' })
    await m.afterTurn!({ turn: 1, lastMessage: { role: 'assistant', content: [] }, cwd: '/' })
    expect(order).toEqual(['a.before', 'b.before', 'a.after', 'b.after'])
  })

  it('chains beforeProviderCall; later toolChoice/tools win', async () => {
    const a: SessionHooks = {
      beforeProviderCall: async ({ messages, systemPrompt, tools }) => ({
        messages,
        systemPrompt: systemPrompt + '+a',
        tools,
        toolChoice: 'required',
      }),
    }
    const b: SessionHooks = {
      beforeProviderCall: async ({ messages, systemPrompt, tools }) => ({
        messages,
        systemPrompt: systemPrompt + '+b',
        tools: [],
        toolChoice: 'none',
      }),
    }
    const m = mergeSessionHooks(a, b)
    const res = await m.beforeProviderCall!(provCtx())
    expect(res.systemPrompt).toBe('sys+a+b')
    expect(res.tools).toEqual([])
    expect(res.toolChoice).toBe('none')
  })

  it('combines beforeToolExecution: authorize AND, first-defined mockResult, steer OR', async () => {
    const a: SessionHooks = {
      beforeToolExecution: async () => ({ authorize: true, mockResult: 'A' }),
    }
    const b: SessionHooks = {
      beforeToolExecution: async () => ({ authorize: false, mockResult: 'B', steer: true, feedback: 'stop' }),
    }
    const m = mergeSessionHooks(a, b)
    const res = await m.beforeToolExecution!(toolCtx())
    expect(res.authorize).toBe(false)
    expect(res.mockResult).toBe('A') // first defined wins
    expect(res.steer).toBe(true)
    expect(res.feedback).toBe('stop')
  })

  it('chains afterToolExecution: second sees first output', async () => {
    const a: SessionHooks = { afterToolExecution: async ({ output }) => output + '-a' }
    const b: SessionHooks = { afterToolExecution: async ({ output }) => output + '-b' }
    const m = mergeSessionHooks(a, b)
    const res = await m.afterToolExecution!({
      toolName: 't',
      input: {},
      output: 'x',
      durationMs: 1,
      isError: false,
      cwd: '/',
    })
    expect(res).toBe('x-a-b')
  })

  it('uses the single side as-is when only one defines a hook, and returns second when first is undefined', () => {
    const spy = vi.fn()
    const only: SessionHooks = { beforeTurn: spy }
    expect(mergeSessionHooks(undefined, only)).toBe(only)
    const m = mergeSessionHooks({ afterTurn: async () => {} }, only)
    expect(m.beforeTurn).toBeTypeOf('function')
    expect(m.afterTurn).toBeTypeOf('function')
  })
})
