/**
 * In-memory semantic index — a minimal vector store.
 *
 * This is the reusable primitive behind any "find the most similar X"
 * feature: semantic search, RAG retrieval, dedupe, the federated error
 * registry's matching loop, etc. It holds `{ id, vector, text?, metadata? }`
 * records and ranks them against a query by similarity.
 *
 * Scope is deliberately small: a brute-force scan over an in-memory array.
 * No ANN index, no persistence — for thousands of vectors this is fine and
 * exact. Swap in a real vector DB at the `add`/`query` boundary when you
 * outgrow it; the surface mirrors the common `upsert`/`query` shape so the
 * migration is mechanical.
 */

import type { Embedder } from './types.js'
import { cosineSimilarity } from './similarity.js'

/** A stored record. The `vector` is kept; `text`/`metadata` are optional payload. */
export interface IndexRecord<M = unknown> {
  id: string
  vector: number[]
  text?: string
  metadata?: M
}

/** A ranked search result. */
export interface SemanticHit<M = unknown> {
  id: string
  /** Similarity score in the metric's range (cosine: `[-1..1]`). */
  score: number
  text?: string
  metadata?: M
}

export interface SemanticQueryOptions {
  /** Max results to return, ranked by score desc. Default 5. */
  topK?: number
  /** Minimum score to include a hit. Default: no floor (`-Infinity`). */
  threshold?: number
  /** Cooperative cancellation for the query's embedding call. */
  signal?: AbortSignal
}

export interface SemanticIndexOptions {
  /** Embedder used to vectorize text passed to `add(...)` / `query(...)`. */
  embedder: Embedder
  /**
   * Similarity metric. Higher = more similar. Defaults to cosine.
   * Override for dot product or a custom metric (negate a distance to
   * keep "higher is better").
   */
  similarity?: (a: number[], b: number[]) => number
}

export interface SemanticIndex<M = unknown> {
  /** Embed `text` and store it under `id` (upsert: replaces an existing id). */
  add(id: string, text: string, metadata?: M, signal?: AbortSignal): Promise<void>
  /** Batch variant of `add`, using a single `embedMany` round-trip. */
  addMany(items: Array<{ id: string; text: string; metadata?: M }>, signal?: AbortSignal): Promise<void>
  /** Store a precomputed vector directly (no embedder call). */
  addVector(record: IndexRecord<M>): void
  /** Embed `query` and return the top matches. */
  query(query: string, opts?: SemanticQueryOptions): Promise<SemanticHit<M>[]>
  /** Rank against a precomputed query vector (no embedder call). */
  queryByVector(vector: number[], opts?: Omit<SemanticQueryOptions, 'signal'>): SemanticHit<M>[]
  /** Remove a record. Returns `true` if it existed. */
  remove(id: string): boolean
  /** Look up a stored record by id. */
  get(id: string): IndexRecord<M> | undefined
  /** All stored records (insertion order). */
  list(): IndexRecord<M>[]
  /** Number of stored records. */
  readonly size: number
  /** Drop everything. */
  clear(): void
}

export function createSemanticIndex<M = unknown>(opts: SemanticIndexOptions): SemanticIndex<M> {
  const { embedder } = opts
  const similarity = opts.similarity ?? cosineSimilarity
  const records = new Map<string, IndexRecord<M>>()

  const rank = (vector: number[], options?: SemanticQueryOptions): SemanticHit<M>[] => {
    const topK = options?.topK ?? 5
    const threshold = options?.threshold ?? -Infinity
    const hits: SemanticHit<M>[] = []
    for (const rec of records.values()) {
      const score = similarity(vector, rec.vector)
      if (score < threshold) continue
      hits.push({ id: rec.id, score, text: rec.text, metadata: rec.metadata })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, topK)
  }

  return {
    async add(id, text, metadata, signal) {
      const { embedding } = await embedder.embed(text, { signal })
      records.set(id, { id, vector: embedding, text, metadata })
    },

    async addMany(items, signal) {
      if (items.length === 0) return
      const { embeddings } = await embedder.embedMany(
        items.map((it) => it.text),
        { signal },
      )
      items.forEach((it, i) => {
        records.set(it.id, { id: it.id, vector: embeddings[i] as number[], text: it.text, metadata: it.metadata })
      })
    },

    addVector(record) {
      records.set(record.id, record)
    },

    async query(query, options) {
      const { embedding } = await embedder.embed(query, { signal: options?.signal })
      return rank(embedding, options)
    },

    queryByVector(vector, options) {
      return rank(vector, options)
    },

    remove(id) {
      return records.delete(id)
    },

    get(id) {
      return records.get(id)
    },

    list() {
      return [...records.values()]
    },

    get size() {
      return records.size
    },

    clear() {
      records.clear()
    },
  }
}
