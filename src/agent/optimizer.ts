import type { Message, ContextOptimizerOptions, ToolUseBlock } from '../types.js'

/**
 * Heurística simple para estimar el número de tokens en base a la longitud de caracteres.
 * La regla de oro habitual es 1 token ≈ 4 caracteres de texto plano.
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
 * Busca la definición de tool_use en los mensajes del asistente.
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
 * Genera un resumen compacto de la ejecución de una herramienta.
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
 * Optimiza el contexto actual (messages) si excede el umbral de tokens.
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

  // Clonar mensajes para no mutar el input directamente
  const cloned: Message[] = JSON.parse(JSON.stringify(messages))

  // Determinar el índice límite para conservar los turnos recientes intactos.
  // Un "turno" inicia cuando encontramos un mensaje de usuario que contiene texto no vacío
  // (es decir, el prompt inicial o de seguimiento del usuario).
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
    // Si todos los mensajes caen en la ventana de turnos recientes, no podemos optimizar
    return { messages, optimized: false }
  }

  let optimized = false

  // --- Nivel 1: Compactar bloques tool_result antiguos ---
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

            // Reevaluar tokens tras cada compresión para detenerse lo antes posible
            currentTokens = options.tokenCounter(cloned, systemPrompt)
            if (currentTokens <= threshold) {
              return { messages: cloned, optimized: true }
            }
          }
        }
      }
    }
  }

  // --- Nivel 2: Eliminar mensajes más antiguos (excepto el mensaje 0 que es el prompt inicial) ---
  // Iteramos eliminando el mensaje en el índice 1 mientras sea posible y estemos por encima del umbral.
  while (cloned.length > 2 && currentTokens > threshold) {
    // Recalcular la frontera dinámica en la lista recortada
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

    // No remover si el mensaje a eliminar (índice 1) ya cae dentro de la ventana de protección de turnos recientes
    if (tempBoundary <= 1) {
      break
    }

    cloned.splice(1, 1)
    optimized = true

    // Reevaluar tokens
    currentTokens = options.tokenCounter(cloned, systemPrompt)
  }

  return { messages: cloned, optimized }
}
