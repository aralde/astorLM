import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent } from '../src/agent/session.js'
import { tool } from '../src/tools/define.js'
import { createSteeringController } from '../src/agent/steering.js'
import { MockProvider } from './mock-provider.js'
import type { AgentEvent, ToolResultBlock } from '../src/types.js'

describe('createSteeringController', () => {
  const makeTool = (calls: string[]) =>
    tool({
      name: 'act',
      description: 'act',
      schema: z.object({}),
      execute: async () => {
        calls.push('ran')
        return 'real result'
      },
    })

  it('steers the next tool call when feedback is queued', async () => {
    const calls: string[] = []
    const provider = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'act', input: {} }], stopReason: 'tool_use' },
      { text: 'Reconsidering.', stopReason: 'end_turn' },
    ])

    const controller = createSteeringController()
    const events: AgentEvent[] = []
    const session = await createAgent({
      provider,
      tools: [makeTool(calls)],
      hooks: controller.hooks,
    })
    session.on('event', (e) => events.push(e))

    controller.steer('Better use a different approach')
    await session.run('go')

    // The real tool never ran; the queued feedback was consumed.
    expect(calls).toEqual([])
    expect(controller.pending).toBeNull()

    const blocks = session.getMessages()[2]!.content
    expect(blocks[0]).toMatchObject({ is_error: true, content: 'Better use a different approach' } as Partial<ToolResultBlock>)
    expect(blocks.at(-1)).toEqual({
      type: 'text',
      text: '[User Steering Feedback]: Better use a different approach',
    })

    const steerEv = events.find((e) => e.type === 'user_steering')
    expect(steerEv).toBeDefined()
  })

  it('delegates to the base hook when nothing is queued', async () => {
    const calls: string[] = []
    let baseSaw = 0
    const provider = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'act', input: {} }], stopReason: 'tool_use' },
      { text: 'ok', stopReason: 'end_turn' },
    ])

    const controller = createSteeringController({
      beforeToolExecution: async () => {
        baseSaw++
        return { authorize: true }
      },
    })
    const session = await createAgent({
      provider,
      tools: [makeTool(calls)],
      hooks: controller.hooks,
    })
    await session.run('go')

    expect(baseSaw).toBe(1)
    expect(calls).toEqual(['ran'])
  })
})
