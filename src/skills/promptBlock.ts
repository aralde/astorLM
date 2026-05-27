import type { Skill, SkillMetadata, SkillMode } from './types.js'

/**
 * Renders the system-prompt block that exposes skills to the model.
 *
 * - `mode: 'on-demand'` — expects `SkillMetadata[]`. Emits an
 *   `<available-skills>` block listing each skill's name + description
 *   plus a short instruction to invoke `load_skill` when relevant.
 * - `mode: 'all'` — expects fully loaded `Skill[]` (bodies present).
 *   Emits one `<skill name="...">` block per skill, body inlined.
 * - `mode: 'filesystem'` — expects `SkillMetadata[]`, each with an
 *   absolute `path`. Emits an `<available-skills>` block telling the
 *   model to read SKILL.md with the standard `read` tool when triggered.
 *
 * Returns an empty string when there are no skills, so the caller can
 * unconditionally concatenate the result.
 */
export function renderSkillsBlock(
  skills: SkillMetadata[] | Skill[],
  mode: SkillMode,
): string {
  if (skills.length === 0) return ''

  if (mode === 'filesystem') {
    // Mirror the canonical Agent Skills pattern: name, description,
    // absolute filesystem path. The agent uses its existing `read` tool
    // to fetch SKILL.md on demand — no meta-tool involved. This sidesteps
    // the "model won't invoke load_skill" problem that small models hit
    // and lines astorlm up with Claude Code / Codex / Gemini CLI.
    const entries = skills
      .map((s) => {
        if (!s.path) {
          throw new Error(
            `renderSkillsBlock(filesystem): skill "${s.name}" is missing a path. ` +
              `Only sources that expose filesystem paths (createFileSystemSkillSource) ` +
              `are usable in this mode.`,
          )
        }
        // Normalise Windows backslashes to forward slashes when rendering.
        // Node accepts forward slashes on Windows too, and it keeps the
        // JSON the model emits in its tool call free of heavy escaping
        // (which has been seen to confuse some local models like Llama 4
        // Scout into emitting malformed `<function=...>` syntax).
        const display = s.path.replace(/\\/g, '/')
        return `- \`${s.name}\` — ${s.description}\n  read this file: ${display}`
      })
      .join('\n')
    return (
      `\n\n<available-skills>\n` +
      `The following skills live on the filesystem. When the user's task ` +
      `matches one, read the corresponding SKILL.md using the \`read\` tool ` +
      `(passing the path shown below) BEFORE producing your answer, then ` +
      `follow the instructions in the body. Each SKILL.md may reference ` +
      `additional files in the same folder (FORMS.md, scripts/, etc.) — ` +
      `read those with \`read\` and execute scripts with \`bash\` as needed. ` +
      `Do not re-read the same SKILL.md twice in the same conversation.\n\n` +
      `${entries}\n` +
      `</available-skills>`
    )
  }

  if (mode === 'on-demand') {
    // Render entries as plain markdown bullets with the skill name in
    // backticks. The previous YAML-ish format (`name: foo\n  description: ...`)
    // primed Llama-family models to leak the literal `name:` prefix into
    // the function name when emitting native tool-call syntax
    // (`<function=name: foo>...`), which the provider then rejected with
    // `tool_use_failed`. Backticks + em-dash sidestep that ambiguity and
    // read as natural prose to other models.
    const entries = skills.map((s) => `- \`${s.name}\` — ${s.description}`).join('\n')
    return (
      `\n\n<available-skills>\n` +
      `The following skills are available. When the user's task matches one, ` +
      `call the \`load_skill\` tool, passing the skill's name (exactly the ` +
      `string shown in backticks below — do NOT include "name:" or any other ` +
      `prefix) as the \`name\` argument. The full instructions will be ` +
      `returned and stay in the conversation; do not call \`load_skill\` ` +
      `more than once for the same skill.\n\n` +
      `${entries}\n` +
      `</available-skills>`
    )
  }

  // mode === 'all' — every entry must carry its body.
  const blocks = (skills as Skill[])
    .map(
      (s) =>
        `<skill name="${s.name}" source="${s.source}">\n${s.body}\n</skill>`,
    )
    .join('\n\n')
  return `\n\n${blocks}`
}
