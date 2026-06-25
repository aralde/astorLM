import { z } from 'zod'
import { tool } from '../define.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 200_000

export const bashTool = tool({
  name: 'bash',
  description:
    'Runs a shell command in a blocking manner in the agent cwd. Returns stdout and stderr combined with the exit code. For long-running processes (servers, watchers) use `bash_spawn`.',
  schema: z.object({
    command: z.string().min(1),
    timeoutMs: z.number().int().min(100).max(600_000).optional(),
  }),
  execute: async ({ command, timeoutMs = DEFAULT_TIMEOUT_MS }, ctx) => {
    const result = await ctx.executor.exec({
      command,
      cwd: ctx.cwd,
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      abortSignal: ctx.abortSignal,
    })

    // We keep the historical shape: stdout + stderr concatenated + truncated + exit code.
    const combined = result.stdout + result.stderr
    const truncated = result.truncated ? '\n[output truncated]\n' : ''
    const exitMeta =
      result.exitCode != null
        ? `\n[exit code: ${result.exitCode}]`
        : `\n[exit code: signal ${result.signal ?? 'unknown'}]`
    return combined + truncated + exitMeta
  },
})
