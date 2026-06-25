import { z } from 'zod'
import { tool } from '../define.js'

export const bashKillTool = tool({
  name: 'bash_kill',
  description:
    'Terminates a process started with `bash_spawn`. Default signal SIGTERM. No-op if the process already finished or the PID does not exist.',
  schema: z.object({
    pid: z.string().min(1),
    signal: z.string().optional(),
  }),
  execute: async ({ pid, signal }, ctx) => {
    await ctx.executor.kill(pid, signal)
    return `[killed pid=${pid} signal=${signal ?? 'SIGTERM'}]`
  },
})
