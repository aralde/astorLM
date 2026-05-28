import { describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from '../src/provider/openai.js'
import { AnthropicProvider } from '../src/provider/anthropic.js'
import type { Message, ProviderEvent } from '../src/types.js'

describe('OpenAIProvider - thinking blocks', () => {
  it('streams reasoning_content as thinking_delta and saves it in the final message', async () => {
    const provider = new OpenAIProvider({ apiKey: 'fake-key', model: 'o1-mini' })

    const fakeStream = {
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [
            {
              delta: { reasoning_content: 'Pienso ' },
              finish_reason: null,
            },
          ],
        }
        yield {
          choices: [
            {
              delta: { reasoning: 'luego existo.' },
              finish_reason: null,
            },
          ],
        }
        yield {
          choices: [
            {
              delta: { content: ' La respuesta es 42.' },
              finish_reason: 'stop',
            },
          ],
        }
      },
    }

    vi.spyOn(provider['client'].chat.completions, 'create').mockResolvedValue(fakeStream as any)

    const events: ProviderEvent[] = []
    const stream = provider.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hola' }] }],
      tools: [],
      abortSignal: new AbortController().signal,
    })

    for await (const ev of stream) {
      events.push(ev)
    }

    // Verify thinking_delta events
    const thinkingDeltas = events.filter((e) => e.type === 'thinking_delta')
    expect(thinkingDeltas).toEqual([
      { type: 'thinking_delta', thinking: 'Pienso ' },
      { type: 'thinking_delta', thinking: 'luego existo.' },
    ])

    // Verify text_delta events
    const textDeltas = events.filter((e) => e.type === 'text_delta')
    expect(textDeltas).toEqual([
      { type: 'text_delta', text: ' La respuesta es 42.' },
    ])

    // Verify message_end event contains the thinking block followed by the text block
    const endEvent = events.find((e) => e.type === 'message_end')
    expect(endEvent).toBeDefined()
    expect(endEvent!.type).toBe('message_end')
    const assistantMsg = (endEvent as any).assistantMessage as Message
    expect(assistantMsg.content).toEqual([
      { type: 'thinking', thinking: 'Pienso luego existo.' },
      { type: 'text', text: ' La respuesta es 42.' },
    ])
  })

  it('flattens messages and maps thinking block to reasoning_content', async () => {
    const provider = new OpenAIProvider({ apiKey: 'fake-key', model: 'o1-mini' })

    const mockCreate = vi.spyOn(provider['client'].chat.completions, 'create').mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
      }
    } as any)

    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal logic' },
          { type: 'text', text: 'external response' },
        ],
      },
    ]

    const stream = provider.stream({
      systemPrompt: 'System',
      messages,
      tools: [],
      abortSignal: new AbortController().signal,
    })

    // Consume the stream to trigger the client call
    for await (const _ of stream) {
      // noop
    }

    expect(mockCreate).toHaveBeenCalledTimes(1)
    const calledPayload = mockCreate.mock.calls[0]![0];
    const assistantMessageParam = calledPayload.messages.find(m => m.role === 'assistant') as any
    expect(assistantMessageParam).toBeDefined()
    expect(assistantMessageParam.reasoning_content).toBe('internal logic')
    expect(assistantMessageParam.content).toBe('external response')
  })

  it('streams inline <think> tags in content as thinking_delta and strips them', async () => {
    const provider = new OpenAIProvider({ apiKey: 'fake-key', model: 'my-reasoning-model' })

    const fakeStream = {
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [
            {
              delta: { content: 'Intro text. <th' },
              finish_reason: null,
            },
          ],
        }
        yield {
          choices: [
            {
              delta: { content: 'ink>Internal thought process' },
              finish_reason: null,
            },
          ],
        }
        yield {
          choices: [
            {
              delta: { content: '</think>Final answer here.' },
              finish_reason: 'stop',
            },
          ],
        }
      },
    }

    vi.spyOn(provider['client'].chat.completions, 'create').mockResolvedValue(fakeStream as any)

    const events: ProviderEvent[] = []
    const stream = provider.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hola' }] }],
      tools: [],
      abortSignal: new AbortController().signal,
    })

    for await (const ev of stream) {
      events.push(ev)
    }

    // Verify thinking_delta events
    const thinkingDeltas = events.filter((e) => e.type === 'thinking_delta')
    expect(thinkingDeltas).toEqual([
      { type: 'thinking_delta', thinking: 'Internal thought process' },
    ])

    // Verify text_delta events
    const textDeltas = events.filter((e) => e.type === 'text_delta')
    expect(textDeltas).toEqual([
      { type: 'text_delta', text: 'Intro text. ' },
      { type: 'text_delta', text: 'Final answer here.' },
    ])

    // Verify message_end event contains the thinking block followed by the text block
    const endEvent = events.find((e) => e.type === 'message_end')
    expect(endEvent).toBeDefined()
    const assistantMsg = (endEvent as any).assistantMessage as Message
    expect(assistantMsg.content).toEqual([
      { type: 'thinking', thinking: 'Internal thought process' },
      { type: 'text', text: 'Intro text. Final answer here.' },
    ])
  })

  it('correctly flushes remaining buffer at the end of the stream', async () => {
    const provider = new OpenAIProvider({ apiKey: 'fake-key', model: 'my-reasoning-model' })

    const fakeStream = {
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [
            {
              delta: { content: 'Text with stray < char' },
              finish_reason: 'stop',
            },
          ],
        }
      },
    }

    vi.spyOn(provider['client'].chat.completions, 'create').mockResolvedValue(fakeStream as any)

    const events: ProviderEvent[] = []
    const stream = provider.stream({
      systemPrompt: 'System',
      messages: [],
      tools: [],
      abortSignal: new AbortController().signal,
    })

    for await (const ev of stream) {
      events.push(ev)
    }

    const textDeltas = events.filter((e) => e.type === 'text_delta')
    expect(textDeltas).toEqual([
      { type: 'text_delta', text: 'Text with stray < char' },
    ])
  })
})

