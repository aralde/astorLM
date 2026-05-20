import path from 'node:path'

/**
 * Resuelve `target` relativo a `cwd` y verifica que el resultado siga
 * estando dentro de `cwd`. Sirve como guardia anti path-traversal para
 * todas las tools de filesystem.
 */
export function resolveSafe(cwd: string, target: string, allowOutsideCwd = false): string {
  const resolved = path.resolve(cwd, target)
  if (allowOutsideCwd) return resolved
  const rel = path.relative(cwd, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path "${target}" está fuera del cwd permitido`)
  }
  return resolved
}
