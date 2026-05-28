import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { tool } from '../define.js'
import { resolveSafe } from '../../util/fs.js'

const SKIP = new Set(['node_modules', '.git', 'dist'])
const MAX_MATCHES = 200

async function walk(dir: string, out: string[]) {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue
    const full = path.join(dir, name)
    const st = await stat(full).catch(() => null)
    if (!st) continue
    if (st.isDirectory()) await walk(full, out)
    else out.push(full)
  }
}

export const grepTool = tool({
  name: 'grep',
  description:
    'Busca un patrón (regex) en archivos del cwd. Devuelve líneas con número de línea. Ignora node_modules/.git/dist.',
  schema: z.object({
    pattern: z.string(),
    path: z.string().optional().default('.'),
    caseInsensitive: z.boolean().optional().default(false),
  }),
  execute: async ({ pattern, path: p, caseInsensitive }, ctx) => {
    const base = resolveSafe(ctx.cwd, p)
    const files: string[] = []
    const st = await stat(base)
    if (st.isDirectory()) await walk(base, files)
    else files.push(base)

    const re = new RegExp(pattern, caseInsensitive ? 'i' : '')
    const results: string[] = []
    for (const f of files) {
      if (results.length >= MAX_MATCHES) break
      const raw = await readFile(f, 'utf8').catch(() => null)
      if (raw === null) continue
      const lines = raw.split(/\r?\n/)
      const rel = path.relative(ctx.cwd, f).split(path.sep).join('/')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line && re.test(line)) {
          results.push(`${rel}:${i + 1}:${line}`)
          if (results.length >= MAX_MATCHES) break
        }
      }
    }
    return results.length ? results.join('\n') : '(sin coincidencias)'
  },
})
