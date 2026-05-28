import { z } from 'zod'
import { tool } from '../define.js'

export const bashKillTool = tool({
  name: 'bash_kill',
  description:
    'Termina un proceso lanzado con `bash_spawn`. Default señal SIGTERM. No-op si el proceso ya terminó o el PID no existe.',
  schema: z.object({
    pid: z.string().min(1),
    signal: z.string().optional(),
  }),
  execute: async ({ pid, signal }, ctx) => {
    await ctx.executor.kill(pid, signal)
    return `[killed pid=${pid} signal=${signal ?? 'SIGTERM'}]`
  },
})
