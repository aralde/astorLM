/**
 * Experimental `metrics` module — cost & operational metrics.
 *
 * ⚠️ Volatile API behind a dedicated subpath. Runtime-agnostic (reads only the
 * event bus). Two concerns:
 *
 *  - Pricing/cost: `computeCost` + `resolvePricing` turn a `TokenUsage` and a
 *    per-model pricing table into a USD figure. No prices are hardcoded — the
 *    consumer supplies the table.
 *  - Aggregation: `attachMetrics` subscribes to the bus and tallies counts,
 *    tokens, optional cost, and latency stats (TTFT / turn / tool).
 */
export { attachMetrics } from './collector.js'
export type { AttachMetricsOptions, AttachedMetrics } from './collector.js'
export { computeCost, resolvePricing } from './pricing.js'
export type { ModelPricing, PricingTable } from './pricing.js'
export type { MetricsSnapshot, Stat, MeterableAgent } from './types.js'
