import type { Message, SessionHooks } from '../../types.js'
import type { ResolvedSynthesis } from './types.js'

/**
 * Counts tool rounds within the CURRENT user request. The boundary is the last
 * user message with a non-empty text block AND no tool_result block (the actual
 * user prompt — the same convention the core optimizer uses); tool-result
 * messages carry both tool_result and, after steering, text blocks, so requiring
 * "no tool_result" correctly excludes them. Rounds = assistant messages with a
 * tool_use after that boundary.
 */
function countCurrentRounds(messages: Message[]): number {
  let boundary = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    const hasUserText = m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text.trim().length > 0)
    const hasToolResult = m.content.some((b) => b.type === 'tool_result')
    if (hasUserText && !hasToolResult) {
      boundary = i
      break
    }
  }
  let rounds = 0
  for (let i = boundary + 1; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use')) rounds++
  }
  return rounds
}

/**
 * Builds a `beforeProviderCall` fragment that forces synthesis once the current
 * request has accumulated enough tool rounds: it appends a short instruction to
 * the system prompt and either sets `toolChoice: 'none'` (default) or strips the
 * tools, so a weak model stops calling tools and answers.
 */
export function buildSynthesisHook(
  options: ResolvedSynthesis,
): NonNullable<SessionHooks['beforeProviderCall']> {
  return async ({ messages, systemPrompt, tools }) => {
    if (options.forceAfterToolRounds <= 0) {
      return { messages, systemPrompt, tools }
    }
    const rounds = countCurrentRounds(messages)
    if (rounds < options.forceAfterToolRounds) {
      return { messages, systemPrompt, tools }
    }
    const augmented = `${systemPrompt}\n\n[Synthesis required] ${options.instruction}`
    if (options.mechanism === 'strip-tools') {
      return { messages, systemPrompt: augmented, tools: [] }
    }
    return { messages, systemPrompt: augmented, tools, toolChoice: 'none' }
  }
}
