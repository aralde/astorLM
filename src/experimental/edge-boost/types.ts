/**
 * Public tuning surface for the edge-boost profile plus the internal resolution
 * of that surface into fully-defaulted config. See the module JSDoc in
 * `index.ts` for what edge-boost defends against.
 */

import type { Embedder } from '../../embeddings/types.js'

// ---------- Public tuning options ----------

export interface GuardOptions {
  /**
   * Max consecutive identical deltas (compared after trimming whitespace) before
   * aborting the attempt. Compared across `text_delta` AND `thinking_delta`.
   * Default: 15. Set 0 to disable this rule.
   */
  maxRepeatedDeltas?: number
  /**
   * Max ms without a "productive" event (text_delta / tool_use_* / message_end)
   * since the stream started or since the last productive event. `thinking_delta`
   * does NOT reset this timer. Default: 20_000. Set 0 to disable.
   */
  stallTimeoutMs?: number
  /**
   * Max accumulated thinking characters before any content appears. Guards
   * against a reasoning channel that loops forever without producing an answer.
   * Default: 16_000 (~4k tokens by the 4-chars heuristic). Set 0 to disable.
   */
  maxThinkingChars?: number
  /**
   * Internal retry attempts when degeneration is detected (includes the first).
   * Default: 2. Retries only happen before any productive output was forwarded.
   */
  maxAttempts?: number
}

export interface ContextDietOptions {
  /**
   * Truncate `tool_result` blocks outside the protected window to this many
   * chars (a `[edge-boost: truncated N chars]` suffix is appended).
   * Default: 1500. Set 0 to disable truncation.
   */
  toolResultMaxChars?: number
  /**
   * Number of most-recent tool-result messages kept fully intact. A tool-result
   * message ≈ one tool round's outputs. Default: 2.
   */
  keepRecentToolRounds?: number
  /**
   * Optional replacement system prompt for weak models. When set, it fully
   * replaces the session system prompt on every provider call (session history
   * is untouched). Default: undefined (no replacement).
   */
  compactSystemPrompt?: string
}

export interface SynthesisOptions {
  /**
   * After this many completed tool rounds within the CURRENT user request, force
   * synthesis: append the instruction to the system prompt and set the tool
   * choice per `mechanism`. Default: 3. Set 0 to disable forcing.
   */
  forceAfterToolRounds?: number
  /** Instruction appended to the system prompt when forcing. Default: English (see §5.4). */
  instruction?: string
  /**
   * `'tool-choice-none'` (default): keep tool schemas declared and set
   * `toolChoice: 'none'`. `'strip-tools'`: return `tools: []` — fallback for
   * compat servers that reject `tool_choice: 'none'`.
   */
  mechanism?: 'tool-choice-none' | 'strip-tools'
}

export interface SamplingDefaults {
  /** Injected into `streamOpts.maxTokens` when the call does not set one. Default: 1024. */
  maxTokens?: number
  /** Injected into `sampling.frequencyPenalty` when absent. Default: 0.2. */
  frequencyPenalty?: number
  /** Optional, injected when absent. No default (undefined = do not inject). */
  presencePenalty?: number
  temperature?: number
  topP?: number
}

export interface OptimizerTuning {
  compressThreshold?: number
  keepRecentTurns?: number
}

/**
 * Options for the semantic tool-pruning hook. Requires an {@link Embedder}, so
 * it is DISABLED by default (unlike the other sections) — enable it explicitly.
 *
 * NOTE: relevance-based tool selection is a general context-management
 * capability, not a weak-model defense per se. It ships here for convenience but
 * is a candidate for extraction into its own module if it matures.
 */
export interface ToolPruningOptions {
  /** Embedder from `astorlm/embeddings` (or any compatible implementation). */
  embedder: Embedder
  /** Max tools exposed per call. Default: 6. */
  topK?: number
  /** Tool names always kept regardless of score (e.g. plan tools, load_skill). */
  alwaysKeep?: string[]
}

/**
 * The full edge-boost tuning surface. Every section defaults to enabled with the
 * documented defaults; pass `false` to disable a section.
 */
export interface EdgeBoostTuning {
  /** Stream degeneration guard. `false` disables the provider wrapper's guard rules. */
  guard?: GuardOptions | false
  /** Per-call tool_result truncation + optional compact system prompt. */
  contextDiet?: ContextDietOptions | false
  /** Forced synthesis after N tool rounds. */
  synthesis?: SynthesisOptions | false
  /** Sampling defaults injected when the call omits them. */
  sampling?: SamplingDefaults | false
  /**
   * Tighter context-optimizer defaults, applied ONLY when the caller did not pass
   * their own `contextOptimizer` object (or `false`). `false` here leaves the
   * caller's optimizer setting untouched.
   */
  optimizer?: OptimizerTuning | false
  /**
   * Semantic tool pruning. DISABLED by default (needs an embedder + a running
   * embeddings endpoint); enable by passing options. Never fails a turn if the
   * embedder errors — it passes tools through unpruned.
   */
  toolPruning?: ToolPruningOptions | false
}

