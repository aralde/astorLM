/**
 * First-class embeddings feature.
 *
 * Runtime-agnostic primitives for turning text into vectors and searching
 * over them. Exported both from the main `astorlm` barrel (next to the
 * providers) and from the dedicated `astorlm/embeddings` subpath.
 */

export { createOpenAIEmbedder } from './openai.js'
export type { OpenAIEmbedderOptions } from './openai.js'

export { cosineSimilarity, dotProduct, euclideanDistance } from './similarity.js'

export { createSemanticIndex } from './semanticIndex.js'
export type {
  SemanticIndex,
  SemanticIndexOptions,
  SemanticHit,
  SemanticQueryOptions,
  IndexRecord,
} from './semanticIndex.js'

export { withEmbeddingCache } from './cache.js'
export type { EmbeddingCache, WithEmbeddingCacheOptions } from './cache.js'

export type {
  Embedder,
  EmbedOptions,
  EmbedResult,
  EmbedManyResult,
  EmbeddingUsage,
} from './types.js'
