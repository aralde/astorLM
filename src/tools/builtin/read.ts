import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { tool } from '../define.js'
import { resolveSafe } from '../../util/fs.js'

export const readTool = tool({
  name: 'read',
  description:
    'Reads the contents of a text file. Returns up to `limit` lines starting from `offset` (1-indexed). Useful for inspecting code before editing it.',
  schema: z.object({
    path: z.string().describe('Path relative to the agent cwd'),
    offset: z.number().int().min(1).optional().describe('Starting line (1-indexed)'),
    limit: z.number().int().min(1).max(5000).optional().describe('Maximum number of lines'),
  }),
  execute: async ({ path: p, offset = 1, limit = 2000 }, ctx) => {
    const abs = resolveSafe(ctx.cwd, p)
    const raw = await readFile(abs, 'utf8')
    const lines = raw.split(/\r?\n/)
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    return slice.map((l, i) => `${offset + i}\t${l}`).join('\n')
  },
})
