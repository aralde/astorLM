import type { CreateAgentOptions } from '../../agent/session.js'
import type { SessionHooks } from '../../types.js'
import { createGuardedProvider } from './guardedProvider.js'
import { buildContextDietHook } from './contextDiet.js'
import { buildSynthesisHook } from './synthesis.js'
import { mergeSessionHooks } from './mergeHooks.js'
import {
  resolveEdgeBoostTuning,
  type EdgeBoostTuning,
  type ResolvedEdgeBoostTuning,
} from './types.js'

/** Non-enumerable marker used to detect (and no-op) double application. */
const EDGE_BOOST_MARK = Symbol.for('astorlm.edgeBoost')

/**
 * Builds the composed edge-boost `SessionHooks` from resolved tuning: the diet
 * runs first, then synthesis (synthesis may still clear tools / set toolChoice
 * after the diet trimmed the history). Returns `null` when no hook section is
 * enabled.
 */
function buildEdgeBoostHooks(resolved: ResolvedEdgeBoostTuning): SessionHooks | null {
  const fragments: Array<NonNullable<SessionHooks['beforeProviderCall']>> = []
  if (resolved.contextDiet) fragments.push(buildContextDietHook(resolved.contextDiet))
  if (resolved.synthesis) fragments.push(buildSynthesisHook(resolved.synthesis))
  if (fragments.length === 0) return null

  return {
    beforeProviderCall: async (ctx) => {
      let messages = ctx.messages
      let systemPrompt = ctx.systemPrompt
      let tools = ctx.tools
      let toolChoice: 'auto' | 'none' | 'required' | undefined
      for (const frag of fragments) {
        const r = await frag({ ...ctx, messages, systemPrompt, tools })
        messages = r.messages
        systemPrompt = r.systemPrompt
        if (r.tools) tools = r.tools
        if (r.toolChoice) toolChoice = r.toolChoice
      }
      return { messages, systemPrompt, tools, ...(toolChoice ? { toolChoice } : {}) }
    },
  }
}

/**
 * Returns the composed edge-boost hooks (context diet + forced synthesis) for a
 * given tuning, without the provider wrapper or optimizer changes. Useful when a
 * consumer wants only the hook behavior. Returns `{}` if every hook section is
 * disabled.
 */
export function edgeBoostHooks(tuning?: EdgeBoostTuning): SessionHooks {
  return buildEdgeBoostHooks(resolveEdgeBoostTuning(tuning)) ?? {}
}

/**
 * Options-transformer that hardens a {@link CreateAgentOptions} for weak / local
 * / free-tier models. Pure `CreateAgentOptions → CreateAgentOptions`: wraps the
 * provider with the degeneration guard (+ sampling defaults), merges the
 * edge-boost hooks (context diet + forced synthesis) with any user hooks, and
 * tightens the context-optimizer defaults. Never mutates the input.
 *
 * Applying it twice is a no-op (a non-enumerable marker is checked): the second
 * call returns the input unchanged and warns via `options.logger`.
 */
export function edgeBoost(options: CreateAgentOptions, tuning?: EdgeBoostTuning): CreateAgentOptions {
  if ((options as unknown as Record<symbol, unknown>)[EDGE_BOOST_MARK]) {
    options.logger?.warn?.('edgeBoost() applied to an already-boosted options object; returning it unchanged.')
    return options
  }

  const resolved = resolveEdgeBoostTuning(tuning)

  // Provider: wrap when guard OR sampling is enabled. Read contextLimit from the
  // ORIGINAL provider before wrapping (the wrapper delegates it, so it is safe
  // either way, but this keeps intent explicit).
  const originalContextLimit = options.provider.contextLimit
  let provider = options.provider
  if (resolved.guard || resolved.sampling) {
    provider = createGuardedProvider(options.provider, {
      // resolved.guard is a fully-defaulted ResolvedGuard (structurally a
      // GuardOptions); pass it through so user overrides survive. `null` → false.
      guard: resolved.guard ?? false,
      sampling: resolved.sampling ?? undefined,
    })
  }

  // Hooks: merge user hooks (first) with edge-boost hooks (second) so the profile
  // sees and wins over the user's transformation.
  const edgeHooks = buildEdgeBoostHooks(resolved)
  const hooks = edgeHooks ? mergeSessionHooks(options.hooks, edgeHooks) : options.hooks

  // Context optimizer: tighten defaults ONLY when the caller left it unset (not
  // an object, not explicitly false).
  let contextOptimizer = options.contextOptimizer
  if (
    resolved.optimizer &&
    typeof options.contextOptimizer !== 'object' &&
    options.contextOptimizer !== false
  ) {
    contextOptimizer = {
      maxTokens: originalContextLimit ?? 16_000,
      compressThreshold: resolved.optimizer.compressThreshold,
      keepRecentTurns: resolved.optimizer.keepRecentTurns,
    }
  }

  const out: CreateAgentOptions = { ...options, provider, hooks, contextOptimizer }
  Object.defineProperty(out, EDGE_BOOST_MARK, { value: true, enumerable: false })
  return out
}
