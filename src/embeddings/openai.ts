/**
 * OpenAI-compatible embedder over the global `fetch`.
 *
 * Works against any endpoint that implements the OpenAI `/embeddings`
 * shape: OpenAI itself, Ollama, vLLM, LM Studio, OpenRouter, Together,
 * a local proxy, etc. — just point `baseURL` at it. Deliberately does
 * not depend on the `openai` SDK so the module stays runtime-agnostic
 * and dependency-free.
 */

import type { Embedder, EmbedManyResult, EmbedOptions, EmbedResult, EmbeddingUsage } from './types.js'

export interface OpenAIEmbedderOptions {
  /** Base URL of the OpenAI-compatible API, e.g. `http://localhost:11434/v1`. */
  baseURL: string
  /** Embedding model id, e.g. `text-embedding-3-small`. */
  model: string
  /** API key. Defaults to `'ollama'` for local endpoints that ignore it. */
  apiKey?: string
  /**
   * Requested output dimensionality. Only honored by models that support
   * truncation (e.g. `text-embedding-3-*`); ignored by others.
   */
  dimensions?: number
  /** Extra headers merged into every request (e.g. for a gateway). */
  headers?: Record<string, string>
  /** `fetch` override for tests or custom transports. Defaults to global `fetch`. */
  fetch?: typeof fetch
}

interface EmbeddingsResponse {
  data?: Array<{ embedding: number[]; index?: number }>
  usage?: { prompt_tokens?: number; total_tokens?: number }
}

function toUsage(raw: EmbeddingsResponse['usage']): EmbeddingUsage | undefined {
  if (!raw) return undefined
  const usage: EmbeddingUsage = {}
  if (typeof raw.prompt_tokens === 'number') usage.inputTokens = raw.prompt_tokens
  if (typeof raw.total_tokens === 'number') usage.totalTokens = raw.total_tokens
  return Object.keys(usage).length > 0 ? usage : undefined
}

export function createOpenAIEmbedder(opts: OpenAIEmbedderOptions): Embedder {
  const apiKey = opts.apiKey ?? 'ollama'
  const url = `${opts.baseURL.replace(/\/$/, '')}/embeddings`
  const fetchImpl = opts.fetch ?? fetch
  // Resolved lazily from the first response so `dimensions` reflects what
  // the model actually returned, even when not requested explicitly.
  let resolvedDimensions = opts.dimensions

  const call = async (input: string | string[], signal?: AbortSignal): Promise<EmbeddingsResponse> => {
    const body: Record<string, unknown> = { model: opts.model, input }
    if (opts.dimensions != null) body.dimensions = opts.dimensions

    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...opts.headers,
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      throw new Error(`Embeddings API ${res.status}: ${await res.text().catch(() => '')}`)
    }
    return (await res.json()) as EmbeddingsResponse
  }

  return {
    model: opts.model,
    get dimensions() {
      return resolvedDimensions
    },

    async embed(text, options?: EmbedOptions): Promise<EmbedResult> {
      const json = await call(text, options?.signal)
      const vec = json.data?.[0]?.embedding
      if (!Array.isArray(vec)) {
        throw new Error('Embeddings response missing data[0].embedding')
      }
      resolvedDimensions = vec.length
      return { embedding: vec, usage: toUsage(json.usage) }
    },

    async embedMany(texts, options?: EmbedOptions): Promise<EmbedManyResult> {
      if (texts.length === 0) return { embeddings: [] }
      const json = await call(texts, options?.signal)
      const data = json.data
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error(
          `Embeddings response returned ${data?.length ?? 0} vectors for ${texts.length} inputs`,
        )
      }
      // The OpenAI spec allows out-of-order `data`; sort by `index` to be safe.
      const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      const embeddings = ordered.map((d) => d.embedding)
      if (embeddings[0]) resolvedDimensions = embeddings[0].length
      return { embeddings, usage: toUsage(json.usage) }
    },
  }
}
