import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent/session.js'
import { edgeBoost } from '../src/experimental/edge-boost/index.js'
import type { Provider, ProviderEvent, ProviderStreamOptions } from '../src/types.js'

// Inner provider that degenerates on its first stream and answers on the second.
class DegenThenAnswerProvider implements Provider {
  readonly name = 'degen'
  readonly model = 'degen-1'
  readonly contextLimit = 8000
  calls = 0
  async *stream(_opts: ProviderStreamOptions): AsyncIterable<ProviderEvent> {
    this.calls++
    if (this.calls === 1) {
      // 20 identical garbage thinking deltas → guard aborts + retries
      for (let k = 0; k < 20; k++) yield { type: 'thinking_delta', thinking: ' \\' }
      return
    }
    yield { type: 'text_delta', text: 'here is the answer' }
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      assistantMessage: { role: 'assistant', content: [{ type: 'text', text: 'here is the answer' }] },
    }
  }
}

describe('edge-boost end-to-end through the loop', () => {
  it('recovers from a degenerate attempt and returns the final message', async () => {
    const inner = new DegenThenAnswerProvider()
    const opts = edgeBoost(
      { provider: inner, tools: [] },
      {
        guard: { maxRepeatedDeltas: 15, stallTimeoutMs: 0, maxThinkingChars: 0, maxAttempts: 2 },
        contextDiet: false,
        synthesis: false,
        sampling: false,
        optimizer: false,
      },
    )
    const agent = await createAgent(opts)
    const final = await agent.run('recommend something')

    expect(inner.calls).toBe(2) // degenerate attempt + healthy retry
    expect(final.content.some((b) => b.type === 'text' && b.text.includes('answer'))).toBe(true)
  })
})
