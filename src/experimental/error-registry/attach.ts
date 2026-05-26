import type { SessionHooks } from '../../types.js'
import type { ErrorContext, ToolCallSummary } from './types.js'
import type { ErrorRegistry } from './registry.js'

export interface AttachErrorRegistryOptions {
  registry: ErrorRegistry
  /**
   * Context attached to every `ErrorEntry` recorded by this session.
   * `tags` is merged with the registry-wide tags.
   */
  context: ErrorContext
  /**
   * How many consecutive successful tool executions (without recurrence
   * of the same error) are required to consider the resolution working.
   * Default: 2.
   */
  successWindow?: number
  /**
   * Optional logger. When provided, the state machine emits trace lines.
   */
  log?: (msg: string) => void
}

/**
 * Per-open-error state (not yet resolved). Lives in memory for the
 * lifetime of the session.
 */
interface OpenError {
  entryId: string
  /** When query() returned an approved resolution, we remember it to bump successCount on close. */
  hintedResolutionId: string | null
  /** Tool calls the agent issued after the error and before this error was closed. */
  toolCallsSinceError: ToolCallSummary[]
  /** How many consecutive successful executions of the same toolName we have observed. */
  consecutiveSuccesses: number
  /** Tool where the error occurred. */
  toolName: string
  /** Original error's fingerprint, used to detect recurrence. */
  fingerprint: string
}

/**
 * Wraps a tool output with an error-registry hint block. The XML-style
 * wrapper matches what the default system prompt teaches the model to
 * read (see `<context>` blocks in prompt/system.ts).
 */
function buildHintBlock(args: {
  score: number
  resolutions: Array<{ description: string; toolCalls: ToolCallSummary[]; successCount: number }>
}): string {
  const lines: string[] = []
  lines.push(
    '<error-registry-hint>',
    'Another agent (or you, in a previous run) already resolved an error very similar to this one.',
    `Match confidence: ${args.score.toFixed(2)}.`,
    'Human-approved resolutions, ranked by empirical success:',
  )
  args.resolutions.slice(0, 3).forEach((r, i) => {
    lines.push(`  ${i + 1}. (successes: ${r.successCount}) ${r.description}`)
    if (r.toolCalls.length > 0) {
      lines.push(`     Suggested steps:`)
      for (const c of r.toolCalls) {
        lines.push(`       - ${c.name}(${JSON.stringify(c.input)})`)
      }
    }
  })
  lines.push(
    'Consider applying the most relevant resolution before exploring on your own.',
    '</error-registry-hint>',
  )
  return lines.join('\n')
}

/**
 * Builds a `SessionHooks` object that wires the session to the
 * experimental error registry.
 *
 * Usage:
 *
 * ```ts
 * const registry = createErrorRegistry({ storePath: '.astorlm/errors.jsonl' })
 * await registry.init()
 * const session = await createAgentSession({
 *   provider,
 *   tools,
 *   hooks: errorRegistryHooks({ registry, context: { cwd, osPlatform, nodeVersion, tags: [] } }),
 * })
 * ```
 *
 * Behavior:
 *  - When a tool returns `isError: true`, queries the registry and, if
 *    an approved resolution exists, appends an `<error-registry-hint>`
 *    block to the tool output (which the model will see next turn).
 *  - Tracks the agent's tool calls between the error and the resolution.
 *  - On a turn that ends with `end_turn` and no recurrence of the same
 *    error, records a `pending` resolution (which a human later approves
 *    via `registry.approveResolution`).
 */
export function errorRegistryHooks(opts: AttachErrorRegistryOptions): SessionHooks {
  const log = opts.log ?? (() => {})
  const successWindow = opts.successWindow ?? 2

  // Per-session state, keyed by fingerprint to detect recurrences of
  // the same error in any order.
  const openErrors = new Map<string, OpenError>()

  // Buffer for the last assistant message — needed to extract the
  // resolution's "description" when we close an error.
  let lastAssistantText = ''

  return {
    async afterToolExecution({ toolName, input, output, isError }) {
      // Case 1: the tool failed. Query the registry and possibly inject a hint.
      if (isError) {
        const queryInput = {
          rawError: output,
          toolName,
          context: opts.context,
        }
        const hit = await opts.registry.query(queryInput)

        // Ensure an entry exists so future resolutions can be attached.
        const entry = await opts.registry.ensureEntry(queryInput)

        // If an OpenError with the same fingerprint already exists, this
        // is a recurrence → the attempted resolution did not work. Reset
        // the success counter and keep the error open.
        const existingOpen = [...openErrors.values()].find((o) => o.fingerprint === entry.fingerprint)
        if (existingOpen) {
          existingOpen.consecutiveSuccesses = 0
          existingOpen.toolCallsSinceError = []
          log(`[error-registry] recurrence of fingerprint=${entry.fingerprint}, previous resolution failed`)
        } else {
          openErrors.set(entry.id, {
            entryId: entry.id,
            hintedResolutionId: hit?.approvedResolutions[0]?.id ?? null,
            toolCallsSinceError: [],
            consecutiveSuccesses: 0,
            toolName,
            fingerprint: entry.fingerprint,
          })
          log(`[error-registry] new open error, fingerprint=${entry.fingerprint}, hints=${hit?.approvedResolutions.length ?? 0}`)
        }

        if (hit && hit.approvedResolutions.length > 0) {
          const hint = buildHintBlock({
            score: hit.score,
            resolutions: hit.approvedResolutions,
          })
          return `${output}\n\n${hint}`
        }
        return output
      }

      // Case 2: tool succeeded. Record the call against every OpenError
      // waiting for recovery and bump the counter.
      const summary: ToolCallSummary = { name: toolName, input }
      for (const open of openErrors.values()) {
        open.toolCallsSinceError.push(summary)
        open.consecutiveSuccesses += 1
      }
      return output
    },

    async afterTurn({ lastMessage, turn }) {
      // Capture the last assistant_message text to use as the resolution
      // description when we record it.
      const text = lastMessage.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (text) lastAssistantText = text

      // An assistant_message without tool_use marks the end of the task
      // (implicit stopReason='end_turn'). Only at that point do we
      // promote OpenErrors to resolutions — before that, the agent may
      // still be applying fixes and emitting more tool_use blocks.
      const hasToolUse = lastMessage.content.some((b) => b.type === 'tool_use')
      if (hasToolUse) return

      // For each open error: if we hit `successWindow` consecutive
      // successful executions without recurrence, consider it resolved.
      for (const [entryId, open] of [...openErrors.entries()]) {
        if (open.consecutiveSuccesses >= successWindow) {
          try {
            const resolution = await opts.registry.recordResolution({
              entryId,
              description: lastAssistantText || `(no description — turn ${turn})`,
              toolCalls: open.toolCallsSinceError,
            })
            log(`[error-registry] pending resolution recorded id=${resolution.id} for entry=${entryId}`)
            // If we acted on a hint, count the reuse as successful.
            if (open.hintedResolutionId) {
              await opts.registry.noteSuccessfulReuse(open.hintedResolutionId)
              log(`[error-registry] noteSuccessfulReuse hintedResolution=${open.hintedResolutionId}`)
            }
          } catch (err) {
            log(`[error-registry] failed to record resolution: ${(err as Error).message}`)
          }
          openErrors.delete(entryId)
        }
      }
    },
  }
}
