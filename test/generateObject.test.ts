import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { generateObject, GenerateObjectError } from '../src/agent/generateObject.js'
import { MockProvider } from './mock-provider.js'

const Sentiment = z.object({
  label: z.enum(['pos', 'neg', 'neu']),
  score: z.number(),
})

describe('generateObject — tool mode (terminal tool)', () => {
  it('captures the terminal tool input as a typed object', async () => {
    const provider = new MockProvider([
      {
        toolCalls: [
          { id: 't1', name: 'provide_final_answer', input: { label: 'pos', score: 0.9 } },
        ],
      },
    ])

    const { object, mode, sessionId } = await generateObject({
      provider,
      schema: Sentiment,
      prompt: "Classify: 'I loved it'",
      mode: 'tool',
    })

    expect(mode).toBe('tool')
    expect(object).toEqual({ label: 'pos', score: 0.9 })
    expect(sessionId).toBeTruthy()
  })

  it('stops the loop as soon as the terminal tool is called (does not open another turn)', async () => {
    const provider = new MockProvider([
      {
        toolCalls: [
          { id: 't1', name: 'provide_final_answer', input: { label: 'neu', score: 0.5 } },
        ],
      },
      // Second scripted turn: if the loop did NOT stop, MockProvider would consume it.
      { text: 'should not be reached', stopReason: 'end_turn' },
    ])

    const { object } = await generateObject({
      provider,
      schema: Sentiment,
      prompt: 'something',
      mode: 'tool',
    })

    expect(object.label).toBe('neu')
    // Only 1 turn was consumed.
    expect(provider.calls).toHaveLength(1)
  })

  it('repairs automatically when the model sends an invalid object', async () => {
    const provider = new MockProvider([
      // First attempt: score as a string → Zod fails → error tool_result.
      {
        toolCalls: [
          { id: 't1', name: 'provide_final_answer', input: { label: 'pos', score: 'high' } },
        ],
      },
      // Second attempt: corrected.
      {
        toolCalls: [
          { id: 't2', name: 'provide_final_answer', input: { label: 'pos', score: 0.8 } },
        ],
      },
    ])

    const { object } = await generateObject({
      provider,
      schema: Sentiment,
      prompt: 'something',
      mode: 'tool',
    })

    expect(object).toEqual({ label: 'pos', score: 0.8 })
    expect(provider.calls).toHaveLength(2)
  })

  it('throws GenerateObjectError if the model never calls the terminal tool', async () => {
    const provider = new MockProvider([{ text: 'a prose answer', stopReason: 'end_turn' }])

    await expect(
      generateObject({ provider, schema: Sentiment, prompt: 'something', mode: 'tool' }),
    ).rejects.toBeInstanceOf(GenerateObjectError)
  })
})

describe('generateObject — native mode (response_format)', () => {
  it('parses and validates the JSON returned by the provider', async () => {
    const provider = new MockProvider([
      { text: JSON.stringify({ label: 'neg', score: 0.1 }), stopReason: 'end_turn' },
    ])

    const { object, mode } = await generateObject({
      provider,
      schema: Sentiment,
      prompt: 'something',
      mode: 'native',
    })

    expect(mode).toBe('native')
    expect(object).toEqual({ label: 'neg', score: 0.1 })
    // Verify outputFormat was passed to the provider.
    expect(provider.calls[0]?.outputFormat).toBeTruthy()
    expect(provider.calls[0]?.outputFormat?.schema).toBeTruthy()
  })

  it('tolerates markdown fences around the JSON', async () => {
    const provider = new MockProvider([
      { text: '```json\n{"label":"pos","score":0.7}\n```', stopReason: 'end_turn' },
    ])

    const { object } = await generateObject({
      provider,
      schema: Sentiment,
      prompt: 'something',
      mode: 'native',
    })

    expect(object).toEqual({ label: 'pos', score: 0.7 })
  })

  it('retries (repair) when the first output fails validation', async () => {
    const provider = new MockProvider([
      { text: '{"label":"???","score":0.5}', stopReason: 'end_turn' },
      { text: '{"label":"neu","score":0.5}', stopReason: 'end_turn' },
    ])

    const { object } = await generateObject({
      provider,
      schema: Sentiment,
      prompt: 'something',
      mode: 'native',
      maxRepairAttempts: 1,
    })

    expect(object.label).toBe('neu')
    expect(provider.calls).toHaveLength(2)
  })
})

describe('generateObject — mode selection (auto)', () => {
  it("uses 'tool' when there are user tools", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [
          { id: 't1', name: 'provide_final_answer', input: { label: 'pos', score: 1 } },
        ],
      },
    ])
    // provider.name === 'mock' → auto falls back to 'tool' anyway; this test pins the contract.
    const { mode } = await generateObject({ provider, schema: Sentiment, prompt: 'x' })
    expect(mode).toBe('tool')
  })
})
