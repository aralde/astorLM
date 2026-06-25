import { z } from 'zod'
import { tool } from '../define.js'

export const bashSpawnTool = tool({
  name: 'bash_spawn',
  description:
    'Starts a shell command in the background and returns a PID immediately. ' +
    'Useful for servers, watchers or long-running processes. Use `bash_get_output` to read its stdout/stderr and `bash_kill` to terminate it.',
  schema: z.object({
    command: z.string().min(1),
    env: z.record(z.string()).optional(),
  }),
  execute: async ({ command, env }, ctx) => {
    const handle = await ctx.executor.spawn({
      command,
      cwd: ctx.cwd,
      env,
      abortSignal: ctx.abortSignal,
    })
    return `[spawned pid=${handle.pid}]`
  },
})
