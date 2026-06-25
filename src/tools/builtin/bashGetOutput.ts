import { z } from 'zod'
import { tool } from '../define.js'

export const bashGetOutputTool = tool({
  name: 'bash_get_output',
  description:
    'Reads and drains the accumulated stdout/stderr of a process started with `bash_spawn`. ' +
    'The buffer is emptied on each read — successive calls return only what is new. Reports whether the process is still alive.',
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
      : '\n[no new output]'
    return header + body
  },
})
