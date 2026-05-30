import type { SessionHooks } from '../types.js'

/**
 * A small helper around the loop's built-in steering mechanism.
 *
 * The loop already supports steering: a `beforeToolExecution` hook can return
 * `{ steer: true, feedback }` to cancel the current (and sibling) tool calls
 * of the turn and feed the model a `[User Steering Feedback]` note on the next
 * turn — redirecting it without aborting the whole run. What was missing is an
 * ergonomic way to push that feedback from *outside* a hook (e.g. a UI
 * button). This controller holds a one-shot feedback slot and exposes a ready
 * `SessionHooks` that drains it at the next tool boundary.
 *
 * Note: steering takes effect at the next tool-call boundary, not mid-token.
 * If the model is streaming plain text with no pending tool calls, the
 * feedback applies at the next turn that does call a tool.
 */
export interface SteeringController {
  /** Queue feedback to steer the agent at the next tool boundary. */
  steer(feedback: string): void
  /** Discard any queued feedback that has not been consumed yet. */
  clear(): void
  /** The currently queued feedback, or `null` if none is pending. */
  readonly pending: string | null
  /** Pass this into `createAgent({ hooks })`. */
  readonly hooks: SessionHooks
}

/**
 * Create a {@link SteeringController}. Optionally wrap an existing
 * `SessionHooks`: when no steering is queued, `beforeToolExecution` delegates
 * to the base hook (or authorizes by default); all other base hooks are
 * preserved untouched.
 */
export function createSteeringController(base?: SessionHooks): SteeringController {
  let pending: string | null = null

  const hooks: SessionHooks = {
    ...base,
    beforeToolExecution: async (ctx) => {
      if (pending !== null) {
        const feedback = pending
        pending = null
        return { authorize: false, steer: true, feedback }
      }
      if (base?.beforeToolExecution) return base.beforeToolExecution(ctx)
      return { authorize: true }
    },
  }

  return {
    steer(feedback: string) {
      pending = feedback
    },
    clear() {
      pending = null
    },
    get pending() {
      return pending
    },
    hooks,
  }
}
