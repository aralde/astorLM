import { describe, expect, it, vi } from 'vitest'
import {
  createOpenAIEmbedder,
  cosineSimilarity,
  dotProduct,
  euclideanDistance,
  createSemanticIndex,
  withEmbeddingCache,
} from '../src/embeddings/index.js'
import type { Embedder } from '../src/embeddings/types.js'

/** Builds a `fetch` stub returning an OpenAI `/embeddings` payload. */
function fakeFetch(vectors: number[][], usage?: { prompt_tokens?: number; total_tokens?: number }) {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        data: vectors.map((embedding, index) => ({ embedding, index })),
        usage,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  )
}

/** A deterministic in-test embedder: maps a word to a fixed 3-d vector. */
function stubEmbedder(table: Record<string, number[]>): Embedder {
  const lookup = (t: string) => table[t] ?? [0, 0, 0]
  return {
    model: 'stub',
    async embed(text) {
      return { embedding: lookup(text) }
    },
    async embedMany(texts) {
      return { embeddings: texts.map(lookup) }
    },
  }
}

describe('similarity helpers', () => {
  it('cosineSimilarity returns the standard [-1..1] range (not clamped)', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
  })

  it('returns 0 for mismatched lengths or empty vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
    expect(dotProduct([1, 2], [1])).toBe(0)
    expect(euclideanDistance([1], [])).toBe(0)
  })

  it('dotProduct and euclideanDistance compute the expected values', () => {
    expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(32)
    expect(euclideanDistance([0, 0], [3, 4])).toBe(5)
  })
})

describe('createOpenAIEmbedder', () => {
  it('embeds a single text and reports usage', async () => {
    const fetchImpl = fakeFetch([[0.1, 0.2, 0.3]], { prompt_tokens: 5, total_tokens: 5 })
    const embedder = createOpenAIEmbedder({
      baseURL: 'http://localhost/v1',
      model: 'text-embedding-3-small',
      fetch: fetchImpl as unknown as typeof fetch,
    })

    const res = await embedder.embed('hello')
    expect(res.embedding).toEqual([0.1, 0.2, 0.3])
    expect(res.usage).toEqual({ inputTokens: 5, totalTokens: 5 })
    expect(embedder.dimensions).toBe(3)
  })

  it('embedMany sends one request and preserves input order despite shuffled data', async () => {
    // Server returns out-of-order indices; embedder must sort them back.
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { embedding: [2], index: 1 },
            { embedding: [1], index: 0 },
          ],
        }),
        { status: 200 },
      ),
    )
    const embedder = createOpenAIEmbedder({
      baseURL: 'http://localhost/v1',
      model: 'm',
      fetch: fetchImpl as unknown as typeof fetch,
    })

    const { embeddings } = await embedder.embedMany(['a', 'b'])
    expect(embeddings).toEqual([[1], [2]])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('embedMany short-circuits on empty input', async () => {
    const fetchImpl = fakeFetch([])
    const embedder = createOpenAIEmbedder({
      baseURL: 'http://localhost/v1',
      model: 'm',
      fetch: fetchImpl as unknown as typeof fetch,
    })
    expect(await embedder.embedMany([])).toEqual({ embeddings: [] })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }))
    const embedder = createOpenAIEmbedder({
      baseURL: 'http://localhost/v1',
      model: 'm',
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await expect(embedder.embed('x')).rejects.toThrow(/Embeddings API 500/)
  })

  it('forwards the requested dimensions in the request body', async () => {
    const fetchImpl = fakeFetch([[0, 0]])
    const embedder = createOpenAIEmbedder({
      baseURL: 'http://localhost/v1',
      model: 'text-embedding-3-large',
      dimensions: 256,
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await embedder.embed('x')
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.dimensions).toBe(256)
  })
})

describe('withEmbeddingCache', () => {
  it('caches single embeds and skips the underlying call on a hit', async () => {
    const inner = stubEmbedder({ cat: [1, 0, 0] })
    const spy = vi.spyOn(inner, 'embed')
    const cached = withEmbeddingCache(inner)

    const a = await cached.embed('cat')
    const b = await cached.embed('cat')
    expect(a.embedding).toEqual([1, 0, 0])
    expect(b.embedding).toEqual([1, 0, 0])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('embedMany only requests the missing inputs', async () => {
    const inner = stubEmbedder({ a: [1], b: [2], c: [3] })
    const manySpy = vi.spyOn(inner, 'embedMany')
    const cached = withEmbeddingCache(inner)

    await cached.embedMany(['a', 'b'])
    const second = await cached.embedMany(['a', 'b', 'c'])

    expect(second.embeddings).toEqual([[1], [2], [3]])
    // Second call only embeds 'c'.
    expect(manySpy).toHaveBeenLastCalledWith(['c'], undefined)
  })
})

describe('createSemanticIndex', () => {
  it('ranks by similarity and honors topK', async () => {
    const embedder = stubEmbedder({
      query: [1, 0, 0],
      apple: [0.9, 0.1, 0],
      banana: [0.2, 0.9, 0],
      orange: [0.8, 0.2, 0],
    })
    const index = createSemanticIndex<{ kind: string }>({ embedder })
    await index.addMany([
      { id: 'a', text: 'apple', metadata: { kind: 'fruit' } },
      { id: 'b', text: 'banana', metadata: { kind: 'fruit' } },
      { id: 'o', text: 'orange', metadata: { kind: 'fruit' } },
    ])

    const hits = await index.query('query', { topK: 2 })
    expect(hits.map((h) => h.id)).toEqual(['a', 'o'])
    expect(hits[0]!.metadata).toEqual({ kind: 'fruit' })
    expect(index.size).toBe(3)
  })

  it('applies the threshold floor', async () => {
    const embedder = stubEmbedder({ q: [1, 0], near: [1, 0], far: [0, 1] })
    const index = createSemanticIndex({ embedder })
    await index.add('near', 'near')
    await index.add('far', 'far')

    const hits = await index.query('q', { threshold: 0.5 })
    expect(hits.map((h) => h.id)).toEqual(['near'])
  })

  it('supports remove, get, clear and precomputed vectors', async () => {
    const embedder = stubEmbedder({})
    const index = createSemanticIndex({ embedder })
    index.addVector({ id: 'v', vector: [1, 0] })
    expect(index.get('v')?.vector).toEqual([1, 0])
    expect(index.queryByVector([1, 0])[0]!.id).toBe('v')
    expect(index.remove('v')).toBe(true)
    expect(index.remove('v')).toBe(false)
    index.addVector({ id: 'x', vector: [0, 1] })
    index.clear()
    expect(index.size).toBe(0)
  })

  it('upserts on a repeated id', async () => {
    const embedder = stubEmbedder({ first: [1, 0], second: [0, 1] })
    const index = createSemanticIndex({ embedder })
    await index.add('k', 'first')
    await index.add('k', 'second')
    expect(index.size).toBe(1)
    expect(index.get('k')?.vector).toEqual([0, 1])
  })
})
