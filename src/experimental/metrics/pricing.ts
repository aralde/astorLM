import type { TokenUsage } from '../../types.js'

/**
 * Per-model pricing in USD per 1,000,000 tokens. Cache rates are optional —
 * many OpenAI-compatible endpoints don't report (or charge for) cache tokens.
 */
export interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
  cacheReadPer1M?: number
  cacheCreationPer1M?: number
}

/** Map of model name → pricing. Keys may be exact ids or prefixes (see {@link resolvePricing}). */
export type PricingTable = Record<string, ModelPricing>

/**
 * Resolves pricing for a model: exact match first, then the longest key that is
 * a prefix of the model id (so `'gpt-4o'` matches `'gpt-4o-2024-08-06'`).
 */
export function resolvePricing(table: PricingTable, model: string): ModelPricing | undefined {
  if (table[model]) return table[model]
  let best: { key: string; pricing: ModelPricing } | undefined
  for (const [key, pricing] of Object.entries(table)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, pricing }
    }
  }
  return best?.pricing
}

/** Computes the USD cost of a token usage under the given pricing. */
export function computeCost(usage: TokenUsage, pricing: ModelPricing): number {
  const M = 1_000_000
  let cost =
    (usage.inputTokens / M) * pricing.inputPer1M +
    (usage.outputTokens / M) * pricing.outputPer1M
  if (usage.cacheReadTokens && pricing.cacheReadPer1M) {
    cost += (usage.cacheReadTokens / M) * pricing.cacheReadPer1M
  }
  if (usage.cacheCreationTokens && pricing.cacheCreationPer1M) {
    cost += (usage.cacheCreationTokens / M) * pricing.cacheCreationPer1M
  }
  return cost
}
