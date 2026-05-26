/**
 * Cliente mínimo de embeddings OpenAI-compat. Si el caller no configura
 * un embedder, el registry cae a matching fuzzy (Jaccard) y este archivo
 * no se usa.
 *
 * No depende del SDK de OpenAI ni del de Anthropic — usa `fetch` global
 * (Node ≥ 18) para mantener el módulo experimental liviano y aislado.
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
        throw new Error('Respuesta de embeddings sin data[0].embedding')
      }
      return vec
    },
  }
}

/** Similitud coseno [-1..1] (clampeada a [0..1] arriba para el ranking). */
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
  // Normalizamos a [0..1] para que sea comparable con Jaccard.
  return Math.max(0, dot / denom)
}
