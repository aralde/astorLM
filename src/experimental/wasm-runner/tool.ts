import { z } from 'zod'
import { tool } from '../../tools/define.js'
import type { Tool } from '../../types.js'
import type { CodeRunner } from '../../coderunner/types.js'

export interface CreateCodeRunnerToolOptions {
  /** The sandbox backend that evaluates the code (e.g. `QuickJsCodeRunner`). */
  runner: CodeRunner
  /** Tool name exposed to the model. Default `run_code`. */
  name?: string
  /** Tool description. A sensible default is derived from the runner language. */
  description?: string
}

/**
 * Wrap a `CodeRunner` as an agent `Tool`. The model passes source code; the
 * snippet runs in the WASM sandbox with no filesystem, network or host access,
 * and the captured stdout / return value / failure flags come back as the
 * `tool_result`.
 *
 * This tool is opt-in: it is not part of `createCodingTools()`. Register it
 * explicitly when you want the agent to evaluate code it generates without
 * touching the host.
 */
export function createCodeRunnerTool(opts: CreateCodeRunnerToolOptions): Tool {
  const { runner } = opts
  const name = opts.name ?? 'run_code'
  const description =
    opts.description ??
    `Evaluate a self-contained ${runner.language} snippet in a sandboxed WASM ` +
      `runtime with no filesystem, network or host access. Returns captured ` +
      `console output and the value of the last expression. Use it for pure ` +
      `computation, parsing or data transforms — not for shell commands.`

  return tool({
    name,
    description,
    schema: z.object({
      code: z.string().min(1).describe('Source code to evaluate in the sandbox.'),
    }),
    execute: async ({ code }, ctx) => {
      const result = await runner.run({ code, abortSignal: ctx.abortSignal })

      const parts: string[] = []
      if (result.stdout) parts.push(result.stdout.trimEnd())
      if (!result.ok && result.error) {
        parts.push(`[error] ${result.error}`)
      } else if (result.value !== undefined) {
        parts.push(`[result] ${result.value}`)
      }
      if (result.stderr) parts.push(`[stderr] ${result.stderr.trimEnd()}`)
      if (result.truncated) parts.push('[output truncated]')

      const body = parts.join('\n')
      return body.length > 0 ? body : '[no output]'
    },
  })
}
