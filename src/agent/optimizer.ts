import type { Message, ContextOptimizerOptions, ToolUseBlock } from '../types.js'

/**
 * Simple heuristic to estimate the number of tokens based on character length.
 * The usual rule of thumb is 1 token ≈ 4 characters of plain text.
 */
export function estimateTokens(messages: Message[], systemPrompt?: string): number {
  let charCount = systemPrompt ? systemPrompt.length : 0

  for (const m of messages) {
    charCount += m.role.length
    for (const b of m.content) {
      if (b.type === 'text') {
        charCount += b.text.length
      } else if (b.type === 'tool_use') {
        charCount += b.name.length + JSON.stringify(b.input).length
      } else if (b.type === 'tool_result') {
        charCount += b.content.length
      }
    }
  }

  return Math.ceil(charCount / 4)
}

/**
 * Finds the tool_use definition in the assistant messages.
 */
function findToolUse(messages: Message[], toolUseId: string): ToolUseBlock | null {
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const b of m.content) {
        if (b.type === 'tool_use' && b.id === toolUseId) {
          return b
        }
      }
    }
  }
  return null
}

/**
 * Generates a compact summary of a tool's execution.
 */
function defaultSummarizeToolResult(content: string, toolUse: ToolUseBlock | null): string {
  const originalLength = content.length
  const previewLimit = 150
  const preview = originalLength > previewLimit
    ? content.substring(0, previewLimit) + '...'
    : content

  const toolName = toolUse ? toolUse.name : 'unknown'

  return `[Tool '${toolName}' execution result truncated to save context. Original output length: ${originalLength} characters. Preview: "${preview}"]`
}

/**
 * Optimizes the current context (messages) if it exceeds the token threshold.
 */
export function optimizeContext(
  messages: Message[],
  systemPrompt: string,
  options: Required<ContextOptimizerOptions>
): { messages: Message[]; optimized: boolean } {
  let currentTokens = options.tokenCounter(messages, systemPrompt)
  const threshold = options.maxTokens * (options.compressThreshold ?? 0.8)

  if (currentTokens <= threshold) {
    return { messages, optimized: false }
  }

  // Clone messages so we don't mutate the input directly
  const cloned: Message[] = JSON.parse(JSON.stringify(messages))

  // Determine the boundary index to keep the recent turns intact.
  // A "turn" starts when we find a user message containing non-empty text
  // (i.e. the user's initial or follow-up prompt).
  let boundaryIndex = 0
  let userPromptsSeen = 0
  for (let i = cloned.length - 1; i >= 0; i--) {
    const m = cloned[i]
    if (m && m.role === 'user' && m.content.some((b) => b.type === 'text')) {
      userPromptsSeen++
      if (userPromptsSeen === options.keepRecentTurns) {
        boundaryIndex = i
        break
      }
    }
  }

  if (boundaryIndex === 0) {
    // If all messages fall within the recent-turns window, we can't optimize
    return { messages, optimized: false }
  }

  let optimized = false

  // --- Level 1: Compact old tool_result blocks ---
  for (let i = 0; i < boundaryIndex; i++) {
    const m = cloned[i]!
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const isAlreadyTruncated =
          b.content.startsWith('[Tool') && b.content.includes('result truncated')
        if (!isAlreadyTruncated) {
          const toolUse = findToolUse(cloned, b.tool_use_id)
          const newContent = defaultSummarizeToolResult(b.content, toolUse)
          if (newContent.length < b.content.length) {
            b.content = newContent
            optimized = true

            // Re-evaluate tokens after each compression to stop as early as possible
            currentTokens = options.tokenCounter(cloned, systemPrompt)
            if (currentTokens <= threshold) {
              return { messages: cloned, optimized: true }
            }
          }
        }
      }
    }
  }

  // --- Level 2: Remove the oldest messages (except message 0, the initial prompt) ---
  // We iterate removing the message at index 1 while possible and while above the threshold.
  while (cloned.length > 2 && currentTokens > threshold) {
    // Recompute the dynamic boundary on the trimmed list
    let tempBoundary = 0
    let tempPrompts = 0
    for (let i = cloned.length - 1; i >= 0; i--) {
      const m = cloned[i]
      if (m && m.role === 'user' && m.content.some((b) => b.type === 'text')) {
        tempPrompts++
        if (tempPrompts === options.keepRecentTurns) {
          tempBoundary = i
          break
        }
      }
    }

    // Don't remove if the message to delete (index 1) already falls within the recent-turns protection window
    if (tempBoundary <= 1) {
      break
    }

    cloned.splice(1, 1)
    optimized = true

    // Re-evaluate tokens
    currentTokens = options.tokenCounter(cloned, systemPrompt)
  }

  return { messages: cloned, optimized }
}
