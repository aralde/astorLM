import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent/session.js'
import { runGoalLoop } from '../src/agent/goalLoop.js'
import { MockProvider } from './mock-provider.js'

describe('runGoalLoop (goal-seeking / Ralph loop)', () => {
  it('runs a fresh agent per iteration and stops when isDone is true', async () => {
    const providers: MockProvider[] = []
    let isDoneCalls = 0

    const result = await runGoalLoop({
      goal: 'make the tests pass',
      createIterationAgent: async () => {
        const provider = new MockProvider([
          { text: 'working on it', stopReason: 'end_turn' },
        ])
        providers.push(provider)
        return createAgent({ provider })
      },
      // Done on the third iteration.
      isDone: () => {
        isDoneCalls++
        return isDoneCalls >= 3
      },
    })

    expect(result.done).toBe(true)
    expect(result.stopReason).toBe('done')
    expect(result.iterations).toBe(3)
    expect(result.lastText).toBe('working on it')
    // A brand new agent (and provider) was built for each iteration — fresh context.
    expect(providers).toHaveLength(3)
    // Each provider saw exactly one turn (its own session, no accumulation).
    for (const p of providers) expect(p.calls).toHaveLength(1)
  })

  it('feeds the goal as the iteration prompt by default', async () => {
    const provider = new MockProvider([{ text: 'ok', stopReason: 'end_turn' }])
    await runGoalLoop({
      goal: 'migrate to pydantic v2',
      createIterationAgent: async () => createAgent({ provider }),
      isDone: () => true,
    })

    const userMsg = provider.calls[0]!.messages[0]!
    expect(userMsg.content[0]).toEqual({ type: 'text', text: 'migrate to pydantic v2' })
  })

  it('honors a custom iterationPrompt builder', async () => {
    const provider = new MockProvider([{ text: 'ok', stopReason: 'end_turn' }])
    await runGoalLoop({
      goal: 'the goal',
      createIterationAgent: async () => createAgent({ provider }),
      iterationPrompt: (ctx) => `iteration ${ctx.iteration}: ${ctx.goal}`,
      isDone: () => true,
    })

    const userMsg = provider.calls[0]!.messages[0]!
    expect(userMsg.content[0]).toEqual({ type: 'text', text: 'iteration 1: the goal' })
  })

  it('stops at maxIterations when the goal is never met', async () => {
    let built = 0
    const result = await runGoalLoop({
      goal: 'unreachable',
      maxIterations: 4,
      createIterationAgent: async () => {
        built++
        return createAgent({ provider: new MockProvider([{ text: 'nope', stopReason: 'end_turn' }]) })
      },
      isDone: () => false,
    })

    expect(result.done).toBe(false)
    expect(result.stopReason).toBe('max_iterations')
    expect(result.iterations).toBe(4)
    expect(built).toBe(4)
  })

  it('fires onIteration after each iteration with the iteration context', async () => {
    const seen: Array<{ iteration: number; lastText: string }> = []
    await runGoalLoop({
      goal: 'g',
      maxIterations: 2,
      createIterationAgent: async () =>
        createAgent({ provider: new MockProvider([{ text: 'step', stopReason: 'end_turn' }]) }),
      onIteration: (ctx) => {
        seen.push({ iteration: ctx.iteration, lastText: ctx.lastText })
      },
      isDone: () => false,
    })

    expect(seen).toEqual([
      { iteration: 1, lastText: 'step' },
      { iteration: 2, lastText: 'step' },
    ])
  })

  it('stops immediately when the abort signal is already aborted', async () => {
    let built = 0
    const result = await runGoalLoop({
      goal: 'g',
      abortSignal: AbortSignal.abort(),
      createIterationAgent: async () => {
        built++
        return createAgent({ provider: new MockProvider([{ text: 'x', stopReason: 'end_turn' }]) })
      },
      isDone: () => true,
    })

    expect(result.stopReason).toBe('aborted')
    expect(result.iterations).toBe(0)
    expect(built).toBe(0)
  })
})
