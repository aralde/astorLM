import { spawn } from 'node:child_process'
import { z } from 'zod'
import { defineTool } from '../define.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 200_000

export const bashTool = defineTool({
  name: 'bash',
  description:
    'Ejecuta un comando shell en el cwd del agente. Devuelve stdout y stderr combinados. Timeout por defecto: 120s.',
  schema: z.object({
    command: z.string().min(1),
    timeoutMs: z.number().int().min(100).max(600_000).optional(),
  }),
  execute: async ({ command, timeoutMs = DEFAULT_TIMEOUT_MS }, ctx) => {
    return await new Promise<string>((resolve) => {
      // En Windows usamos cmd /c; en POSIX, sh -c. spawn() con shell:true delega esto.
      const child = spawn(command, {
        cwd: ctx.cwd,
        shell: true,
        signal: ctx.abortSignal,
      })

      let bytes = 0
      const chunks: string[] = []
      const append = (data: Buffer) => {
        const remaining = MAX_OUTPUT_BYTES - bytes
        if (remaining <= 0) return
        const slice = data.length > remaining ? data.subarray(0, remaining) : data
        bytes += slice.length
        chunks.push(slice.toString('utf8'))
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)

      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)

      child.on('close', (code, signal) => {
        clearTimeout(timer)
        const truncated = bytes >= MAX_OUTPUT_BYTES ? '\n[salida truncada]\n' : ''
        const meta = `\n[exit code: ${code ?? `signal ${signal}`}]`
        resolve(chunks.join('') + truncated + meta)
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve(`[error spawning: ${err.message}]`)
      })
    })
  },
})
