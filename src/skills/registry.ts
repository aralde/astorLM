import type { Skill, SkillMetadata, SkillSource } from './types.js'

/**
 * In-memory aggregator over one or more `SkillSource`s.
 *
 * Responsibilities:
 *   - Enumerate every source at `init()`, dedupe by `name`, and throw on
 *     conflict — there is no last-wins policy. Surfacing the conflict
 *     loudly is the right default; silent override is a footgun.
 *   - Cache loaded skill bodies after the first `load(name)` call, so a
 *     model that re-invokes `load_skill` for the same skill does not
 *     re-hit the source.
 *   - Expose a snapshot of every available skill's metadata (for
 *     rendering `<available-skills>` into the system prompt) and a
 *     pull-by-name API (for the `load_skill` tool).
 *
 * The registry is **not** automatically observed by the loop; it is the
 * session's responsibility to call `init()` before constructing the
 * system prompt and to feed the load tool a reference to this registry.
 */
export class SkillRegistry {
  private readonly sources: SkillSource[]
  private readonly metadata = new Map<string, SkillMetadata>()
  private readonly bodyCache = new Map<string, Skill>()
  private initialized = false

  constructor(sources: SkillSource[] = []) {
    this.sources = sources
  }

  /**
   * Enumerates every source and builds the metadata index. Must be
   * called exactly once before `list()` or `load()` are used. Calling
   * it again is a no-op.
   */
  async init(): Promise<void> {
    if (this.initialized) return

    // Track which source declared each name so we can produce a clear
    // error message on conflict (both source ids, not just the second).
    const claimedBy = new Map<string, string>()

    for (const source of this.sources) {
      const entries = await source.list()
      for (const entry of entries) {
        const prior = claimedBy.get(entry.name)
        if (prior !== undefined && prior !== source.name) {
          throw new Error(
            `Skill name conflict: "${entry.name}" is offered by both ` +
              `source "${prior}" and source "${source.name}". ` +
              `Rename one of them or drop a source.`,
          )
        }
        claimedBy.set(entry.name, source.name)
        // Force the `source` field to match the actual source name, not
        // whatever the implementation reported — keeps diagnostics honest.
        // Optional fields (path, metadata) are forwarded as-is so
        // consumers in 'filesystem' mode can locate the SKILL.md and
        // policy code can read tags / version / etc.
        const meta: SkillMetadata = {
          name: entry.name,
          description: entry.description,
          source: source.name,
        }
        if (entry.path) meta.path = entry.path
        if (entry.metadata) meta.metadata = entry.metadata
        this.metadata.set(entry.name, meta)
      }
    }

    this.initialized = true
  }

  /** Snapshot of every available skill's metadata, ordered by registration. */
  list(): SkillMetadata[] {
    this.assertInitialized()
    return [...this.metadata.values()]
  }

  /** Number of available skills. */
  get size(): number {
    this.assertInitialized()
    return this.metadata.size
  }

  /** True if a skill with this name exists in the registry. */
  has(name: string): boolean {
    this.assertInitialized()
    return this.metadata.has(name)
  }

  /**
   * Loads the full body of a skill by name. Results are cached: a
   * second call for the same name returns the same instance without
   * touching the source again.
   *
   * Returns `null` when no skill with this name exists. Propagates any
   * error thrown by the underlying source (network failure, parse
   * error, etc.) — the caller decides how to surface it to the model.
   */
  async load(name: string): Promise<Skill | null> {
    this.assertInitialized()
    const cached = this.bodyCache.get(name)
    if (cached) return cached

    const meta = this.metadata.get(name)
    if (!meta) return null

    const source = this.sources.find((s) => s.name === meta.source)
    if (!source) {
      // Defensive: metadata index drifted from sources array. Should never
      // happen because we set `source` from the source itself at init().
      throw new Error(
        `Internal error: skill "${name}" references unknown source "${meta.source}"`,
      )
    }

    const loaded = await source.load(name)
    if (!loaded) return null

    // Stamp metadata fields from the registry index to keep `source`
    // consistent even if the source's load() reports something else.
    // `path` and the extra `metadata` bag come from list() (already
    // indexed) — list() is the source of truth for those, load() just
    // brings the body.
    const skill: Skill = {
      name: meta.name,
      description: meta.description,
      source: meta.source,
      body: loaded.body,
    }
    if (meta.path) skill.path = meta.path
    if (meta.metadata) skill.metadata = meta.metadata
    this.bodyCache.set(name, skill)
    return skill
  }

  /**
   * Loads every skill at once. Used by sessions running in
   * `skillMode: 'all'` to materialise the full bodies for the system
   * prompt. Resolves to the array in `list()` order.
   */
  async loadAll(): Promise<Skill[]> {
    this.assertInitialized()
    const out: Skill[] = []
    for (const meta of this.metadata.values()) {
      const skill = await this.load(meta.name)
      if (skill) out.push(skill)
    }
    return out
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error('SkillRegistry: call init() before use.')
    }
  }
}
