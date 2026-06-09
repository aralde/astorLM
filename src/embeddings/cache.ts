/**
 * In-memory memoization wrapper around any `Embedder`.
 *
 * Embedding the same text twice is wasteful (identical vector, billed
 * again). `withEmbeddingCache` dedupes by input string so repeated lookups
 * within a process are free. It is transport-agnostic — wrap an OpenAI
 * embedder, a local one, anything that satisfies `Embedder`.
 *
 * The cache stores vectors only; `usage` is reported as `undefined` on a
 * cache hit (no tokens were actually spent). Cancellation/`signal` only
 * affects the underlying call on a miss.
 */

import type { Embedder, EmbedManyResult, EmbedOptions, EmbedResult } from './types.js'

/** Minimal cache contract — a `Map` satisfies it, so does an LRU. */
export interface EmbeddingCache {
  get(key: string): number[] | undefined
  set(key: string, value: number[]): void
}

export interface WithEmbeddingCacheOptions {
  /** Backing store. Defaults to an unbounded `Map`. */
  cache?: EmbeddingCache
  /**
   * Key derivation from the input text. Defaults to identity. Override to
   * normalize (lowercase, trim) before caching.
   */
  key?: (text: string) => string
}

export function withEmbeddingCache(inner: Embedder, opts: WithEmbeddingCacheOptions = {}): Embedder {
  const cache: EmbeddingCache = opts.cache ?? new Map<string, number[]>()
  const keyOf = opts.key ?? ((t) => t)

  return {
    model: inner.model,
    get dimensions() {
      return inner.dimensions
    },

    async embed(text, options?: EmbedOptions): Promise<EmbedResult> {
      const k = keyOf(text)
      const hit = cache.get(k)
      if (hit) return { embedding: hit }
      const result = await inner.embed(text, options)
      cache.set(k, result.embedding)
      return result
    },

    async embedMany(texts, options?: EmbedOptions): Promise<EmbedManyResult> {
      const keys = texts.map(keyOf)
      const out: (number[] | undefined)[] = keys.map((k) => cache.get(k))

      // Collect the indices that missed so we embed only those, in one batch.
      const missIndices: number[] = []
      for (let i = 0; i < out.length; i++) {
        if (!out[i]) missIndices.push(i)
      }

      let usage: EmbedManyResult['usage']
      if (missIndices.length > 0) {
        const missTexts = missIndices.map((i) => texts[i] as string)
        const fresh = await inner.embedMany(missTexts, options)
        usage = fresh.usage
        for (let j = 0; j < missIndices.length; j++) {
          const idx = missIndices[j] as number
          const vec = fresh.embeddings[j] as number[]
          out[idx] = vec
          cache.set(keys[idx] as string, vec)
        }
      }

      return { embeddings: out as number[][], usage }
    },
  }
}
