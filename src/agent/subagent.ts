import { z } from 'zod'
import { tool } from '../tools/define.js'
import { createAgent } from './session.js'
import type { Message, Provider, Tool } from '../types.js'

/**
 * Options for building a subagent tool (the "agent-as-tool" pattern).
 *
 * A subagent is a fully independent {@link Agent} exposed to a parent agent
 * as a single tool. When the parent calls it, the tool spins up a fresh
 * child session with its own (typically narrower) system prompt and tool
 * set, runs ONE prompt to completion, and returns the child's final text as
 * the tool result. The parent never sees the child's intermediate turns —
 * only the distilled answer.
 *
 * This is pure composition over the existing public API: it does not touch
 * the agent loop or the session internals. The child inherits the parent's
 * `cwd`, `executor` and `logger` from the {@link ToolContext}, and the
 * parent's abort signal is propagated so cancelling the parent cancels the
 * child mid-flight.
 */
export interface SubagentToolOptions {
  /** Tool name the parent model invokes (e.g. `'research_agent'`). */
  name: string
  /** When the parent should delegate to this subagent. */
  description: string
  /** Provider the child session uses. May differ from the parent's. */
  provider: Provider
  /** System prompt for the child. Defaults to the SDK base prompt. */
  systemPrompt?: string
  /** Extra text appended to the child's system prompt. */
  appendSystemPrompt?: string
  /**
   * Tools the child is allowed to use. Scope this down to give the subagent
   * a focused capability surface. Defaults to no tools (pure reasoning).
   */
  tools?: Tool[]
  /** Max turns for the child loop. Defaults to the loop's own default. */
  maxTurns?: number
  /** Loop pattern for the child. Defaults to `'REACT'`. */
  pattern?: 'REACT' | 'PLAN_EXECUTE'
  /** Input property name the parent fills with the delegated task. Defaults to `'task'`. */
  inputKey?: string
  /** Description of the input property shown to the parent model. */
  inputDescription?: string
}

/**
 * Builds a {@link Tool} that delegates to a child agent and returns its
 * final answer as a string. See {@link SubagentToolOptions}.
 */
export function createSubagentTool(opts: SubagentToolOptions): Tool {
  const inputKey = opts.inputKey ?? 'task'
  const schema = z.object({
    [inputKey]: z
      .string()
      .describe(opts.inputDescription ?? 'The task to delegate to the subagent.'),
  }) as z.ZodObject<Record<string, z.ZodString>>

  return tool({
    name: opts.name,
    description: opts.description,
    schema,
    execute: async (input, ctx) => {
      const task = (input as Record<string, string>)[inputKey] ?? ''

      const child = await createAgent({
        provider: opts.provider,
        cwd: ctx.cwd,
        executor: ctx.executor,
        logger: ctx.logger,
        systemPrompt: opts.systemPrompt,
        appendSystemPrompt: opts.appendSystemPrompt,
        tools: opts.tools,
        maxTurns: opts.maxTurns,
        pattern: opts.pattern,
      })

      // Propagate the parent's abort signal: cancelling the parent cancels
      // the child run in flight.
      const final = await child.run(task, { abortSignal: ctx.abortSignal })
      return extractText(final)
    },
  })
}

/** Concatenate the text blocks of the child's final assistant message. */
function extractText(message: Message): string {
  const text = message.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
  return text.length > 0 ? text : '(subagent produced no text output)'
}
