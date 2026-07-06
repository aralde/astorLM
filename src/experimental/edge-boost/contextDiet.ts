import type { ContentBlock, Message, Provider, SessionHooks } from '../../types.js'
import type { ResolvedContextDiet } from './types.js'

const EDGE_BOOST_MARKER = '[edge-boost: truncated'
const EDGE_BOOST_DIGEST = '[edge-boost: digest]'
const DIGEST_TIMEOUT_MS = 10_000

/**
 * True when a tool_result content was already compacted by ANY layer, so the
 * diet must leave it alone (idempotence + coexistence with the core optimizer).
 * The optimizer replaces content with `[Tool '<name>' execution result
 * truncated ...]` (a full replacement starting with `[Tool`); the diet appends
 * `[edge-boost: truncated N chars]` as a suffix or prefixes a digest.
 */
function alreadyCompacted(content: string): boolean {
  if (content.includes(EDGE_BOOST_MARKER)) return true
  if (content.startsWith(EDGE_BOOST_DIGEST)) return true
  if (content.startsWith('[Tool') && content.includes('result truncated')) return true
  return false
}

function truncate(content: string, max: number): string {
  const kept = content.slice(0, max)
  const removed = content.length - kept.length
  return `${kept}\n${EDGE_BOOST_MARKER} ${removed} chars]`
}

const DIGEST_SYSTEM =
  'You compress tool output. Summarize the user message (a tool result) into a ' +
  'short digest that keeps only the facts useful to continue the task. Output ' +
  'ONLY the summary, no preamble.'

/**
 * Summarizes a tool_result with a cheap provider. Returns the summary, or `null`
 * on any failure or a {@link DIGEST_TIMEOUT_MS} timeout (caller falls back to
 * structural truncation).
 */
async function summarize(provider: Provider, content: string, maxChars: number): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DIGEST_TIMEOUT_MS)
  try {
    let text = ''
    for await (const ev of provider.stream({
      systemPrompt: DIGEST_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: content }] }],
      tools: [],
      abortSignal: ctrl.signal,
      maxTokens: 200,
    })) {
      if (ev.type === 'text_delta') text += ev.text
    }
    const trimmed = text.trim()
    if (!trimmed) return null
    const capped = trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed
    return `${EDGE_BOOST_DIGEST} ${capped}`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Builds a `beforeProviderCall` fragment that trims old `tool_result` blocks and
 * optionally swaps in a compact system prompt — a per-call context diet for weak
 * models. It NEVER mutates the incoming history: only messages whose blocks
 * actually change are deep-copied (the loop passes the live history objects).
 *
 * When `digest` is configured, an evicted block is summarized by the injected
 * provider instead of truncated; each block is summarized at most once (cached
 * by message id + block index), and any failure/timeout falls back to
 * structural truncation.
 */
export function buildContextDietHook(
  options: ResolvedContextDiet,
): NonNullable<SessionHooks['beforeProviderCall']> {
  // Per-hook-instance digest cache: `${messageId}#${blockIndex}` → digest.
  const digestCache = new Map<string, string>()
  let warnedDigest = false

  return async ({ messages, systemPrompt, tools }) => {
    const outSystemPrompt = options.compactSystemPrompt ?? systemPrompt

    if (options.toolResultMaxChars <= 0) {
      return { messages, systemPrompt: outSystemPrompt, tools }
    }

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
      const newContent: ContentBlock[] = []
      for (let bi = 0; bi < src.content.length; bi++) {
        const b = src.content[bi]!
        if (
          b.type === 'tool_result' &&
          b.content.length > options.toolResultMaxChars &&
          !alreadyCompacted(b.content)
        ) {
          changed = true
          let replacement: string | null = null
          if (options.digest) {
            const cacheKey = `${src.id ?? `idx${i}`}#${bi}`
            const cached = digestCache.get(cacheKey)
            if (cached !== undefined) {
              replacement = cached
            } else {
              const summary = await summarize(options.digest.provider, b.content, options.digest.maxChars)
              if (summary) {
                digestCache.set(cacheKey, summary)
                replacement = summary
              } else if (!warnedDigest) {
                warnedDigest = true
                // eslint-disable-next-line no-console
                console.warn('[edge-boost] tool-result digest failed; falling back to truncation.')
              }
            }
          }
          newContent.push({ ...b, content: replacement ?? truncate(b.content, options.toolResultMaxChars) })
        } else {
          newContent.push(b)
        }
      }
      if (changed) {
        if (!out) out = messages.slice()
        out[i] = { ...src, content: newContent }
      }
    }

    return { messages: out ?? messages, systemPrompt: outSystemPrompt, tools }
  }
}
