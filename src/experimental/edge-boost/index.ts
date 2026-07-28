/**
 * edge-boost — an experimental, opt-in hardening profile for weak / local /
 * free-tier models. It defends against the failure where a quantized or
 * free-tier model, on a long multi-turn tool context (typically the synthesis
 * turn after several tool round-trips), degenerates into an infinite repetition
 * loop or stalls without ever producing content until a timeout fires. The
 * profile bundles four defenses: a stream guard that detects degeneration
 * (token repetition, no-content stall, reasoning-budget blowout) and retries
 * cheaply against the same endpoint; a per-call context diet that trims old
 * tool_results and can swap in a compact system prompt; forced synthesis that,
 * after N tool rounds, tells the model to answer now and removes its ability to
 * call more tools; and sampling defaults (max_tokens + repetition penalty). It
 * is applied as a pure options-transformer — `edgeBoost(createLocalAgentOptions)`
 * — and changes no default behavior unless opted into.
 *
 * Everything here is experimental: the tuning surface may change. Not exported
 * from the main `astorlm` barrel.
 */

export { edgeBoost, edgeBoostHooks } from './edgeBoost.js'
export { createGuardedProvider, DegenerationError } from './guardedProvider.js'
export type { CreateGuardedProviderOptions } from './guardedProvider.js'
export { buildContextDietHook } from './contextDiet.js'
export { buildSynthesisHook } from './synthesis.js'
export { buildToolPruningHook } from './toolPruning.js'
export { mergeSessionHooks } from './mergeHooks.js'
export {
  resolveEdgeBoostTuning,
  DEFAULT_SYNTHESIS_INSTRUCTION,
  GUARD_DEFAULTS,
  CONTEXT_DIET_DEFAULTS,
  SYNTHESIS_DEFAULTS,
  SAMPLING_DEFAULTS,
  OPTIMIZER_DEFAULTS,
} from './types.js'
export type {
  EdgeBoostTuning,
  GuardOptions,
  ContextDietOptions,
  SynthesisOptions,
  SamplingDefaults,
  OptimizerTuning,
  ToolPruningOptions,
  ResolvedEdgeBoostTuning,
  ResolvedGuard,
  ResolvedContextDiet,
  ResolvedSynthesis,
  ResolvedSampling,
  ResolvedOptimizer,
  ResolvedToolPruning,
} from './types.js'
