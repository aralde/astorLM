import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { defineTool } from '../define.js'
import { resolveSafe } from '../../util/fs.js'

export const lsTool = defineTool({
  name: 'ls',
  description: 'Lista archivos y directorios en una ruta (no recursivo).',
  schema: z.object({
    path: z.string().optional().default('.'),
  }),
  execute: async ({ path: p }, ctx) => {
    const abs = resolveSafe(ctx.cwd, p)
    const entries = await readdir(abs)
    const lines: string[] = []
    for (const name of entries.sort()) {
      const full = path.join(abs, name)
      const st = await stat(full).catch(() => null)
      if (!st) continue
      lines.push(st.isDirectory() ? `${name}/` : `${name}\t${st.size}b`)
    }
    return lines.join('\n') || '(vacío)'
  },
})
