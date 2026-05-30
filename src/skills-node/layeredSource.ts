import { createFileSystemSkillSource } from './fileSystemSource.js'
import type { Skill, SkillMetadata, SkillSource } from '../skills/types.js'

/**
 * Options for {@link createLayeredSkillSource}.
 */
export interface LayeredSkillSourceOptions {
  /**
   * Skill directories ordered from LOWEST to HIGHEST precedence. The
   * canonical convention is `[userDir, projectDir, repoDir]` — a skill
   * defined closer to the project (later in the array) overrides one with
   * the same name defined more globally (earlier).
   */
  layers: string[]
  /**
   * Identifier reported as `SkillMetadata.source`. Defaults to `'layered'`.
   * Because the layered source presents itself as a SINGLE source, the
   * `SkillRegistry` never sees the per-layer duplicates — its
   * conflict-throws-on-duplicate policy stays intact for genuinely
   * ambiguous configs.
   */
  name?: string
  /**
   * Called whenever a higher-precedence layer shadows a same-named skill
   * from a lower one. Override is intentional here (that is the point of
   * layering), but surfacing it keeps the resolution observable instead of
   * silent.
   */
  onOverride?: (info: { name: string; winner: string; loser: string }) => void
}

/**
 * A `SkillSource` that resolves hierarchical skill discovery
 * (user → project → repo) internally and presents the merged result as one
 * source.
 *
 * Passing several `createFileSystemSkillSource` directly in `skillSources`
 * makes the `SkillRegistry` throw on any duplicate name. That is correct for
 * accidental clashes but wrong for the intended override pattern, where a
 * project-level skill is *meant* to shadow a user-level one. This helper
 * applies last-wins precedence across the layers (loudly, via `onOverride`)
 * and hides the duplicates from the registry behind a single source name.
 */
export function createLayeredSkillSource(
  opts: LayeredSkillSourceOptions,
): SkillSource {
  const sourceName = opts.name ?? 'layered'
  // One FS source per layer, kept in precedence order (later = higher).
  const layers = opts.layers.map((dir) => createFileSystemSkillSource({ dir }))

  return {
    name: sourceName,
    async list(): Promise<SkillMetadata[]> {
      // Insertion order preserved; later layers overwrite earlier entries.
      const winners = new Map<string, { meta: SkillMetadata; layerName: string }>()
      for (const layer of layers) {
        const entries = await layer.list()
        for (const entry of entries) {
          const prior = winners.get(entry.name)
          if (prior) {
            opts.onOverride?.({
              name: entry.name,
              winner: layer.name,
              loser: prior.layerName,
            })
          }
          // Re-stamp `source` to this layered source so the registry treats
          // every skill as coming from one place. `path` and `metadata` are
          // forwarded so 'filesystem' mode and policy code keep working.
          winners.set(entry.name, {
            meta: { ...entry, source: sourceName },
            layerName: layer.name,
          })
        }
      }
      return [...winners.values()].map((w) => w.meta)
    },
    async load(name: string): Promise<Skill | null> {
      // Probe from highest to lowest precedence and return the first hit, so
      // the body matches the winner reported by list().
      for (let i = layers.length - 1; i >= 0; i--) {
        const skill = await layers[i]!.load(name)
        if (skill) return { ...skill, source: sourceName }
      }
      return null
    },
  }
}