describe('AnthropicProvider - thinking blocks mapping', () => {
  it('serializes thinking blocks with signature and maps redacted_thinking', () => {
    const provider = new AnthropicProvider({ apiKey: 'fake-key', model: 'claude-3-7-sonnet' })

    const mockCreate = vi.spyOn(provider['client'].messages, 'stream').mockReturnValue({
      async *[Symbol.asyncIterator]() {
        // yield nothing
      },
      finalMessage: async () => ({
        content: [
          { type: 'thinking', thinking: 'pensando en algo', signature: 'sig_123' },
          { type: 'redacted_thinking', data: 'redacted_sig' },
          { type: 'text', text: 'hola' }
        ],
        stop_reason: 'end_turn',
      }),
    } as any)

    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal logic', signature: 'sig_abc' },
          { type: 'redacted_thinking', signature: 'redacted_sig_abc' },
          { type: 'text', text: 'response' }
        ],
      },
    ]

    const stream = provider.stream({
      systemPrompt: 'System',
      messages,
      tools: [],
      abortSignal: new AbortController().signal,
    })

    const run = async () => {
      const events = []
      for await (const ev of stream) {
        events.push(ev)
      }
      return events
    }

    return run().then((events) => {
      // Verify outgoing message parameters format
      expect(mockCreate).toHaveBeenCalledTimes(1)
      const calledParams = mockCreate.mock.calls[0]![0];
      const assistantMsg = calledParams.messages.find((m: any) => m.role === 'assistant')
      expect(assistantMsg).toBeDefined()
      expect(assistantMsg.content).toEqual([
        { type: 'thinking', thinking: 'internal logic', signature: 'sig_abc' },
        { type: 'redacted_thinking', data: 'redacted_sig_abc' },
        { type: 'text', text: 'response' }
      ])

      // Verify incoming message parsing
      const endEvent = events.find((e) => e.type === 'message_end')
      expect(endEvent).toBeDefined()
      const assistantResponse = (endEvent as any).assistantMessage as Message
      expect(assistantResponse.content).toEqual([
        { type: 'thinking', thinking: 'pensando en algo', signature: 'sig_123' },
        { type: 'redacted_thinking', signature: 'redacted_sig' },
        { type: 'text', text: 'hola' }
      ])
    })
  })
})
