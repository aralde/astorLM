import { computeCost, resolvePricing, type PricingTable } from './pricing.js'
import type { MeterableAgent, MetricsSnapshot, Stat } from './types.js'

export interface AttachMetricsOptions {
  /** Optional per-model pricing. When supplied, the snapshot includes `costUsd`. */
  pricing?: PricingTable
  /** Clock override (epoch ms). Defaults to `Date.now`. */
  now?: () => number
}

export interface AttachedMetrics {
  /** Returns a copy of the current aggregated metrics. */
  snapshot(): MetricsSnapshot
  /** Zeroes all counters. */
  reset(): void
  /** Unsubscribes from the bus. */
  detach(): void
}

function emptyStat(): Stat {
  return { count: 0, sum: 0, min: Infinity, max: -Infinity, avg: 0 }
}

function record(stat: Stat, value: number): void {
  stat.count += 1
  stat.sum += value
  if (value < stat.min) stat.min = value
  if (value > stat.max) stat.max = value
  stat.avg = stat.sum / stat.count
}

/** Replaces Infinity sentinels with 0 for an empty stat (cleaner snapshot). */
function finalizeStat(stat: Stat): Stat {
  if (stat.count === 0) return { count: 0, sum: 0, min: 0, max: 0, avg: 0 }
  return { ...stat }
}

/**
 * Subscribes to an agent's event bus and aggregates operational metrics:
 * counts, token totals, optional USD cost, and latency stats (TTFT, turn, tool).
 * Pure observation — it never mutates the loop. Pair it with {@link attachTracer}
 * or use it standalone.
 */
export function attachMetrics(
  agent: MeterableAgent,
  options: AttachMetricsOptions = {},
): AttachedMetrics {
  const now = options.now ?? Date.now
  const pricing = options.pricing
  const modelPricing = pricing ? resolvePricing(pricing, agent.provider.model) : undefined

  let runs = 0
  let turns = 0
  let providerCalls = 0
  let toolCalls = 0
  let toolErrors = 0
  let providerRetries = 0
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  let costUsd = pricing ? 0 : undefined
  let ttftMs = emptyStat()
  let turnMs = emptyStat()
  let toolMs = emptyStat()

  // Per-turn transient state.
  let turnStartedAt = 0
  let ttftSeen = false

  const unsubscribe = agent.on('event', (e) => {
    switch (e.type) {
      case 'turn_start':
        providerCalls += 1
        turnStartedAt = now()
        ttftSeen = false
        break
      case 'text_delta':
      case 'thinking_delta':
        if (!ttftSeen) {
          ttftSeen = true
          record(ttftMs, now() - turnStartedAt)
        }
        break
      case 'tool_execution_start':
        toolCalls += 1
        break
      case 'tool_execution_end':
        record(toolMs, e.durationMs)
        if (e.isError) toolErrors += 1
        break
      case 'provider_retry':
        providerRetries += 1
        break
      case 'turn_end':
        turns += 1
        record(turnMs, now() - turnStartedAt)
        if (e.usage) {
          tokens.input += e.usage.inputTokens
          tokens.output += e.usage.outputTokens
          tokens.cacheRead += e.usage.cacheReadTokens ?? 0
          tokens.cacheCreation += e.usage.cacheCreationTokens ?? 0
          if (modelPricing && costUsd !== undefined) {
            costUsd += computeCost(e.usage, modelPricing)
          }
        }
        break
      case 'session_end':
        runs += 1
        break
      default:
        break
    }
  })

  return {
    snapshot() {
      return {
        runs,
        turns,
        providerCalls,
        toolCalls,
        toolErrors,
        providerRetries,
        tokens: { ...tokens },
        ...(costUsd !== undefined ? { costUsd } : {}),
        latency: {
          ttftMs: finalizeStat(ttftMs),
          turnMs: finalizeStat(turnMs),
          toolMs: finalizeStat(toolMs),
        },
      }
    },
    reset() {
      runs = turns = providerCalls = toolCalls = toolErrors = providerRetries = 0
      tokens.input = tokens.output = tokens.cacheRead = tokens.cacheCreation = 0
      costUsd = pricing ? 0 : undefined
      ttftMs = emptyStat()
      turnMs = emptyStat()
      toolMs = emptyStat()
    },
    detach: unsubscribe,
  }
}
