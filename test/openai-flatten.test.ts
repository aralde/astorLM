import { describe, expect, it } from 'vitest'
import { flattenMessages } from '../src/provider/openai.js'
import type { Message } from '../src/types.js'

describe('flattenMessages (OpenAI mapping)', () => {
  it('serializes an assistant tool-call message with content "" (not null)', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'x' } }],
      },
    ]
    const out = flattenMessages(msgs)
    expect(out).toHaveLength(1)
    const m = out[0] as any
    expect(m.role).toBe('assistant')
    expect(m.content).toBe('')
    expect(m.content).not.toBeNull()
    expect(m.tool_calls).toHaveLength(1)
    expect(m.tool_calls[0]).toMatchObject({
      id: 'call_1',
      type: 'function',
      function: { name: 'search' },
    })
    expect(JSON.parse(m.tool_calls[0].function.arguments)).toEqual({ q: 'x' })
  })

  it('keeps assistant text when both text and tool_use are present', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me search' },
          { type: 'tool_use', id: 'call_2', name: 'search', input: {} },
        ],
      },
    ]
    const m = flattenMessages(msgs)[0] as any
    expect(m.content).toBe('let me search')
    expect(m.tool_calls).toHaveLength(1)
  })

  it('emits one role:tool message per tool_result, plus trailing user text', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'result A' },
          { type: 'tool_result', tool_use_id: 'call_2', content: 'result B' },
          { type: 'text', text: 'and here is more context' },
        ],
      },
    ]
    const out = flattenMessages(msgs)
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'result A' })
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'call_2', content: 'result B' })
    expect(out[2]).toEqual({ role: 'user', content: 'and here is more context' })
  })

  it('passes a system message through', () => {
    const msgs: Message[] = [{ role: 'system', content: [{ type: 'text', text: 'be terse' }] }]
    const out = flattenMessages(msgs)
    expect(out).toEqual([{ role: 'system', content: 'be terse' }])
  })
})
