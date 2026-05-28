import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { tool } from '../define.js'
import { resolveSafe } from '../../util/fs.js'

export const writeTool = tool({
  name: 'write',
  description:
    'Escribe (o sobreescribe) un archivo de texto. Crea directorios padre automáticamente.',
  schema: z.object({
    path: z.string(),
    content: z.string(),
  }),
  execute: async ({ path: p, content }, ctx) => {
    const abs = resolveSafe(ctx.cwd, p)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    return `Escribí ${content.length} bytes en ${p}`
  },
})
