import { describe, expect, it } from 'vitest'
import { buildChatCompletionParams } from '../src/provider/openai.js'
import type { ProviderStreamOptions } from '../src/types.js'

function baseOpts(overrides: Partial<ProviderStreamOptions> = {}): ProviderStreamOptions {
  return {
    systemPrompt: 'sys',
    messages: [],
    tools: [],
    abortSignal: new AbortController().signal,
    ...overrides,
  }
}

const cfg = (defaults: Record<string, unknown> = {}) => ({
  model: 'test-model',
  messages: [{ role: 'system' as const, content: 'sys' }],
  tools: [] as any[],
  defaults,
})

describe('buildChatCompletionParams (sampling + toolChoice)', () => {
  it('defaults temperature to 0 and omits unset knobs', () => {
    const p = buildChatCompletionParams(baseOpts(), cfg()) as any
    expect(p.temperature).toBe(0)
    expect(p.top_p).toBeUndefined()
    expect(p.frequency_penalty).toBeUndefined()
    expect(p.presence_penalty).toBeUndefined()
    expect(p.max_tokens).toBeUndefined()
    expect(p.stream).toBe(true)
    expect(p.stream_options).toEqual({ include_usage: true })
  })

  it('uses constructor defaults when no per-call sampling is given', () => {
    const p = buildChatCompletionParams(
      baseOpts(),
      cfg({ temperature: 0.7, frequencyPenalty: 0.2, maxTokens: 512 }),
    ) as any
    expect(p.temperature).toBe(0.7)
    expect(p.frequency_penalty).toBe(0.2)
    expect(p.max_tokens).toBe(512)
  })

  it('per-call sampling overrides constructor defaults', () => {
    const p = buildChatCompletionParams(
      baseOpts({ sampling: { temperature: 0.1, frequencyPenalty: 0.9, topP: 0.5, presencePenalty: 0.3 } }),
      cfg({ temperature: 0.7, frequencyPenalty: 0.2 }),
    ) as any
    expect(p.temperature).toBe(0.1)
    expect(p.frequency_penalty).toBe(0.9)
    expect(p.top_p).toBe(0.5)
    expect(p.presence_penalty).toBe(0.3)
  })

  it('per-call maxTokens overrides the constructor default', () => {
    const p = buildChatCompletionParams(baseOpts({ maxTokens: 128 }), cfg({ maxTokens: 512 })) as any
    expect(p.max_tokens).toBe(128)
  })

  it('does not send tool_choice or tools when no tools are present', () => {
    const p = buildChatCompletionParams(baseOpts({ toolChoice: 'none' }), cfg()) as any
    expect(p.tools).toBeUndefined()
    expect(p.tool_choice).toBeUndefined()
  })

  it('defaults tool_choice to auto and honors an explicit override when tools exist', () => {
    const tools = [{ type: 'function', function: { name: 'x', parameters: {} } }] as any[]
    const auto = buildChatCompletionParams(baseOpts(), { ...cfg(), tools }) as any
    expect(auto.tool_choice).toBe('auto')

    const none = buildChatCompletionParams(baseOpts({ toolChoice: 'none' }), { ...cfg(), tools }) as any
    expect(none.tool_choice).toBe('none')

    const required = buildChatCompletionParams(baseOpts({ toolChoice: 'required' }), { ...cfg(), tools }) as any
    expect(required.tool_choice).toBe('required')
  })
})
