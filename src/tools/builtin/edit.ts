import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { tool } from '../define.js'
import { resolveSafe } from '../../util/fs.js'

export const editTool = tool({
  name: 'edit',
  description:
    'Replaces an exact occurrence of `oldString` with `newString` in the given file. `oldString` must be unique (at least by default). Useful for surgical edits without rewriting the whole file.',
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
      throw new Error(`"oldString" not found in ${p}`)
    }
    let next: string
    if (replaceAll) {
      next = raw.split(oldString).join(newString)
    } else {
      const first = raw.indexOf(oldString)
      const second = raw.indexOf(oldString, first + 1)
      if (second !== -1) {
        throw new Error(
          `"oldString" is not unique in ${p} (appears ≥2 times). Widen the context or use replaceAll.`,
        )
      }
      next = raw.slice(0, first) + newString + raw.slice(first + oldString.length)
    }
    await writeFile(abs, next, 'utf8')
    return `Edited ${p}`
  },
})
