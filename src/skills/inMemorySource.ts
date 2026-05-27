import type { Skill, SkillMetadata, SkillSource } from './types.js'
import { SkillValidationError, validateSkillSpec } from './validate.js'

export interface InMemorySkillSourceOptions {
  /** Identifier reported as `SkillMetadata.source`. Defaults to `'in-memory'`. */
  name?: string
  /**
   * The skills this source offers. `name`, `description` and `body`
   * are required; `metadata` (extra frontmatter-style fields like
   * `version`, `tags`, etc.) is optional and stored verbatim.
   */
  skills: Array<Pick<Skill, 'name' | 'description' | 'body'> & { metadata?: Record<string, string> }>
}

/**
 * Trivial `SkillSource` backed by an array passed at construction time.
 *
 * Useful in two situations:
 *   - Tests, where you want deterministic skills without hitting disk.
 *   - Hosts that already have skills materialised in memory (e.g. read
 *     from a database, an embedded resource, or a config file the host
 *     manages itself) and just want to expose them to the agent.
 */
export function createInMemorySkillSource(opts: InMemorySkillSourceOptions): SkillSource {
  const sourceName = opts.name ?? 'in-memory'
  const byName = new Map<string, Skill>()

  for (const s of opts.skills) {
    // Apply spec-level validation so in-memory skills hit the same
    // bar (charset, length, no reserved words, no XML in description)
    // as file-system ones — interop with the broader ecosystem.
    let validated: { name: string; description: string }
    try {
      validated = validateSkillSpec({ name: s.name, description: s.description })
    } catch (err) {
      if (err instanceof SkillValidationError) {
        throw new Error(
          `createInMemorySkillSource (source "${sourceName}"): ${err.message}`,
        )
      }
      throw err
    }
    if (byName.has(validated.name)) {
      throw new Error(
        `createInMemorySkillSource: duplicate skill name "${validated.name}" within the same source.`,
      )
    }
    const skill: Skill = {
      name: validated.name,
      description: validated.description,
      source: sourceName,
      body: s.body,
    }
    if (s.metadata && Object.keys(s.metadata).length > 0) {
      skill.metadata = { ...s.metadata }
    }
    byName.set(validated.name, skill)
  }

  return {
    name: sourceName,
    async list(): Promise<SkillMetadata[]> {
      return [...byName.values()].map((s) => {
        const meta: SkillMetadata = {
          name: s.name,
          description: s.description,
          source: sourceName,
        }
        // In-memory sources never expose a filesystem path; that field
        // stays undefined on purpose so 'filesystem' mode rejects them.
        if (s.metadata) meta.metadata = s.metadata
        return meta
      })
    },
    async load(name: string): Promise<Skill | null> {
      return byName.get(name) ?? null
    },
  }
}
