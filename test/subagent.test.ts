import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent/session.js'
import { createSubagentTool } from '../src/agent/subagent.js'
import { MockProvider } from './mock-provider.js'
import type { ToolResultBlock } from '../src/types.js'

describe('createSubagentTool (agent-as-tool)', () => {
  it('delegates to a child agent and returns its final text as the tool result', async () => {
    const childProvider = new MockProvider([
      { text: 'El clima es soleado, 22°C.', stopReason: 'end_turn' },
    ])
    const research = createSubagentTool({
      name: 'research_agent',
      description: 'Delegate research tasks',
      provider: childProvider,
    })

    const parentProvider = new MockProvider([
      {
        toolCalls: [{ id: 't1', name: 'research_agent', input: { task: 'investiga el clima' } }],
        stopReason: 'tool_use',
      },
      { text: 'Listo.', stopReason: 'end_turn' },
    ])

    const parent = await createAgent({ provider: parentProvider, tools: [research] })
    await parent.run('averiguá el clima')

    // The child saw exactly one turn with the delegated task as the user prompt.
    expect(childProvider.calls).toHaveLength(1)
    // MockProvider stores the messages array by reference, so read the first
    // (user) message rather than the last, which the loop mutates post-stream.
    const childUserMsg = childProvider.calls[0]!.messages[0]!
    expect(childUserMsg.content[0]).toEqual({ type: 'text', text: 'investiga el clima' })

    // The parent's tool_result carries the child's distilled answer.
    const msgs = parent.getMessages()
    const toolResult = msgs[2]!.content[0] as ToolResultBlock
    expect(toolResult.type).toBe('tool_result')
    expect(toolResult.content).toBe('El clima es soleado, 22°C.')
    expect(toolResult.is_error).toBe(false)
  })

  it('supports a custom input key', async () => {
    const childProvider = new MockProvider([{ text: 'done', stopReason: 'end_turn' }])
    const sub = createSubagentTool({
      name: 'worker',
      description: 'worker',
      provider: childProvider,
      inputKey: 'goal',
    })
    const parentProvider = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'worker', input: { goal: 'hacelo' } }], stopReason: 'tool_use' },
      { text: 'ok', stopReason: 'end_turn' },
    ])
    const parent = await createAgent({ provider: parentProvider, tools: [sub] })
    await parent.run('go')

    const childUserMsg = childProvider.calls[0]!.messages[0]!
    expect(childUserMsg.content[0]).toEqual({ type: 'text', text: 'hacelo' })
  })

  it('returns a placeholder when the child produces no text', async () => {
    const childProvider = new MockProvider([{ stopReason: 'end_turn' }])
    const sub = createSubagentTool({ name: 'empty', description: 'empty', provider: childProvider })
    const parentProvider = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'empty', input: { task: 'x' } }], stopReason: 'tool_use' },
      { text: 'ok', stopReason: 'end_turn' },
    ])
    const parent = await createAgent({ provider: parentProvider, tools: [sub] })
    await parent.run('go')

    const toolResult = parent.getMessages()[2]!.content[0] as ToolResultBlock
    expect(toolResult.content).toBe('(subagent produced no text output)')
  })
})
