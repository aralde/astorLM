import path from 'node:path'

/**
 * Resolves `target` relative to `cwd` and verifies the result stays inside
 * `cwd`. Acts as an anti-path-traversal guard for all filesystem tools.
 */
export function resolveSafe(cwd: string, target: string, allowOutsideCwd = false): string {
  const resolved = path.resolve(cwd, target)
  if (allowOutsideCwd) return resolved
  const rel = path.relative(cwd, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path "${target}" is outside the allowed cwd`)
  }
  return resolved
}
