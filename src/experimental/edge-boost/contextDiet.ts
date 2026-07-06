import type { Message, SessionHooks } from '../../types.js'
import type { ResolvedContextDiet } from './types.js'

const EDGE_BOOST_MARKER = '[edge-boost: truncated'

/**
 * True when a tool_result content was already compacted by ANY layer, so the
 * diet must leave it alone (idempotence + coexistence with the core optimizer).
 * The optimizer replaces content with `[Tool '<name>' execution result
 * truncated ...]` (a full replacement starting with `[Tool`); the diet appends
 * `[edge-boost: truncated N chars]` as a suffix.
 */
function alreadyCompacted(content: string): boolean {
  if (content.includes(EDGE_BOOST_MARKER)) return true
  if (content.startsWith('[Tool') && content.includes('result truncated')) return true
  return false
}

/**
 * Builds a `beforeProviderCall` fragment that trims old `tool_result` blocks and
 * optionally swaps in a compact system prompt — a per-call context diet for weak
 * models. It NEVER mutates the incoming history: only messages whose blocks
 * actually change are deep-copied (the loop passes the live history objects).
 */
export function buildContextDietHook(
  options: ResolvedContextDiet,
): NonNullable<SessionHooks['beforeProviderCall']> {
  return async ({ messages, systemPrompt, tools }) => {
    const outSystemPrompt = options.compactSystemPrompt ?? systemPrompt

    if (options.toolResultMaxChars <= 0) {
      return { messages, systemPrompt: outSystemPrompt, tools }
    }

    // Indices of user messages that carry tool_result blocks (≈ one per round).
    const resultIdx: number[] = []
    messages.forEach((m, i) => {
      if (m.role === 'user' && m.content.some((b) => b.type === 'tool_result')) resultIdx.push(i)
    })

    const keep = Math.max(0, options.keepRecentToolRounds)
    const protectedSet = new Set(resultIdx.slice(resultIdx.length - keep))

    let out: Message[] | null = null // copy-on-write
    for (const i of resultIdx) {
      if (protectedSet.has(i)) continue
      const src = messages[i]!
      let changed = false
      const newContent = src.content.map((b) => {
        if (
          b.type === 'tool_result' &&
          b.content.length > options.toolResultMaxChars &&
          !alreadyCompacted(b.content)
        ) {
          changed = true
          const kept = b.content.slice(0, options.toolResultMaxChars)
          const removed = b.content.length - kept.length
          return { ...b, content: `${kept}\n${EDGE_BOOST_MARKER} ${removed} chars]` }
        }
        return b
      })
      if (changed) {
        if (!out) out = messages.slice()
        out[i] = { ...src, content: newContent }
      }
    }

    return { messages: out ?? messages, systemPrompt: outSystemPrompt, tools }
  }
}
