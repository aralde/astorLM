import type { Agent } from './session.js'
import type { Message } from '../types.js'

/**
 * Context passed to the per-iteration callbacks of a goal loop.
 */
export interface GoalLoopIterationContext {
  /** 1-based iteration number. */
  iteration: number
  /** The goal being pursued (verbatim from {@link GoalLoopOptions.goal}). */
  goal: string
}

/**
 * Context passed to {@link GoalLoopOptions.isDone} and
 * {@link GoalLoopOptions.onIteration} after an iteration completes.
 */
export interface GoalLoopResultContext extends GoalLoopIterationContext {
  /** Concatenated text of the agent's final assistant message this iteration. */
  lastText: string
  /** The fresh agent that ran this iteration (already finished). */
  agent: Agent
}

/**
 * Options for {@link runGoalLoop}, the "goal-seeking" / Ralph loop pattern.
 *
 * Unlike {@link Agent.startHeartbeat}, which re-runs a prompt against the SAME
 * accumulating session, a goal loop spins up a FRESH agent on every iteration
 * (empty `messages[]`, fresh context window). State survives between iterations
 * not through conversation history but through the working directory: the agent
 * reads and writes progress files (a TODO / PROGRESS.md), the git tree, etc.,
 * using its own tools. This avoids the quality degradation of an ever-growing
 * context at the cost of re-establishing context each iteration.
 *
 * It is pure composition over the public API: it never touches the agent loop
 * or the session internals. The caller supplies the agent factory and the stop
 * condition; the loop only sequences iterations and enforces the iteration cap.
 */
export interface GoalLoopOptions {
  /** The goal to pursue. Fed as the prompt of each iteration by default. */
  goal: string
  /**
   * Factory that returns a FRESH agent for the given iteration. Called once per
   * iteration — returning a new agent each time is what gives the loop a clean
   * context window. Typically wraps `createAgent`/`createLocalAgent` with the
   * same `cwd` so iterations share on-disk state.
   */
  createIterationAgent: (ctx: GoalLoopIterationContext) => Agent | Promise<Agent>
  /**
   * Stop condition, evaluated after each iteration. Return `true` to end the
   * loop. Keep it cheap and deterministic — e.g. run the test suite through the
   * executor and check the exit code, or assert a marker file exists. This is
   * the `plan → act → test → iterate` gate.
   */
  isDone: (ctx: GoalLoopResultContext) => boolean | Promise<boolean>
  /**
   * Hard cap on iterations. A goal loop MUST have a fuse so a never-satisfied
   * `isDone` cannot run forever. Defaults to 10.
   */
  maxIterations?: number
  /**
   * Builds the prompt for a given iteration. Defaults to returning `goal`
   * verbatim (the classic fixed-prompt Ralph loop). Override to inject the
   * iteration number or a rotating instruction.
   */
  iterationPrompt?: (ctx: GoalLoopIterationContext) => string
  /** Observability hook fired after each iteration completes. */
  onIteration?: (ctx: GoalLoopResultContext) => void | Promise<void>
  /**
   * Abort signal. Checked before each iteration and propagated to every
   * `agent.run()`, so aborting stops the loop and the in-flight iteration.
   */
  abortSignal?: AbortSignal
}

/**
 * Outcome of a {@link runGoalLoop} call.
 */
export interface GoalLoopResult {
  /** Number of iterations actually run. */
  iterations: number
  /** Whether `isDone` returned true (vs. hitting the iteration cap or abort). */
  done: boolean
  /** Final assistant text from the last iteration that ran. */
  lastText: string
  /** Why the loop stopped. */
  stopReason: 'done' | 'max_iterations' | 'aborted'
}

const DEFAULT_MAX_ITERATIONS = 10

/**
 * Runs a goal-seeking loop: repeatedly spin up a fresh agent, run it against
 * the goal, and check {@link GoalLoopOptions.isDone} — until the goal is met,
 * the iteration cap is hit, or the loop is aborted. See {@link GoalLoopOptions}.
 */
export async function runGoalLoop(opts: GoalLoopOptions): Promise<GoalLoopResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const buildPrompt = opts.iterationPrompt ?? ((ctx) => ctx.goal)

  let lastText = ''
  let iteration = 0

  while (iteration < maxIterations) {
    if (opts.abortSignal?.aborted) {
      return { iterations: iteration, done: false, lastText, stopReason: 'aborted' }
    }

    iteration++
    const iterCtx: GoalLoopIterationContext = { iteration, goal: opts.goal }
    const agent = await opts.createIterationAgent(iterCtx)

    const final = await agent.run(buildPrompt(iterCtx), { abortSignal: opts.abortSignal })
    lastText = extractText(final)

    const resultCtx: GoalLoopResultContext = { ...iterCtx, lastText, agent }
    await opts.onIteration?.(resultCtx)

    if (await opts.isDone(resultCtx)) {
      return { iterations: iteration, done: true, lastText, stopReason: 'done' }
    }
  }

  return { iterations: iteration, done: false, lastText, stopReason: 'max_iterations' }
}

/** Concatenate the text blocks of an assistant message. */
function extractText(message: Message): string {
  return message.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
}
