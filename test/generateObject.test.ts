import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { generateObject, GenerateObjectError } from '../src/agent/generateObject.js'
import { MockProvider } from './mock-provider.js'

const Sentiment = z.object({
  label: z.enum(['pos', 'neg', 'neu']),
  score: z.number(),
})

describe('generateObject — modo tool (tool terminal)', () => {
  it('captura el input de la tool terminal como objeto tipado', async () => {
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
      prompt: "Clasificá: 'me encantó'",
      mode: 'tool',
    })

    expect(mode).toBe('tool')
    expect(object).toEqual({ label: 'pos', score: 0.9 })
    expect(sessionId).toBeTruthy()
  })

  it('corta el loop apenas se llama la tool terminal (no abre otro turno)', async () => {
    const provider = new MockProvider([
      {
        toolCalls: [
          { id: 't1', name: 'provide_final_answer', input: { label: 'neu', score: 0.5 } },
        ],
      },
      // Segundo turno scripteado: si el loop NO cortara, MockProvider lo consumiría.
      { text: 'no debería llegar acá', stopReason: 'end_turn' },
    ])

    const { object } = await generateObject({
      provider,
      schema: Sentiment,
      prompt: 'algo',
      mode: 'tool',
    })

    expect(object.label).toBe('neu')
    // Sólo se consumió 1 turno.
    expect(provider.calls).toHaveLength(1)
  })

  it('repara automáticamente cuando el modelo manda un objeto inválido', async () => {
    const provider = new MockProvider([
      // Primer intento: score como string → Zod falla → tool_result de error.
      {
        toolCalls: [
          { id: 't1', name: 'provide_final_answer', input: { label: 'pos', score: 'alto' } },
        ],
      },
      // Segundo intento: corregido.
      {
        toolCalls: [
          { id: 't2', name: 'provide_final_answer', input: { label: 'pos', score: 0.8 } },
        ],
      },
    ])

    const { object } = await generateObject({
      provider,
      schema: Sentiment,
      prompt: 'algo',
      mode: 'tool',
    })

    expect(object).toEqual({ label: 'pos', score: 0.8 })
    expect(provider.calls).toHaveLength(2)
  })

  it('tira GenerateObjectError si el modelo nunca llama la tool terminal', async () => {
    const provider = new MockProvider([{ text: 'respuesta en prosa', stopReason: 'end_turn' }])

    await expect(
      generateObject({ provider, schema: Sentiment, prompt: 'algo', mode: 'tool' }),
    ).rejects.toBeInstanceOf(GenerateObjectError)
  })
})

describe('generateObject — modo native (response_format)', () => {
  it('parsea y valida el JSON devuelto por el provider', async () => {
    const provider = new MockProvider([
      { text: JSON.stringify({ label: 'neg', score: 0.1 }), stopReason: 'end_turn' },
    ])

    const { object, mode } = await generateObject({
      provider,
      schema: Sentiment,
      prompt: 'algo',
      mode: 'native',
    })

    expect(mode).toBe('native')
    expect(object).toEqual({ label: 'neg', score: 0.1 })
    // Verifica que se pasó outputFormat al provider.
    expect(provider.calls[0]?.outputFormat).toBeTruthy()
    expect(provider.calls[0]?.outputFormat?.schema).toBeTruthy()
  })

  it('tolera fences markdown alrededor del JSON', async () => {
    const provider = new MockProvider([
      { text: '```json\n{"label":"pos","score":0.7}\n```', stopReason: 'end_turn' },
    ])

    const { object } = await generateObject({
      provider,
      schema: Sentiment,
      prompt: 'algo',
      mode: 'native',
    })

    expect(object).toEqual({ label: 'pos', score: 0.7 })
  })

  it('reintenta (repair) cuando la primera salida no valida', async () => {
    const provider = new MockProvider([
      { text: '{"label":"???","score":0.5}', stopReason: 'end_turn' },
      { text: '{"label":"neu","score":0.5}', stopReason: 'end_turn' },
    ])

    const { object } = await generateObject({
      provider,
      schema: Sentiment,
      prompt: 'algo',
      mode: 'native',
      maxRepairAttempts: 1,
    })

    expect(object.label).toBe('neu')
    expect(provider.calls).toHaveLength(2)
  })
})

describe('generateObject — selección de modo (auto)', () => {
  it("usa 'tool' cuando hay tools de usuario", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [
          { id: 't1', name: 'provide_final_answer', input: { label: 'pos', score: 1 } },
        ],
      },
    ])
    // provider.name === 'mock' → auto cae en 'tool' igual; este test fija el contrato.
    const { mode } = await generateObject({ provider, schema: Sentiment, prompt: 'x' })
    expect(mode).toBe('tool')
  })
})
