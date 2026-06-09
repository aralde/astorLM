/**
 * Back-compat shim.
 *
 * The embeddings primitives that used to live here were promoted to the
 * first-class `src/embeddings/` module (exported from `astorlm` and
 * `astorlm/embeddings`). This file now re-exports thin adapters so existing
 * imports from `astorlm/experimental/error-registry` keep working.
 *
 * @deprecated Import from `astorlm` / `astorlm/embeddings` instead.
 */

import { createOpenAIEmbedder } from '../../embeddings/openai.js'
import { cosineSimilarity as rawCosine } from '../../embeddings/similarity.js'
import type { Embedder } from '../../embeddings/types.js'

/** @deprecated Use `Embedder` from `astorlm`. */
export interface EmbeddingClient {
  embed(text: string, signal?: AbortSignal): Promise<number[]>
}

/** @deprecated Use `OpenAIEmbedderOptions` from `astorlm`. */
export interface OpenAIEmbeddingClientOptions {
  baseURL: string
  model: string
  apiKey?: string
}

/**
 * @deprecated Use `createOpenAIEmbedder` from `astorlm`. This wrapper
 * preserves the old single-vector `embed(text) → number[]` signature.
 */
export function createOpenAIEmbeddingClient(opts: OpenAIEmbeddingClientOptions): EmbeddingClient {
  const embedder: Embedder = createOpenAIEmbedder(opts)
  return {
    async embed(text, signal) {
      const { embedding } = await embedder.embed(text, { signal })
      return embedding
    },
  }
}

/**
 * Cosine similarity clamped to `[0..1]` so it is comparable with the
 * Jaccard fallback used by the error registry. The first-class
 * `cosineSimilarity` (from `astorlm`) returns the standard `[-1..1]`.
 *
 * @deprecated Import `cosineSimilarity` from `astorlm` and clamp at the
 * call site if you need a non-negative score.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  return Math.max(0, rawCosine(a, b))
}
