import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createAgent } from '../src/agent/session.js'
import { tool } from '../src/tools/define.js'
import { MockProvider } from './mock-provider.js'
import { InMemorySessionManager } from '../src/agent/sessionManager.js'
import type { AgentEvent } from '../src/types.js'

describe('loop variants & heartbeat', () => {
  it('initializes with the correct pattern', async () => {
    const provider = new MockProvider([{ text: 'ok' }])
    const agent = await createAgent({ provider, pattern: 'PLAN_EXECUTE' })
    expect(agent.pattern).toBe('PLAN_EXECUTE')
  })

  it('runs a periodic heartbeat and emits ticks', async () => {
    const provider = new MockProvider([
      { text: 'Heartbeat response 1' },
      { text: 'Heartbeat response 2' },
      { text: 'Heartbeat response 3' },
    ])

    const events: AgentEvent[] = []
    const agent = await createAgent({
      provider,
      heartbeat: {
        intervalMs: 15,
        checkPrompt: 'check-status',
      },
    })

    agent.on('event', (e) => events.push(e))

    // Wait for a couple of heartbeat intervals
    await new Promise((resolve) => setTimeout(resolve, 50))
    agent.stopHeartbeat()

    const ticks = events.filter((e) => e.type === 'heartbeat_tick')
    expect(ticks.length).toBeGreaterThanOrEqual(1)
    expect((ticks[0] as any).checkPrompt).toBe('check-status')

    // Verify the provider was called
    expect(provider.calls.length).toBeGreaterThanOrEqual(1)
    expect(provider.calls[0]?.messages[0]?.content[0]).toMatchObject({
      type: 'text',
      text: 'check-status',
    })
  })

  it('prevents concurrency by throwing on simultaneous run() calls', async () => {
    // Mock tool that runs slowly
    const slow = tool({
      name: 'slow',
      description: 'slow',
      schema: z.object({}),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return 'done'
      },
    })

    const provider = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'slow', input: {} }] },
      { text: 'final text' },
    ])

    const agent = await createAgent({ provider, tools: [slow] })

    const p1 = agent.run('start')
    // Calling run again while p1 is in flight must throw a concurrency error
    await expect(agent.run('concurrent')).rejects.toThrow('Agent is already running a task.')

    await p1
  })

  it('drops the heartbeat tick if the agent is already running a task', async () => {
    const slow = tool({
      name: 'slow',
      description: 'slow',
      schema: z.object({}),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
        return 'done'
      },
    })

    const provider = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'slow', input: {} }] },
      { text: 'done' },
      { text: 'heartbeat done' },
    ])

    const agent = await createAgent({
      provider,
      tools: [slow],
      heartbeat: {
        intervalMs: 10,
        checkPrompt: 'check',
      },
    })

    // Turn off the heartbeat manually at the start to control it
    agent.stopHeartbeat()

    // Start a slow run
    const runPromise = agent.run('start slow task')

    // Start the heartbeat while it runs
    agent.startHeartbeat()

    // Wait 25ms, during which at least one heartbeat tick should have occurred
    await new Promise((resolve) => setTimeout(resolve, 25))

    agent.stopHeartbeat()
    await runPromise

    // The heartbeat should have dropped the ticks during execution, so it should not have started any prompt
    // The provider should only have seen the calls from the manual run (2 turns: tool call + text response)
    expect(provider.calls.length).toBe(2)
  })

  it('supports PLAN_EXECUTE and manages the plan via tools and prompt', async () => {
    const provider = new MockProvider([
      {
        toolCalls: [
          { id: 'p1', name: 'add_plan_item', input: { description: 'Write tests' } },
          { id: 'p2', name: 'add_plan_item', input: { description: 'Run tests' } },
        ],
        stopReason: 'tool_use',
      },
      {
        toolCalls: [
          { id: 'p3', name: 'update_plan_item', input: { id: 'TO_BE_REPLACED', status: 'completed' } },
        ],
        stopReason: 'tool_use',
      },
      { text: 'Plan completed.', stopReason: 'end_turn' },
    ])

    const agent = await createAgent({
      provider,
      pattern: 'PLAN_EXECUTE',
      hooks: {
        beforeToolExecution: async ({ toolName, input }) => {
          if (toolName === 'update_plan_item') {
            const raw = input as { id: string; status: string }
            if (raw.id === 'TO_BE_REPLACED') {
              const item = agent.getPlan().find((i) => i.description === 'Write tests')
              if (item) {
                raw.id = item.id
              }
            }
          }
          return { authorize: true }
        }
      }
    })

    expect(agent.getPlan()).toHaveLength(0)

    // Run the agent
    await agent.run('Organize the work')

    const plan = agent.getPlan()
    expect(plan).toHaveLength(2)
    expect(plan.find((i) => i.description === 'Write tests')?.status).toBe('completed')
    expect(plan.find((i) => i.description === 'Run tests')?.status).toBe('pending')

    // Verify the plan was injected dynamically into the system prompt on every turn
    expect(provider.calls[0]?.systemPrompt).toContain('[Active Plan State]')
    expect(provider.calls[0]?.systemPrompt).toContain('(No tasks defined yet. Use add_plan_item tool to define tasks)')
    expect(provider.calls[1]?.systemPrompt).toContain('[Active Plan State]')
    expect(provider.calls[1]?.systemPrompt).toContain('Write tests')
    expect(provider.calls[1]?.systemPrompt).toContain('Run tests')
    expect(provider.calls[2]?.systemPrompt).toContain('- [COMPLETED] Write tests')
  })

  it('assigns sequential short ids to plan items', async () => {
    const provider = new MockProvider([
      {
        toolCalls: [
          { id: 'a', name: 'add_plan_item', input: { description: 'Task one' } },
          { id: 'b', name: 'add_plan_item', input: { description: 'Task two' } },
        ],
        stopReason: 'tool_use',
      },
      { text: 'done', stopReason: 'end_turn' },
    ])

    const agent = await createAgent({ provider, pattern: 'PLAN_EXECUTE' })
    await agent.run('plan')

    expect(agent.getPlan().map((i) => i.id)).toEqual(['1', '2'])
  })

  it('persists the plan in metadata and restores it when the session is recreated', async () => {
    const manager = new InMemorySessionManager()
    const sessionId = 'plan-persist-1'

    const provider1 = new MockProvider([
      {
        toolCalls: [
          { id: 'a', name: 'add_plan_item', input: { description: 'Write tests' } },
          { id: 'b', name: 'add_plan_item', input: { description: 'Run tests' } },
        ],
        stopReason: 'tool_use',
      },
      {
        toolCalls: [{ id: 'c', name: 'update_plan_item', input: { id: '1', status: 'completed' } }],
        stopReason: 'tool_use',
      },
      { text: 'ok', stopReason: 'end_turn' },
    ])

    const agent1 = await createAgent({
      provider: provider1,
      pattern: 'PLAN_EXECUTE',
      sessionManager: manager,
      sessionId,
    })
    await agent1.run('organize')
    expect(agent1.getPlan()).toHaveLength(2)

    // Recreate the session against the same manager: the plan must be restored.
    const agent2 = await createAgent({
      provider: new MockProvider([{ text: 'noop' }]),
      pattern: 'PLAN_EXECUTE',
      sessionManager: manager,
      sessionId,
    })

    const restored = agent2.getPlan()
    expect(restored).toHaveLength(2)
    expect(restored.find((i) => i.description === 'Write tests')?.status).toBe('completed')
    expect(restored.find((i) => i.description === 'Run tests')?.status).toBe('pending')

    // The counter continues from the highest restored id (it does not reset to 1).
    const provider3 = new MockProvider([
      {
        toolCalls: [{ id: 'd', name: 'add_plan_item', input: { description: 'New task' } }],
        stopReason: 'tool_use',
      },
      { text: 'ok', stopReason: 'end_turn' },
    ])
    const agent3 = await createAgent({
      provider: provider3,
      pattern: 'PLAN_EXECUTE',
      sessionManager: manager,
      sessionId,
    })
    await agent3.run('add one more')
    expect(agent3.getPlan().find((i) => i.description === 'New task')?.id).toBe('3')
  })

  it('latent heartbeat with localCondition only calls the LLM if the condition is true', async () => {
    const provider = new MockProvider([
      { text: 'Heartbeat response' },
    ])

    let conditionValue = false
    const events: AgentEvent[] = []
    const agent = await createAgent({
      provider,
      heartbeat: {
        intervalMs: 10,
        checkPrompt: 'check-status',
        localCondition: () => conditionValue,
      },
    })
    agent.on('event', (e) => events.push(e))

    // Wait for ticks to pass with conditionValue = false
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(provider.calls.length).toBe(0) // The LLM must not have been called

    // Change the condition to true
    conditionValue = true
    await new Promise((resolve) => setTimeout(resolve, 30))
    agent.stopHeartbeat()

    expect(provider.calls.length).toBeGreaterThanOrEqual(1) // The LLM must have been called
  })

  it('heartbeat stops automatically via maxTicks and timeoutMs', async () => {
    const provider = new MockProvider([
      { text: 'Heartbeat response 1' },
      { text: 'Heartbeat response 2' },
      { text: 'Heartbeat response 3' },
    ])

    const agent = await createAgent({
      provider,
      heartbeat: {
        intervalMs: 10,
        checkPrompt: 'check-status',
        maxTicks: 2,
      },
    })

    // Wait enough ticks for it to shut off via maxTicks
    await new Promise((resolve) => setTimeout(resolve, 40))
    // When it shuts off via maxTicks (2 ticks), it must not keep calling
    const callsAfterTicks = provider.calls.length
    expect(callsAfterTicks).toBe(2)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(provider.calls.length).toBe(2) // Must not have incremented
  })

  it('heartbeat does not auto-start if autoStart is false', async () => {
    const provider = new MockProvider([{ text: 'Heartbeat response' }])
    const agent = await createAgent({
      provider,
      heartbeat: {
        intervalMs: 10,
        checkPrompt: 'check-status',
        autoStart: false,
      },
    })

    // Wait for one heartbeat interval
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(provider.calls.length).toBe(0) // Must not have started automatically

    // Start it manually
    agent.startHeartbeat()
    await new Promise((resolve) => setTimeout(resolve, 25))
    agent.stopHeartbeat()
    expect(provider.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('heartbeat stops via the default timeoutMs of 300000ms', async () => {
    vi.useFakeTimers()
    const provider = new MockProvider([
      { text: 'Heartbeat response 1' },
      { text: 'Heartbeat response 2' },
      { text: 'Heartbeat response 3' },
    ])

    const agent = await createAgent({
      provider,
      heartbeat: {
        intervalMs: 100000,
        checkPrompt: 'check-status',
      },
    })

    // At 105s, tick 1
    await vi.advanceTimersByTimeAsync(105000)
    expect(provider.calls.length).toBe(1)

    // At 205s, tick 2
    await vi.advanceTimersByTimeAsync(100000)
    expect(provider.calls.length).toBe(2)

    // At 305s (the timeout already fired at 300s)
    await vi.advanceTimersByTimeAsync(100000)

    // At 405s, it should not have incremented
    await vi.advanceTimersByTimeAsync(100000)
    expect(provider.calls.length).toBe(2)

    vi.useRealTimers()
  })
})
