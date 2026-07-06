import { describe, expect, it } from 'vitest'
import { buildContextDietHook } from '../src/experimental/edge-boost/contextDiet.js'
import { buildSynthesisHook } from '../src/experimental/edge-boost/synthesis.js'
import type { Message } from '../src/types.js'

const ctx = (messages: Message[], systemPrompt = 'sys') => ({
  messages,
  systemPrompt,
  tools: [{ name: 'search', description: 'searches', inputSchema: {} }],
  cwd: '/',
})

function big(n: number): string {
  return 'x'.repeat(n)
}

/** Builds N tool rounds after a user prompt. */
function withRounds(n: number, resultLen: number): Message[] {
  const msgs: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'do the thing' }] }]
  for (let r = 1; r <= n; r++) {
    msgs.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `call_${r}`, name: 'search', input: { q: r } }],
    })
    msgs.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `call_${r}`, content: big(resultLen) }],
    })
  }
  return msgs
}

describe('context diet hook', () => {
  it('truncates old tool_results and keeps recent ones intact', async () => {
    const messages = withRounds(4, 500)
    const snapshot = structuredClone(messages)
    const hook = buildContextDietHook({ toolResultMaxChars: 20, keepRecentToolRounds: 2 })
    const res = await hook(ctx(messages))

    const results = res.messages.filter((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'))
    // rounds 1 & 2 truncated
    expect((results[0]!.content[0] as any).content).toContain('[edge-boost: truncated')
    expect((results[1]!.content[0] as any).content).toContain('[edge-boost: truncated')
    // rounds 3 & 4 intact
    expect((results[2]!.content[0] as any).content).toBe(big(500))
    expect((results[3]!.content[0] as any).content).toBe(big(500))
    // original history unmutated
    expect(messages).toEqual(snapshot)
  })

  it('is idempotent on a second pass', async () => {
    const hook = buildContextDietHook({ toolResultMaxChars: 20, keepRecentToolRounds: 2 })
    const first = await hook(ctx(withRounds(4, 500)))
    const second = await hook(ctx(first.messages))
    expect(second.messages).toEqual(first.messages)
  })

  it('leaves blocks already summarized by the core optimizer untouched', async () => {
    const optimized = "[Tool 'search' execution result truncated to save context. Original output length: 999 characters. Preview: \"...\"]"
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'search', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: optimized + big(400) }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c2', name: 'search', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c2', content: big(400) }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c3', name: 'search', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c3', content: big(400) }] },
    ]
    const hook = buildContextDietHook({ toolResultMaxChars: 20, keepRecentToolRounds: 2 })
    const res = await hook(ctx(messages))
    // first tool_result (optimizer-marked) is old but must stay as-is
    expect((res.messages[2]!.content[0] as any).content).toBe(optimized + big(400))
  })

  it('replaces the system prompt for the call only when compactSystemPrompt is set', async () => {
    const hook = buildContextDietHook({
      toolResultMaxChars: 0,
      keepRecentToolRounds: 2,
      compactSystemPrompt: 'be terse',
    })
    const res = await hook(ctx([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], 'long original prompt'))
    expect(res.systemPrompt).toBe('be terse')
  })
})

describe('synthesis hook', () => {
  const base = { forceAfterToolRounds: 3, instruction: 'ANSWER NOW', mechanism: 'tool-choice-none' as const }

  it('does nothing below the round threshold', async () => {
    const hook = buildSynthesisHook(base)
    const res = await hook(ctx(withRounds(2, 10)))
    expect(res.systemPrompt).toBe('sys')
    expect(res.toolChoice).toBeUndefined()
  })

  it('appends the instruction and forces toolChoice:none at the threshold', async () => {
    const hook = buildSynthesisHook(base)
    const res = await hook(ctx(withRounds(3, 10)))
    expect(res.systemPrompt).toContain('ANSWER NOW')
    expect(res.toolChoice).toBe('none')
  })

  it('strips tools when mechanism is strip-tools', async () => {
    const hook = buildSynthesisHook({ ...base, mechanism: 'strip-tools' })
    const res = await hook(ctx(withRounds(3, 10)))
    expect(res.tools).toEqual([])
    expect(res.toolChoice).toBeUndefined()
  })

  it('counts only rounds from the current user request', async () => {
    // previous request with 3 rounds, then a NEW prompt with only 1 round
    const previous = withRounds(3, 10)
    const messages: Message[] = [
      ...previous,
      { role: 'assistant', content: [{ type: 'text', text: 'answered before' }] },
      { role: 'user', content: [{ type: 'text', text: 'a fresh question' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'new1', name: 'search', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new1', content: 'r' }] },
    ]
    const hook = buildSynthesisHook(base)
    const res = await hook(ctx(messages))
    // only 1 round in the current request → below threshold → no forcing
    expect(res.systemPrompt).toBe('sys')
    expect(res.toolChoice).toBeUndefined()
  })
})