// ---------- Resolved (fully-defaulted) config ----------

export interface ResolvedGuard {
  maxRepeatedDeltas: number
  stallTimeoutMs: number
  maxThinkingChars: number
  maxAttempts: number
}

export interface ResolvedContextDiet {
  toolResultMaxChars: number
  keepRecentToolRounds: number
  compactSystemPrompt?: string
}

export interface ResolvedSynthesis {
  forceAfterToolRounds: number
  instruction: string
  mechanism: 'tool-choice-none' | 'strip-tools'
}

/** All fields optional: each is injected into the call only when present. */
export interface ResolvedSampling {
  maxTokens?: number
  frequencyPenalty?: number
  presencePenalty?: number
  temperature?: number
  topP?: number
}

export interface ResolvedOptimizer {
  compressThreshold: number
  keepRecentTurns: number
}

export interface ResolvedToolPruning {
  embedder: Embedder
  topK: number
  alwaysKeep: string[]
}

export interface ResolvedEdgeBoostTuning {
  guard: ResolvedGuard | null
  contextDiet: ResolvedContextDiet | null
  synthesis: ResolvedSynthesis | null
  sampling: ResolvedSampling | null
  optimizer: ResolvedOptimizer | null
  toolPruning: ResolvedToolPruning | null
}

// ---------- Defaults ----------

export const DEFAULT_SYNTHESIS_INSTRUCTION =
  'You now have enough information. Do not call any more tools. Answer the user ' +
  'directly and concisely, based on the tool results above.'

export const GUARD_DEFAULTS: ResolvedGuard = {
  maxRepeatedDeltas: 15,
  stallTimeoutMs: 20_000,
  maxThinkingChars: 16_000,
  maxAttempts: 2,
}

export const CONTEXT_DIET_DEFAULTS: Omit<ResolvedContextDiet, 'compactSystemPrompt'> = {
  toolResultMaxChars: 1500,
  keepRecentToolRounds: 2,
}

export const SYNTHESIS_DEFAULTS: ResolvedSynthesis = {
  forceAfterToolRounds: 3,
  instruction: DEFAULT_SYNTHESIS_INSTRUCTION,
  mechanism: 'tool-choice-none',
}

export const SAMPLING_DEFAULTS: ResolvedSampling = {
  maxTokens: 1024,
  frequencyPenalty: 0.2,
}

export const OPTIMIZER_DEFAULTS: ResolvedOptimizer = {
  compressThreshold: 0.6,
  keepRecentTurns: 2,
}

// ---------- Resolution ----------

/**
 * Resolves the (possibly partial or absent) tuning into fully-defaulted config.
 * A section set to `false` resolves to `null` (disabled). An omitted section
 * resolves to its defaults (enabled). Exported for direct unit testing.
 */
export function resolveEdgeBoostTuning(tuning?: EdgeBoostTuning): ResolvedEdgeBoostTuning {
  return {
    guard:
      tuning?.guard === false
        ? null
        : { ...GUARD_DEFAULTS, ...(tuning?.guard ?? {}) },
    contextDiet:
      tuning?.contextDiet === false
        ? null
        : { ...CONTEXT_DIET_DEFAULTS, ...(tuning?.contextDiet ?? {}) },
    synthesis:
      tuning?.synthesis === false
        ? null
        : { ...SYNTHESIS_DEFAULTS, ...(tuning?.synthesis ?? {}) },
    sampling:
      tuning?.sampling === false
        ? null
        : { ...SAMPLING_DEFAULTS, ...(tuning?.sampling ?? {}) },
    optimizer:
      tuning?.optimizer === false
        ? null
        : { ...OPTIMIZER_DEFAULTS, ...(tuning?.optimizer ?? {}) },
    // Tool pruning is opt-in: disabled unless an options object is provided
    // (a truthy value here is a ToolPruningOptions, never `false`).
    toolPruning: tuning?.toolPruning
      ? {
          embedder: tuning.toolPruning.embedder,
          topK: tuning.toolPruning.topK ?? 6,
          alwaysKeep: tuning.toolPruning.alwaysKeep ?? [],
        }
      : null,
  }
}
