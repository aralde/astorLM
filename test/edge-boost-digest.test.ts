import { describe, expect, it, vi } from 'vitest'
import { buildContextDietHook } from '../src/experimental/edge-boost/contextDiet.js'
import { MockProvider } from './mock-provider.js'
import type { Message, Provider, ProviderEvent } from '../src/types.js'

const big = (n: number) => 'x'.repeat(n)

function withRounds(n: number, resultLen: number): Message[] {
  const msgs: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'do it' }] }]
  for (let r = 1; r <= n; r++) {
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `c${r}`, name: 'search', input: {} }] })
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${r}`, content: big(resultLen) }] })
  }
  return msgs
}

const ctx = (messages: Message[]) => ({ messages, systemPrompt: 'sys', tools: [], cwd: '/' })

const firstToolResult = (m: Message) => (m.content.find((b) => b.type === 'tool_result') as any).content

describe('context diet — LLM digest', () => {
  it('replaces evicted tool_results with an LLM summary (marked) and keeps recent intact', async () => {
    const provider = new MockProvider([
      { text: 'S1', stopReason: 'end_turn' },
      { text: 'S2', stopReason: 'end_turn' },
    ])
    const hook = buildContextDietHook({
      toolResultMaxChars: 20,
      keepRecentToolRounds: 2,
      digest: { provider, maxChars: 200 },
    })
    const res = await hook(ctx(withRounds(4, 500)))
    const results = res.messages.filter((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'))
    expect(firstToolResult(results[0]!)).toBe('[edge-boost: digest] S1')
    expect(firstToolResult(results[1]!)).toBe('[edge-boost: digest] S2')
    expect(firstToolResult(results[2]!)).toBe(big(500)) // protected
    expect(firstToolResult(results[3]!)).toBe(big(500)) // protected
    expect(provider.calls).toHaveLength(2)
  })

  it('summarizes each block at most once (cached across calls)', async () => {
    const provider = new MockProvider([
      { text: 'SUM', stopReason: 'end_turn' },
      { text: 'SUM', stopReason: 'end_turn' },
    ])
    const hook = buildContextDietHook({
      toolResultMaxChars: 20,
      keepRecentToolRounds: 3,
      digest: { provider, maxChars: 200 },
    })
    const messages = withRounds(4, 500) // keep 3 → only round 1 evicted
    await hook(ctx(messages))
    await hook(ctx(messages))
    expect(provider.calls).toHaveLength(1) // cache hit on the second call
  })

  it('falls back to structural truncation on digest failure (warn once)', async () => {
    const throwing: Provider = {
      name: 'boom',
      model: 'boom-1',
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<ProviderEvent> {
        throw new Error('digest endpoint down')
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const hook = buildContextDietHook({
        toolResultMaxChars: 20,
        keepRecentToolRounds: 3,
        digest: { provider: throwing, maxChars: 200 },
      })
      const res = await hook(ctx(withRounds(4, 500)))
      const evicted = res.messages.filter((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'))[0]!
      expect(firstToolResult(evicted)).toContain('[edge-boost: truncated')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
