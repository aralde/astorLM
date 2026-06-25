import { describe, expect, it } from 'vitest'
import { estimateTokens, optimizeContext } from '../src/agent/optimizer.js'
import { createAgent } from '../src/agent/session.js'
import { MockProvider } from './mock-provider.js'
import { SessionManager } from '../src/agent/sessionManager.js'
import type { Message, ContextOptimizerOptions } from '../src/types.js'

describe('Context Optimizer & Token Estimator', () => {
  describe('estimateTokens', () => {
    it('estimates correctly based on characters (chars / 4)', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello world!' }], // 12 chars
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi!' }], // 3 chars
        },
      ]
      // systemPrompt: undefined
      // charCount = 'user'.length (4) + 12 + 'assistant'.length (9) + 3 = 28 chars
      // 28 / 4 = 7 tokens
      expect(estimateTokens(messages)).toBe(7)

      // With a 13-char systemPrompt: +13 chars = 41 chars total
      // 41 / 4 = 10.25 -> 11 tokens
      expect(estimateTokens(messages, 'System prompt')).toBe(11)
    })
  })

  describe('optimizeContext', () => {
    const defaultOpts: Required<ContextOptimizerOptions> = {
      maxTokens: 100,
      compressThreshold: 0.8, // 80 tokens
      keepRecentTurns: 1,
      tokenCounter: (msgs, sys) => estimateTokens(msgs, sys),
    }

    it('does not optimize if below the threshold', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Short prompt' }] },
      ]
      const { messages: optimized, optimized: wasOptimized } = optimizeContext(
        messages,
        'Sys',
        defaultOpts
      )
      expect(wasOptimized).toBe(false)
      expect(optimized).toEqual(messages)
    })

    it('does not optimize if all messages are protected by keepRecentTurns', () => {
      // 200 chars ≈ 50 tokens
      // threshold is 80 tokens, but if we set maxTokens very low: maxTokens: 40 -> threshold = 32 tokens
      // 200 chars exceeds the threshold (50 > 32)
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'a'.repeat(200) }] },
      ]
      const { messages: optimized, optimized: wasOptimized } = optimizeContext(
        messages,
        'Sys',
        {
          ...defaultOpts,
          maxTokens: 40,
        }
      )
      // Since there is only one message, it is part of the protected recent turn.
      expect(wasOptimized).toBe(false)
      expect(optimized).toEqual(messages)
    })

    it('compacts old tool_result blocks when it exceeds the threshold', () => {
      // We generate a long history to have messages outside keepRecentTurns
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Initial request' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me run a tool' },
            { type: 'tool_use', id: 'tu_1', name: 'grep', input: { query: 'foo' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: 'very long tool result output '.repeat(50), // ~1450 chars ≈ 362 tokens
            },
          ],
        },
        // Recent turn (protected by keepRecentTurns: 1)
        { role: 'user', content: [{ type: 'text', text: 'Recent follow-up prompt' }] },
      ]

      // With maxTokens: 400 and threshold: 320 (80%), the 362 tokens of tool_result exceed the threshold once
      // the rest of the text is added, but after compaction it stays well below, avoiding message removal.
      const { messages: optimized, optimized: wasOptimized } = optimizeContext(
        messages,
        'Sys',
        {
          ...defaultOpts,
          maxTokens: 400,
        }
      )

      expect(wasOptimized).toBe(true)
      // Message 2 (tool_result) must be compacted
      const toolResultMsg = optimized[2]!
      expect(toolResultMsg.role).toBe('user')
      const block = toolResultMsg.content[0]!
      expect(block.type).toBe('tool_result')
      expect(block.content).toContain("[Tool 'grep' execution result truncated")
      expect(block.content).toContain('Original output length: 1450 characters')
      // The last message (recent turn) must not be altered
      expect(optimized[3]).toEqual(messages[3])
    })

    it('removes the oldest messages (except the initial one) if compacting tool_results is not enough', () => {
      // We configure the content to be huge both in the texts that can't be compacted
      // (since they are not tool_results) and in general.
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Initial request' }] }, // Msg 0 (kept)
        { role: 'assistant', content: [{ type: 'text', text: 'Intermediate text '.repeat(100) }] }, // Msg 1 (removed)
        { role: 'user', content: [{ type: 'text', text: 'More intermediate text '.repeat(100) }] }, // Msg 2 (removed)
        // Recent turn (protected by keepRecentTurns: 1)
        { role: 'user', content: [{ type: 'text', text: 'Recent follow-up' }] }, // Msg 3 (kept)
      ]

      const { messages: optimized, optimized: wasOptimized } = optimizeContext(
        messages,
        'Sys',
        {
          ...defaultOpts,
          maxTokens: 50, // Very low threshold
        }
      )

      expect(wasOptimized).toBe(true)
      // The initial (Msg 0) and the recent (Msg 3) must remain
      expect(optimized).toHaveLength(2)
      expect(optimized[0]?.content[0]).toEqual({ type: 'text', text: 'Initial request' })
      expect(optimized[1]?.content[0]).toEqual({ type: 'text', text: 'Recent follow-up' })
    })
  })

  describe('Integration with Agent', () => {
    it('automatically enables the optimizer if the provider defines contextLimit', async () => {
      const provider = new MockProvider([
        { text: 'Final response.', stopReason: 'end_turn' },
      ])
      // We simulate the provider exposing a contextLimit of 500 tokens (threshold = 400)
      Object.defineProperty(provider, 'contextLimit', {
        value: 500,
        writable: false,
      })

      // Manually crafted old messages to simulate prior history with more than 3 turns (keepRecentTurns = 3 by default)
      const msgs: Message[] = [
        // Turn 1 (its tool_result will be compacted because it falls outside the last 3 turns when sending the prompt)
        {
          role: 'user',
          content: [{ type: 'text', text: 'Turn 1 initial setup' }],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'grep', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: 'huge grep output content '.repeat(100), // ~2500 chars ≈ 625 tokens
            },
          ],
        },
        // Turn 2 (protected)
        {
          role: 'user',
          content: [{ type: 'text', text: 'Turn 2 user prompt' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Turn 2 response' }],
        },
        // Turn 3 (protected)
        {
          role: 'user',
          content: [{ type: 'text', text: 'Turn 3 user prompt' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Turn 3 response' }],
        },
      ]

      const sessionManager = SessionManager.inMemory()
      const sessionId = 'test-session-id'
      await sessionManager.save({
        id: sessionId,
        messages: msgs,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const session = await createAgent({
        provider,
        sessionId,
        sessionManager,
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      })

      // Run a new prompt (it becomes Turn 4, protecting Turns 4, 3, 2).
      // Turn 1 falls outside the protection window and gets compacted.
      await session.run('What is next?')

      // Verify that the history stored in the session was compacted
      const finalMsgs = session.getMessages()
      // The message with grep's tool_result (index 2 of msgs) must have been compacted.
      const compactMsg = finalMsgs[2]!
      expect(compactMsg.content[0]?.type).toBe('tool_result')
      expect(compactMsg.content[0]?.content).toContain("[Tool 'grep' execution result truncated")
    })
  })
})
