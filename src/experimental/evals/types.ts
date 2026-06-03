import type { AgentEvent, Message, TokenUsage } from '../../types.js'

/** A single evaluation case: an input prompt plus optional expected output / metadata. */
export interface EvalCase {
  id: string
  input: string
  /** Free-form expected value; scorers decide how to interpret it. */
  expected?: unknown
  tags?: string[]
  metadata?: Record<string, unknown>
}

/** The captured outcome of running one case through an agent. */
export interface EvalRunResult {
  case: EvalCase
  /** Concatenated final assistant text. */
  output: string
  /** Tool calls the agent made, in order. */
  toolCalls: Array<{ name: string; input: unknown }>
  finalMessage?: Message
  usage?: TokenUsage
  /** Set if the run threw before producing output. */
  error?: unknown
}

/** A single scorer's verdict on a run. `score` is normalized to 0..1. */
export interface Score {
  scorer: string
  score: number
  passed: boolean
  details?: string
}

/** A scoring strategy. Stateless; runs once per case result. */
export interface Scorer {
  name: string
  score(result: EvalRunResult): Score | Promise<Score>
}

/** A case result paired with all scorer verdicts. */
export interface ScoredCase {
  result: EvalRunResult
  scores: Score[]
  /** True when every scorer passed. */
  passed: boolean
}

/** Aggregate report across the whole dataset. */
export interface EvalReport {
  cases: ScoredCase[]
  summary: {
    total: number
    passed: number
    passRate: number
    /** Per-scorer mean score and pass rate, keyed by scorer name. */
    byScorer: Record<string, { avg: number; passRate: number }>
  }
}

/** Minimal structural view of an Agent the eval runner needs. */
export interface EvaluableAgent {
  run(input: string, opts?: { abortSignal?: AbortSignal }): Promise<Message>
  on(event: 'event', listener: (e: AgentEvent) => void): () => void
  getUsage?(): TokenUsage
}
