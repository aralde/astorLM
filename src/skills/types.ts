/**
 * Public types for the skills subsystem.
 *
 * A "skill" is a self-contained piece of instructions the agent can
 * consult on demand. It is pure data — markdown body plus metadata —
 * and lives in the agnostic core: the SDK ships no opinion about where
 * skills come from. A `SkillSource` is the seam: implementations can
 * read from the filesystem (see `astorlm/node`), from an HTTP registry,
 * from an in-memory list, etc.
 */

/**
 * Lightweight description of a skill. This is what the session lists
 * up-front so the model can decide whether to load the full body.
 *
 * `name` is the stable identifier used to invoke `load_skill`. It comes
 * from the skill's own frontmatter (single source of truth) — never
 * from a directory name or any external label.
 */
export interface SkillMetadata {
  name: string
  /**
   * Free-form trigger text. The model reads this in `<available-skills>`
   * to decide whether to call `load_skill`. Keep it concise and
   * action-oriented ("when the user asks to build a PowerPoint deck...").
   */
  description: string
  /**
   * Identifier of the `SkillSource` that produced this skill. Used for
   * diagnostics and to disambiguate skills with the same name across
   * sources (which today throws at `init()` — see SkillRegistry).
   */
  source: string
  /**
   * Absolute filesystem path of the skill's main file (typically
   * `<dir>/<name>/SKILL.md`). Present when the source can expose one
   * — used by `skillMode: 'filesystem'` so the agent reads the file
   * itself via the standard `read` tool. In-memory and remote sources
   * leave it undefined.
   */
  path?: string
  /**
   * Catch-all bag for frontmatter fields other than `name` and
   * `description`. Lets authors annotate skills with `version`,
   * `tags`, `license`, `allowed-tools`, etc. without the SDK needing
   * to know each one. All values are kept as strings exactly as they
   * came from the YAML frontmatter — no type coercion, no
   * interpretation. Consumers may read these to drive their own
   * policies (filtering, permission gating, etc.).
   */
  metadata?: Record<string, string>
}

/**
 * Full skill record including its markdown body. Returned by
 * `SkillSource.load(name)` and surfaced to the model via `load_skill`.
 */
export interface Skill extends SkillMetadata {
  /** Markdown content of the skill (everything after the YAML frontmatter). */
  body: string
}

/**
 * Abstraction over where skills come from. Implementations enumerate
 * their offerings via `list()` and provide the full body on demand
 * via `load(name)`. The split exists so remote sources can defer body
 * fetching until the model actually requests a specific skill.
 */
export interface SkillSource {
  /** Identifier used for diagnostics and as `SkillMetadata.source`. */
  readonly name: string
  /** Enumerate every skill this source offers. */
  list(): Promise<SkillMetadata[]>
  /** Load the full body of a specific skill. Resolves to `null` when not found. */
  load(name: string): Promise<Skill | null>
}

/**
 * Strategy for surfacing skills to the model.
 *
 * - `'all'`: every skill's body is concatenated into the system prompt
 *   at session start. Cheapest at runtime (no extra tool calls), but
 *   bloats the context with every turn. Use when you have a small,
 *   curated set of always-relevant skills.
 * - `'on-demand'`: only `{name, description}` go into the system prompt
 *   (as `<available-skills>`); the session also registers a `load_skill`
 *   meta-tool the model calls to materialise a body. Scales to many
 *   skills but requires the model to invoke a meta-tool — small models
 *   sometimes skip the meta step entirely.
 * - `'filesystem'`: the canonical Agent Skills spec pattern (Claude Code,
 *   Codex, Gemini CLI). The system prompt lists each skill's name,
 *   description and absolute filesystem path; the model reads the
 *   SKILL.md itself with the standard `read` tool when triggered. No
 *   meta-tool is registered. Requires every skill in the session to
 *   expose `path` — typically achieved with `createFileSystemSkillSource`.
 */
export type SkillMode = 'all' | 'on-demand' | 'filesystem'
