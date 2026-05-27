import fs from 'node:fs/promises'
import path from 'node:path'
import { parseSkillFrontmatter } from '../skills/parseFrontmatter.js'
import { SkillValidationError, validateSkillSpec } from '../skills/validate.js'
import type { Skill, SkillMetadata, SkillSource } from '../skills/types.js'

/**
 * Node-only `SkillSource` that reads skills from disk.
 *
 * Convention (mirrors Claude Code, Goose, and others): one directory
 * per skill, each containing a `SKILL.md` whose YAML frontmatter
 * carries at minimum `name` and `description`. The skill's identifier
 * comes from the **frontmatter**, never from the directory name — that
 * way renames don't double-track.
 *
 * ```
 *   <dir>/
 *     pptx/
 *       SKILL.md
 *     refactor/
 *       SKILL.md
 *       (future: scripts/, assets/)
 * ```
 *
 * Behaviour:
 *   - `list()` and `load(name)` each scan the directory on demand. The
 *     SkillRegistry caches loaded bodies, so repeat loads do not re-hit
 *     disk within a session.
 *   - Skills missing `name` or `description` in their frontmatter are
 *     reported via a thrown error from `list()` — silent skipping would
 *     hide misconfigured skills.
 *   - Hidden directories (starting with `.`) are skipped.
 */

export interface FileSystemSkillSourceOptions {
  /** Absolute or relative path to the directory containing skill folders. */
  dir: string
  /**
   * Identifier reported as `SkillMetadata.source`. Defaults to
   * `fs:<basename>` so multiple FS sources at different paths can
   * coexist in the same session.
   */
  name?: string
}

export function createFileSystemSkillSource(
  opts: FileSystemSkillSourceOptions,
): SkillSource {
  const dir = path.resolve(opts.dir)
  const sourceName = opts.name ?? `fs:${path.basename(dir)}`

  async function readSkillFile(name: string): Promise<Skill | null> {
    const file = path.join(dir, name, 'SKILL.md')
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw err
    }
    const { meta, body, hasFrontmatter } = parseSkillFrontmatter(raw)
    if (!hasFrontmatter) {
      throw new Error(
        `Skill at ${file} is missing the YAML frontmatter block (---).`,
      )
    }
    if (!meta.name) {
      throw new Error(`Skill at ${file} is missing the required "name" field.`)
    }
    if (!meta.description) {
      throw new Error(
        `Skill at ${file} is missing the required "description" field.`,
      )
    }

    // Spec-level validation (charset, length, reserved words, no XML in
    // description). We wrap the raw error so the file path is part of
    // the message — otherwise debugging a malformed SKILL.md is painful.
    let validated: { name: string; description: string }
    try {
      validated = validateSkillSpec({ name: meta.name, description: meta.description })
    } catch (err) {
      if (err instanceof SkillValidationError) {
        throw new Error(`Skill at ${file} has an invalid ${err.field}: ${err.message}`)
      }
      throw err
    }

    if (validated.name !== name) {
      // Allow folder name and frontmatter name to diverge, but warn loudly
      // by throwing — accidental drift is almost always a bug.
      throw new Error(
        `Skill at ${file} declares name "${validated.name}" but lives in ` +
          `folder "${name}". Rename one of them so they match.`,
      )
    }

    // Everything that isn't `name`/`description` becomes metadata so
    // the consumer can read `version`, `tags`, `allowed-tools`, etc.
    // without us having to know about each field up front.
    const extraMetadata: Record<string, string> = {}
    for (const [k, v] of Object.entries(meta)) {
      if (k === 'name' || k === 'description') continue
      extraMetadata[k] = v
    }

    const skill: Skill = {
      name: validated.name,
      description: validated.description,
      body,
      source: sourceName,
      path: file,
    }
    if (Object.keys(extraMetadata).length > 0) skill.metadata = extraMetadata
    return skill
  }

  async function listFolderNames(): Promise<string[]> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return []
      throw err
    }
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  }

  return {
    name: sourceName,
    async list(): Promise<SkillMetadata[]> {
      const folders = await listFolderNames()
      const out: SkillMetadata[] = []
      for (const folder of folders) {
        const skill = await readSkillFile(folder)
        if (skill) {
          const meta: SkillMetadata = {
            name: skill.name,
            description: skill.description,
            source: sourceName,
            path: skill.path,
          }
          if (skill.metadata) meta.metadata = skill.metadata
          out.push(meta)
        }
      }
      return out
    },
    async load(name: string): Promise<Skill | null> {
      // Probe the folder directly; avoids reading every other skill.
      return readSkillFile(name)
    },
  }
}
