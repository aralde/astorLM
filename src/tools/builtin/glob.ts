import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { defineTool } from '../define.js'
import { resolveSafe } from '../../util/fs.js'

/** Convierte un patrón glob simple a RegExp. Soporta `*`, `**`, `?`. */
function globToRegex(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i++
        if (pattern[i + 1] === '/') i++
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if (c && '.+^$(){}[]|\\'.includes(c)) {
      out += `\\${c}`
    } else {
      out += c
    }
  }
  out += '$'
  return new RegExp(out)
}

async function walk(dir: string, base: string, out: string[], skip: Set<string>) {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (skip.has(name)) continue
    const full = path.join(dir, name)
    const rel = path.relative(base, full).split(path.sep).join('/')
    const st = await import('node:fs/promises').then((m) => m.stat(full).catch(() => null))
    if (!st) continue
    if (st.isDirectory()) {
      await walk(full, base, out, skip)
    } else {
      out.push(rel)
    }
  }
}

export const globTool = defineTool({
  name: 'glob',
  description:
    'Busca archivos por patrón glob (soporta `*`, `**`, `?`). Ignora node_modules, .git y dist por defecto.',
  schema: z.object({
    pattern: z.string(),
  }),
  execute: async ({ pattern }, ctx) => {
    const base = resolveSafe(ctx.cwd, '.')
    const files: string[] = []
    await walk(base, base, files, new Set(['node_modules', '.git', 'dist']))
    const re = globToRegex(pattern)
    const matches = files.filter((f) => re.test(f)).sort()
    return matches.length ? matches.join('\n') : '(sin coincidencias)'
  },
})
