import type { SessionHooks } from '../../types.js'
import type { ErrorContext, ToolCallSummary } from './types.js'
import type { ErrorRegistry } from './registry.js'

export interface AttachErrorRegistryOptions {
  registry: ErrorRegistry
  /**
   * Contexto que se anexa a cada `ErrorEntry` registrado por esta sesión.
   * `tags` se mergea con los tags globales del registry.
   */
  context: ErrorContext
  /**
   * Cuántos tool_executions exitosos seguidos sin recurrencia del mismo
   * error son necesarios para considerar que la resolución funcionó.
   * Default 2.
   */
  successWindow?: number
  /**
   * Logger opcional. Si se pasa, escribe traza interna del state machine.
   */
  log?: (msg: string) => void
}

/**
 * Estado por error abierto (sin resolver todavía).
 * Vive en memoria mientras dura la sesión.
 */
interface OpenError {
  entryId: string
  /** Si en query() vimos una resolución aprobada, la guardamos para incrementar successCount al cerrar. */
  hintedResolutionId: string | null
  /** Tool calls que el agente hizo después del error y antes de cerrar este error. */
  toolCallsSinceError: ToolCallSummary[]
  /** Cuántas ejecuciones exitosas consecutivas vimos del mismo toolName. */
  consecutiveSuccesses: number
  /** Tool donde ocurrió el error. */
  toolName: string
  /** Fingerprint del error original, para detectar recurrencia. */
  fingerprint: string
}

/**
 * Marca la salida de una tool con un hint del error-registry, en un
 * bloque XML que el modelo sabe interpretar (es lo que ya hace el system
 * prompt con `<context>...`).
 */
function buildHintBlock(args: {
  score: number
  resolutions: Array<{ description: string; toolCalls: ToolCallSummary[]; successCount: number }>
}): string {
  const lines: string[] = []
  lines.push(
    '<error-registry-hint>',
    'Otro agente (o vos en una corrida anterior) ya resolvió un error muy parecido a éste.',
    `Confianza del match: ${args.score.toFixed(2)}.`,
    'Resoluciones aprobadas por humano, ordenadas por éxito empírico:',
  )
  args.resolutions.slice(0, 3).forEach((r, i) => {
    lines.push(`  ${i + 1}. (éxitos: ${r.successCount}) ${r.description}`)
    if (r.toolCalls.length > 0) {
      lines.push(`     Pasos sugeridos:`)
      for (const c of r.toolCalls) {
        lines.push(`       - ${c.name}(${JSON.stringify(c.input)})`)
      }
    }
  })
  lines.push(
    'Considerá aplicar la resolución más relevante antes de explorar por tu cuenta.',
    '</error-registry-hint>',
  )
  return lines.join('\n')
}

/**
 * Crea un `SessionHooks` que conecta la sesión al registry experimental.
 *
 * Uso:
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
 * Comportamiento:
 *  - Cuando una tool devuelve `isError: true`, consulta el registry y, si hay
 *    una resolución aprobada, anexa un `<error-registry-hint>` a la salida de
 *    la tool (que el modelo verá en el próximo turno).
 *  - Trackea las tool calls del agente entre el error y la resolución.
 *  - Al cierre de un turno con `end_turn` y sin recurrencia del mismo error,
 *    registra una resolución `pending` (que después un humano aprueba via
 *    `registry.approveResolution`).
 */
export function errorRegistryHooks(opts: AttachErrorRegistryOptions): SessionHooks {
  const log = opts.log ?? (() => {})
  const successWindow = opts.successWindow ?? 2

  // Estado por sesión. Indexado por fingerprint para detectar recurrencias
  // del mismo error en cualquier orden.
  const openErrors = new Map<string, OpenError>()

  // Buffer del último mensaje del assistant — necesario para extraer la
  // "description" de la resolución cuando cerramos un error.
  let lastAssistantText = ''

  return {
    async afterToolExecution({ toolName, input, output, isError }) {
      // Caso 1: la tool falló. Consultar registry y eventualmente inyectar hint.
      if (isError) {
        const queryInput = {
          rawError: output,
          toolName,
          context: opts.context,
        }
        const hit = await opts.registry.query(queryInput)

        // Ensure entry para poder atar resoluciones futuras.
        const entry = await opts.registry.ensureEntry(queryInput)

        // Si ya había un OpenError con el mismo fingerprint, esto es una
        // recurrencia → la resolución intentada no funcionó. Resetear el
        // contador de éxito y mantener el error abierto.
        const existingOpen = [...openErrors.values()].find((o) => o.fingerprint === entry.fingerprint)
        if (existingOpen) {
          existingOpen.consecutiveSuccesses = 0
          existingOpen.toolCallsSinceError = []
          log(`[error-registry] recurrencia de fingerprint=${entry.fingerprint}, resolución anterior fallida`)
        } else {
          openErrors.set(entry.id, {
            entryId: entry.id,
            hintedResolutionId: hit?.approvedResolutions[0]?.id ?? null,
            toolCallsSinceError: [],
            consecutiveSuccesses: 0,
            toolName,
            fingerprint: entry.fingerprint,
          })
          log(`[error-registry] nuevo error abierto, fingerprint=${entry.fingerprint}, hint=${hit?.approvedResolutions.length ?? 0} resoluciones`)
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

      // Caso 2: la tool tuvo éxito. Anotar la tool call en cada OpenError
      // que esté esperando recovery, e incrementar el contador.
      const summary: ToolCallSummary = { name: toolName, input }
      for (const open of openErrors.values()) {
        open.toolCallsSinceError.push(summary)
        open.consecutiveSuccesses += 1
      }
      return output
    },

    async afterTurn({ lastMessage, turn }) {
      // Capturar el texto del último assistant_message para usarlo como
      // descripción cuando registremos la resolución.
      const text = lastMessage.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (text) lastAssistantText = text

      // Un assistant_message sin tool_use marca el cierre de la tarea
      // (stopReason='end_turn' implícito). Sólo en ese momento promovemos
      // los OpenErrors a resoluciones — antes, el agente puede estar
      // todavía aplicando fixes y seguir trayendo tool_use al hilo.
      const hasToolUse = lastMessage.content.some((b) => b.type === 'tool_use')
      if (hasToolUse) return

      // Para cada error abierto: si llegamos a `successWindow` ejecuciones
      // exitosas seguidas sin recurrencia, considerar resuelto.
      for (const [entryId, open] of [...openErrors.entries()]) {
        if (open.consecutiveSuccesses >= successWindow) {
          try {
            const resolution = await opts.registry.recordResolution({
              entryId,
              description: lastAssistantText || `(sin descripción — turn ${turn})`,
              toolCalls: open.toolCallsSinceError,
            })
            log(`[error-registry] resolución pending registrada id=${resolution.id} para entry=${entryId}`)
            // Si veníamos de aplicar un hint, contar el reuse exitoso.
            if (open.hintedResolutionId) {
              await opts.registry.noteSuccessfulReuse(open.hintedResolutionId)
              log(`[error-registry] noteSuccessfulReuse hintedResolution=${open.hintedResolutionId}`)
            }
          } catch (err) {
            log(`[error-registry] fallo registrando resolución: ${(err as Error).message}`)
          }
          openErrors.delete(entryId)
        }
      }
    },
  }
}
