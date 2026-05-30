import type { SessionHooks } from '../types.js'
import type { Skill, SkillMetadata } from './types.js'

/**
 * Parse the `allowed-tools` frontmatter field of a skill into a list of tool
 * names. The Agent Skills spec carries this as a comma-separated string; the
 * SDK stores it verbatim in `metadata` without interpreting it. This helper
 * is the interpretation step.
 *
 * Returns `null` when the field is absent or empty — meaning "no restriction
 * declared", which a caller should treat differently from an empty allowlist
 * (which would deny everything).
 */
export function parseAllowedTools(
  skill: Pick<Skill, 'metadata'> | SkillMetadata,
): string[] | null {
  const raw = skill.metadata?.['allowed-tools']
  if (!raw) return null
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return list.length > 0 ? list : null
}

/**
 * Options for {@link restrictToolsHook}.
 */
export interface RestrictToolsOptions {
  /**
   * Tools always permitted regardless of the allowlist. Useful for tools the
   * agent needs to keep functioning — e.g. `read` (so it can still consult a
   * 'filesystem'-mode SKILL.md) or `load_skill`.
   */
  alwaysAllow?: string[]
  /** Builds the message handed back to the model when a tool is denied. */
  denyMessage?: (toolName: string) => string
}

/**
 * Build a {@link SessionHooks} object that denies any tool not in `allowed`
 * (plus `alwaysAllow`). It reuses the loop's existing authorization path
 * (`beforeToolExecution` returning `authorize: false`), so no loop change is
 * needed — denied tools never run and the model receives an explanatory
 * `tool_result`.
 *
 * Deciding *which* skill is active (and therefore which allowlist applies) is
 * left to the consumer: combine `parseAllowedTools(skill)` with this builder
 * and merge it into your session hooks, the same pattern used by
 * `errorRegistryHooks`. The SDK deliberately does not track an "active skill"
 * in the core.
 */
export function restrictToolsHook(
  allowed: string[],
  opts: RestrictToolsOptions = {},
): SessionHooks {
  const allowSet = new Set([...allowed, ...(opts.alwaysAllow ?? [])])
  return {
    beforeToolExecution: async ({ toolName }) => {
      if (allowSet.has(toolName)) return { authorize: true }
      return {
        authorize: false,
        mockResult:
          opts.denyMessage?.(toolName) ??
          `Tool "${toolName}" is not in the active skill's allowed-tools list.`,
      }
    },
  }
}
