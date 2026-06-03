/**
 * Experimental `evals` module — offline evaluation harness.
 *
 * ⚠️ Volatile API behind a dedicated subpath. Runtime-agnostic core; the
 * `llmJudge` scorer needs a `Provider` (point it at a local OpenAI-compatible
 * endpoint per the project convention).
 *
 * Pieces:
 *  - Dataset of `EvalCase`s (input + optional expected/tags).
 *  - `Scorer`s: `exactMatch`, `contains`, `regexMatch`, `toolTrajectory`,
 *    `llmJudge`. Each returns a normalized 0..1 `Score` with a pass flag.
 *  - `runEval` runs each case through a fresh agent, applies the scorers, and
 *    aggregates an `EvalReport` (overall pass rate + per-scorer stats). Great
 *    for CI gating; pair the agent factory with the replay provider for fast,
 *    network-free regression runs.
 */
export { runEval } from './runner.js'
export type { RunEvalOptions } from './runner.js'
export {
  exactMatch,
  contains,
  regexMatch,
  toolTrajectory,
} from './scorers.js'
export type { MatchOptions, TrajectoryMode } from './scorers.js'
export { llmJudge } from './llmJudge.js'
export type { LlmJudgeOptions } from './llmJudge.js'
export type {
  EvalCase,
  EvalRunResult,
  Score,
  Scorer,
  ScoredCase,
  EvalReport,
  EvaluableAgent,
} from './types.js'
