/**
 * Minimal OpenAI-compatible embeddings client. When the caller does not
 * configure an embedder, the registry falls back to fuzzy matching
 * (Jaccard) and this file is unused.
 *
 * Does not depend on the OpenAI or Anthropic SDKs — uses the global
 * `fetch` (Node ≥ 18) to keep the experimental module lightweight and
 * self-contained.
 */

export interface EmbeddingClient {
  embed(text: string, signal?: AbortSignal): Promise<number[]>
}

export interface OpenAIEmbeddingClientOptions {
  baseURL: string
  model: string
  apiKey?: string
}

export function createOpenAIEmbeddingClient(opts: OpenAIEmbeddingClientOptions): EmbeddingClient {
  const apiKey = opts.apiKey ?? 'not-needed'
  const url = `${opts.baseURL.replace(/\/$/, '')}/embeddings`

  return {
    async embed(text, signal) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: opts.model, input: text }),
        signal,
      })
      if (!res.ok) {
        throw new Error(`Embeddings API ${res.status}: ${await res.text().catch(() => '')}`)
      }
      const json = (await res.json()) as { data?: Array<{ embedding: number[] }> }
      const vec = json.data?.[0]?.embedding
      if (!Array.isArray(vec)) {
        throw new Error('Embeddings response missing data[0].embedding')
      }
      return vec
    },
  }
}

/** Cosine similarity in [-1..1], clamped to [0..1] for ranking. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number
    const bi = b[i] as number
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  if (denom === 0) return 0
  // Normalize to [0..1] so it is comparable with Jaccard.
  return Math.max(0, dot / denom)
}
