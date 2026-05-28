import { z } from 'zod'
import { tool } from '../tools/define.js'
import type { Tool } from '../types.js'
import type { SkillRegistry } from './registry.js'

/**
 * Builds the `load_skill` meta-tool. The session auto-registers this
 * tool whenever there is at least one skill available and the session
 * is running in `skillMode: 'on-demand'`.
 *
 * Behaviour:
 *   - Successful loads return the skill body wrapped in
 *     `<skill name="..." source="...">...</skill>`, mirroring the
 *     XML-style context blocks the default system prompt teaches the
 *     model to read.
 *   - Unknown names throw — the loop reports the failure as a
 *     `tool_result` with `is_error: true` (no exception leaks). The
 *     error string includes the list of available names so the model
 *     can self-correct on the next turn.
 *
 * Note on persistence: the returned body lives in the tool_result, so
 * sessions persisted via `FileSessionManager` carry the loaded body
 * across resumes for free — no special handling needed.
 */
export function createLoadSkillTool(registry: SkillRegistry): Tool {
  return tool({
    name: 'load_skill',
    description:
      "Load a skill's full instructions by name. Skills are listed in " +
      "<available-skills> in the system prompt with a short description " +
      "each. Call this when a listed skill matches the current task. " +
      'The body is returned and becomes part of the conversation; do ' +
      'not call load_skill twice for the same name in a single session.',
    schema: z.object({
      name: z
        .string()
        .min(1)
        .describe('Exact skill name as listed in <available-skills>.'),
    }),
    execute: async ({ name }) => {
      const skill = await registry.load(name)
      if (!skill) {
        const available = registry
          .list()
          .map((s) => s.name)
          .join(', ')
        throw new Error(
          `Skill "${name}" not found. Available: ${available || '(none)'}`,
        )
      }
      return `<skill name="${skill.name}" source="${skill.source}">\n${skill.body}\n</skill>`
    },
  })
}
