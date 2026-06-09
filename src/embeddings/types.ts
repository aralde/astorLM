/**
 * First-class embeddings primitives.
 *
 * Runtime-agnostic: nothing here imports Node. The reference
 * implementation (`createOpenAIEmbedder`) uses the global `fetch`, so the
 * whole module runs anywhere `fetch` exists (Node ≥ 18, Deno, browsers,
 * edge runtimes).
 *
 * Design mirrors `Provider`: an `Embedder` is an object with methods, not
 * a bag of free functions. The naming (`Embedder`, `embed`, `embedMany`)
 * aligns with the wider ecosystem (Vercel AI SDK, Mastra) so an astorlm
 * embedder is a drop-in mental model for anyone coming from there.
 */

/** Token accounting for an embedding call, when the endpoint reports it. */
export interface EmbeddingUsage {
  /** Tokens consumed by the input text(s). */
  inputTokens?: number
  /** Total tokens billed (usually equals `inputTokens` for embeddings). */
  totalTokens?: number
}

/** Result of embedding a single piece of text. */
export interface EmbedResult {
  /** The dense vector. */
  embedding: number[]
  /** Token usage, when the provider reports it. */
  usage?: EmbeddingUsage
}

/** Result of embedding a batch of texts. */
export interface EmbedManyResult {
  /** One vector per input, in the same order as the inputs. */
  embeddings: number[][]
  /** Aggregated token usage for the whole batch, when reported. */
  usage?: EmbeddingUsage
}

/** Per-call options shared by `embed` and `embedMany`. */
export interface EmbedOptions {
  /** Cooperative cancellation, propagated to the underlying request. */
  signal?: AbortSignal
}

/**
 * An embedder turns text into dense vectors. Implementations are
 * swappable the same way `Provider`s are: bring your own by implementing
 * this interface (a local model, a different HTTP API, a cache wrapper).
 */
export interface Embedder {
  /** Model identifier (informational; used for logging/inspection). */
  readonly model: string
  /**
   * Vector dimensionality, when known up front. May be `undefined` until
   * the first call resolves it from the API response.
   */
  readonly dimensions?: number
  /** Embed a single text. */
  embed(text: string, opts?: EmbedOptions): Promise<EmbedResult>
  /**
   * Embed many texts in one round-trip. Implementations should preserve
   * input order in the returned `embeddings` array.
   */
  embedMany(texts: string[], opts?: EmbedOptions): Promise<EmbedManyResult>
}
