import type { SessionHooks } from '../../types.js'

/**
 * Deterministically composes two {@link SessionHooks} into one. Generally useful
 * whenever a consumer stacks hooks from multiple sources (e.g. an app's own
 * hooks plus a module's).
 *
 * Semantics (per hook):
 *  - `beforeTurn` / `afterTurn`: run `first` then `second`, sequentially.
 *  - `beforeProviderCall`: chained — `second` receives `first`'s output
 *    (messages/systemPrompt/tools); later non-undefined `tools`/`toolChoice` win.
 *  - `beforeToolExecution`: both run; `authorize = a.authorize && b.authorize`;
 *    `mockResult`/`feedback` = first defined wins; `steer = a.steer || b.steer`.
 *  - `afterToolExecution`: chained — `second` receives `first`'s output string.
 *
 * When only one side defines a hook, that one is used as-is.
 */
export function mergeSessionHooks(
  first: SessionHooks | undefined,
  second: SessionHooks,
): SessionHooks {
  if (!first) return second
  const merged: SessionHooks = {}

  if (first.beforeTurn || second.beforeTurn) {
    merged.beforeTurn = async (ctx) => {
      await first.beforeTurn?.(ctx)
      await second.beforeTurn?.(ctx)
    }
  }

  if (first.afterTurn || second.afterTurn) {
    merged.afterTurn = async (ctx) => {
      await first.afterTurn?.(ctx)
      await second.afterTurn?.(ctx)
    }
  }

  if (first.beforeProviderCall || second.beforeProviderCall) {
    merged.beforeProviderCall = async (ctx) => {
      let messages = ctx.messages
      let systemPrompt = ctx.systemPrompt
      let tools = ctx.tools
      let toolChoice: 'auto' | 'none' | 'required' | undefined

      for (const hook of [first.beforeProviderCall, second.beforeProviderCall]) {
        if (!hook) continue
        const r = await hook({ ...ctx, messages, systemPrompt, tools })
        messages = r.messages
        systemPrompt = r.systemPrompt
        if (r.tools) tools = r.tools
        if (r.toolChoice) toolChoice = r.toolChoice
      }
      return { messages, systemPrompt, tools, ...(toolChoice ? { toolChoice } : {}) }
    }
  }

  if (first.beforeToolExecution || second.beforeToolExecution) {
    merged.beforeToolExecution = async (ctx) => {
      let authorize = true
      let mockResult: string | undefined
      let steer = false
      let feedback: string | undefined
      for (const hook of [first.beforeToolExecution, second.beforeToolExecution]) {
        if (!hook) continue
        const r = await hook(ctx)
        authorize = authorize && r.authorize
        if (mockResult === undefined) mockResult = r.mockResult
        steer = steer || (r.steer ?? false)
        if (feedback === undefined) feedback = r.feedback
      }
      return { authorize, mockResult, steer, feedback }
    }
  }

  if (first.afterToolExecution || second.afterToolExecution) {
    merged.afterToolExecution = async (ctx) => {
      let output = ctx.output
      if (first.afterToolExecution) output = await first.afterToolExecution({ ...ctx, output })
      if (second.afterToolExecution) output = await second.afterToolExecution({ ...ctx, output })
      return output
    }
  }

  return merged
}
