import { z } from 'zod'
import { tool } from '../define.js'

export const bashGetOutputTool = tool({
  name: 'bash_get_output',
  description:
    'Lee y drena el stdout/stderr acumulado de un proceso lanzado con `bash_spawn`. ' +
    'El buffer se vacía en cada lectura — llamadas sucesivas devuelven sólo lo nuevo. Reporta si el proceso sigue vivo.',
  schema: z.object({
    pid: z.string().min(1),
  }),
  execute: async ({ pid }, ctx) => {
    const status = await ctx.executor.getOutput(pid)
    const parts: string[] = []
    parts.push(`[pid=${status.pid} running=${status.running}`)
    if (!status.running) {
      parts.push(` exitCode=${status.exitCode ?? 'null'}`)
      if (status.signal) parts.push(` signal=${status.signal}`)
    }
    parts.push(']')
    const header = parts.join('')
    const body = (status.stdout || status.stderr)
      ? `\n--- stdout ---\n${status.stdout}\n--- stderr ---\n${status.stderr}`
      : '\n[sin output nuevo]'
    return header + body
  },
})
