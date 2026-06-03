import type { AgentEvent } from '../../types.js'

/** Running aggregate of a numeric quantity (latencies, etc.). */
export interface Stat {
  count: number
  sum: number
  min: number
  max: number
  avg: number
}

/** Point-in-time snapshot of the metrics aggregated from an agent's event bus. */
export interface MetricsSnapshot {
  /** Completed `agent.run()` invocations (session_end events). */
  runs: number
  turns: number
  providerCalls: number
  toolCalls: number
  toolErrors: number
  providerRetries: number
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheCreation: number
  }
  /** Total USD cost — present only when a pricing table was supplied. */
  costUsd?: number
  latency: {
    /** Time-to-first-token per turn. */
    ttftMs: Stat
    /** Wall-clock duration of each turn. */
    turnMs: Stat
    /** Reported execution time of each tool. */
    toolMs: Stat
  }
}

/** Minimal structural view of an Agent the metrics collector needs. */
export interface MeterableAgent {
  readonly provider: { readonly model: string }
  on(event: 'event', listener: (e: AgentEvent) => void): () => void
}
