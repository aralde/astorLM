import { compilePrompts } from './compiler.js'
import type { PromptCompilerOptions } from './types.js'

const DEFAULT_SYSTEM_PROMPT = `You are an embedded coding agent. You work inside a given cwd.
- Use the tools to inspect and modify the filesystem; do not invent file contents.
- Before editing a file, read it if you haven't seen it before.
- If a tool fails, read the error and adjust the approach; do not repeat the same call.
- Respond in the user's language. Be concise.`

export interface BuildSystemPromptOptions {
  cwd: string
  /** Full replacement of the default prompt. */
  systemPrompt?: string
  /** Options for the modular prompt compiler (if provided, they compile the base prompt). */
  promptCompiler?: PromptCompilerOptions
  /** Extra text concatenated at the end of the prompt (default or custom). */
  appendSystemPrompt?: string
  /** Context files to load from cwd. Defaults to AGENTS.md and CLAUDE.md. */
  contextFiles?: string[]
  /** Async file loader to read context files. */
  fileReader?: (path: string) => Promise<string | null>
  /**
   * Pre-rendered skills block (output of `renderSkillsBlock`). Inserted
   * after context files and before `appendSystemPrompt`. Pass an empty
   * string (or omit) to skip — this function does not know about the
   * skills subsystem, it just concatenates the block at the right spot.
   */
  skillsBlock?: string
}

export async function buildSystemPrompt(opts: BuildSystemPromptOptions): Promise<string> {
  let basePrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  if (opts.promptCompiler) {
    const { systemPrompt: compiled } = compilePrompts(opts.promptCompiler)
    basePrompt = compiled
  }

  const parts: string[] = [basePrompt]
  parts.push(`\n\n<cwd>${opts.cwd}</cwd>`)

  const files = opts.contextFiles ?? ['AGENTS.md', 'CLAUDE.md']
  if (opts.fileReader) {
    for (const f of files) {
      const content = await opts.fileReader(f).catch(() => null)
      if (content) {
        parts.push(`\n\n<context file="${f}">\n${content}\n</context>`)
      }
    }
  }

  if (opts.skillsBlock) parts.push(opts.skillsBlock)

  if (opts.appendSystemPrompt) parts.push(`\n\n${opts.appendSystemPrompt}`)

  return parts.join('')
}

export { DEFAULT_SYSTEM_PROMPT }

