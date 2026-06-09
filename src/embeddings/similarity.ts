/**
 * Vector similarity / distance helpers.
 *
 * These operate on plain `number[]` vectors and have no dependency on any
 * particular `Embedder`. All functions return `0` for mismatched lengths
 * or empty vectors instead of throwing — callers ranking over a corpus
 * usually prefer a neutral score to an exception.
 */

/**
 * Cosine similarity in the standard `[-1..1]` range (1 = identical
 * direction, 0 = orthogonal, -1 = opposite). This is the industry
 * convention (Vercel AI SDK, LangChain, etc.).
 *
 * Note: it is NOT clamped to `[0..1]`. Consumers that need a non-negative
 * score (e.g. to compare against a Jaccard ratio) should clamp at the
 * call site with `Math.max(0, cosineSimilarity(a, b))`.
 */
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
  return dot / denom
}

/** Dot product of two equal-length vectors. */
export function dotProduct(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number)
  }
  return dot
}

/** Euclidean (L2) distance between two equal-length vectors. */
export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] as number) - (b[i] as number)
    sum += d * d
  }
  return Math.sqrt(sum)
}
