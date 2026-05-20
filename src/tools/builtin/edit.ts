import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { defineTool } from '../define.js'
import { resolveSafe } from '../../util/fs.js'

export const editTool = defineTool({
  name: 'edit',
  description:
    'Reemplaza una ocurrencia exacta de `oldString` por `newString` en el archivo indicado. `oldString` debe ser único (al menos por defecto). Útil para ediciones quirúrgicas sin reescribir el archivo entero.',
  schema: z.object({
    path: z.string(),
    oldString: z.string().min(1),
    newString: z.string(),
    replaceAll: z.boolean().optional().default(false),
  }),
  execute: async ({ path: p, oldString, newString, replaceAll }, ctx) => {
    const abs = resolveSafe(ctx.cwd, p)
    const raw = await readFile(abs, 'utf8')
    if (!raw.includes(oldString)) {
      throw new Error(`No se encontró "oldString" en ${p}`)
    }
    let next: string
    if (replaceAll) {
      next = raw.split(oldString).join(newString)
    } else {
      const first = raw.indexOf(oldString)
      const second = raw.indexOf(oldString, first + 1)
      if (second !== -1) {
        throw new Error(
          `"oldString" no es único en ${p} (aparece ≥2 veces). Ampliá el contexto o usá replaceAll.`,
        )
      }
      next = raw.slice(0, first) + newString + raw.slice(first + oldString.length)
    }
    await writeFile(abs, next, 'utf8')
    return `Edité ${p}`
  },
})
