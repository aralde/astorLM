import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { tool } from '../define.js'
import { resolveSafe } from '../../util/fs.js'

export const readTool = tool({
  name: 'read',
  description:
    'Lee el contenido de un archivo de texto. Devuelve hasta `limit` líneas a partir de `offset` (1-indexed). Útil para inspeccionar código antes de editarlo.',
  schema: z.object({
    path: z.string().describe('Ruta relativa al cwd del agente'),
    offset: z.number().int().min(1).optional().describe('Línea inicial (1-indexed)'),
    limit: z.number().int().min(1).max(5000).optional().describe('Cantidad máxima de líneas'),
  }),
  execute: async ({ path: p, offset = 1, limit = 2000 }, ctx) => {
    const abs = resolveSafe(ctx.cwd, p)
    const raw = await readFile(abs, 'utf8')
    const lines = raw.split(/\r?\n/)
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    return slice.map((l, i) => `${offset + i}\t${l}`).join('\n')
  },
})
