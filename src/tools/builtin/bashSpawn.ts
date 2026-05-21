import { z } from 'zod'
import { defineTool } from '../define.js'

export const bashSpawnTool = defineTool({
  name: 'bash_spawn',
  description:
    'Arranca un comando shell en background y devuelve un PID inmediatamente. ' +
    'Útil para servers, watchers o procesos largos. Usá `bash_get_output` para leer su stdout/stderr y `bash_kill` para terminarlo.',
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
