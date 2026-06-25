import { describe, expect, it } from 'vitest'
import { AstorAgent } from '../src/agent/facade.js'
import { SessionManager } from '../src/agent/sessionManager.js'
import { MockProvider } from './mock-provider.js'
import type { AgentEvent } from '../src/types.js'

describe('AstorAgent Facade', () => {
  it('run executes correctly and auto-initializes', async () => {
    const manager = SessionManager.inMemory()
    const provider = new MockProvider([
      { text: 'Facade response', stopReason: 'end_turn' },
    ])

    const agent = new AstorAgent({
      provider,
      sessionManager: manager,
      tools: [], // No tools for this test
      defaultOutputMode: 'silent',
    })

    const result = await agent.run('hello facade', { sessionId: 'test-facade' })
    expect(result.sessionId).toBe('test-facade')
    expect(result.text).toBe('Facade response')

    // Verify it persisted in the manager
    const saved = await manager.get('test-facade')
    expect(saved).not.toBeNull()
    expect(saved!.messages).toHaveLength(2)
    expect(saved!.messages[0]!.content[0]!.type).toBe('text')
    expect((saved!.messages[0]!.content[0] as any).text).toBe('hello facade')
  })

  it('supports a custom logger / outputMode callback', async () => {
    const provider = new MockProvider([
      { text: 'Logger response', stopReason: 'end_turn' },
    ])

    const agent = new AstorAgent({
      provider,
      tools: [],
      defaultOutputMode: 'silent',
    })

    const events: AgentEvent[] = []
    const customCallback = (e: AgentEvent) => {
      events.push(e)
    }

    await agent.run('test callback', { outputMode: customCallback })

    expect(events.length).toBeGreaterThan(0)
    // Should contain text_delta
    const textDeltas = events.filter((e) => e.type === 'text_delta')
    expect(textDeltas.length).toBeGreaterThan(0)
  })

  it('fork performs branching and allows running an instruction on the child branch', async () => {
    const manager = SessionManager.inMemory()
    const provider = new MockProvider([
      { text: 'Branch response', stopReason: 'end_turn' },
    ])

    const agent = new AstorAgent({
      provider,
      sessionManager: manager,
      tools: [],
      defaultOutputMode: 'silent',
    })

    // Create the parent session and seed it with some messages
    const parent = await manager.create({ id: 'parent' })
    parent.messages = [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'origin' }] },
      { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'response' }] },
    ]
    await manager.save(parent)

    // Create the branch and interact
    const branchAgent = await agent.fork({
      parentId: 'parent',
      branchFromMessageId: 'm2',
      newSessionId: 'child',
    })

    const result = await branchAgent.run('continuation')

    expect(result.sessionId).toBe('child')
    expect(result.text).toBe('Branch response')

    // Verify the child has 4 messages (inherited m1, m2, plus the new prompt/response)
    const childState = await manager.get('child')
    expect(childState!.messages).toHaveLength(4)
    expect(childState!.messages[0]!.id).toBe('m1')
    expect(childState!.messages[1]!.id).toBe('m2')
  })
})
