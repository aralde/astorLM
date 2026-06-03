import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { createAgent } from './session.js'
import { tool } from '../tools/index.js'
import type { AgentEvent, Message, Provider, Tool } from '../types.js'
import type { Executor } from '../executor/types.js'

/**
 * Estrategia para obtener la salida tipada:
 *
 *   - `'tool'`   — "tool terminal": se registra una tool sintética cuyo schema
 *                  es el deseado y se instruye al modelo a llamarla para
 *                  entregar la respuesta. El input de esa tool ES el objeto.
 *                  Funciona en cualquier provider y convive con otras tools.
 *                  La validación Zod + el repair loop del agente corrigen
 *                  desvíos automáticamente.
 *   - `'native'` — `response_format: json_schema` del provider (constrained
 *                  decoding en OpenAI). Garantía más fuerte, pero NO admite
 *                  tools en la misma llamada. Si el provider no lo soporta,
 *                  degrada a prompt + validación + reintentos.
 *   - `'auto'`   — (default) `'native'` si no hay tools y el provider es
 *                  OpenAI-compatible; `'tool'` en cualquier otro caso.
 */
export type GenerateObjectMode = 'auto' | 'tool' | 'native'

export interface GenerateObjectOptions<S extends z.ZodTypeAny> {
  /** Provider del modelo. */
  provider: Provider
  /** Schema Zod que la respuesta debe cumplir. Tipa el resultado. */
  schema: S
  /** Instrucción/prompt del usuario. */
  prompt: string
  /** System prompt opcional. Si se omite, se usa uno mínimo orientado a la tarea. */
  system?: string
  /** Tools adicionales que el agente puede usar antes de entregar la respuesta. Fuerza modo `'tool'`. */
  tools?: Tool[]
  /** Directorio de trabajo (relevante sólo si las tools tocan el filesystem). */
  cwd?: string
  /** Estrategia. Default `'auto'`. */
  mode?: GenerateObjectMode
  /** Backend de ejecución para las tools (modo `'tool'`). */
  executor?: Executor
  /** Tope de turnos del agente en modo `'tool'`. Default 8 (deja margen para repair). */
  maxTurns?: number
  /** Reintentos de reparación en modo `'native'` cuando la salida no valida. Default 2. */
  maxRepairAttempts?: number
  /** Nombre de la tool terminal en modo `'tool'`. Default `'provide_final_answer'`. */
  toolName?: string
  /** Descripción de la tool terminal. */
  toolDescription?: string
  /** Suscripción a los eventos del agente (stream, tools, etc.). */
  onEvent?: (event: AgentEvent) => void
  /** Señal de cancelación. */
  abortSignal?: AbortSignal
}

export interface GenerateObjectResult<T> {
  /** El objeto tipado y validado contra el schema. */
  object: T
  /** Mensaje del assistant que produjo (o cerró) la respuesta. */
  message: Message
  /** Id de sesión (sólo en modo `'tool'`, que corre un agente real). */
  sessionId?: string
  /** Estrategia efectivamente usada. */
  mode: Exclude<GenerateObjectMode, 'auto'>
}

const DEFAULT_TOOL_NAME = 'provide_final_answer'

/**
 * Genera un objeto tipado a partir de un prompt, validándolo contra un schema Zod.
 *
 * Es la API de alto nivel para "salida estructurada" (structured output) del SDK.
 * El primitivo general es la **tool terminal** (modo `'tool'`), que reutiliza la
 * validación de tools y el repair loop del agente; el modo `'native'` aprovecha
 * `response_format` del provider cuando no hay tools y se quiere garantía dura.
 *
 * @example
 * ```ts
 * const Sentiment = z.object({ label: z.enum(['pos','neg','neu']), score: z.number() })
 * const { object } = await generateObject({
 *   provider: new OpenAIProvider({ model: 'myproxyllm', baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'x' }),
 *   schema: Sentiment,
 *   prompt: "Clasificá: 'me encantó el servicio'",
 * })
 * object.label // 'pos' (tipado)
 * ```
 */
export async function generateObject<S extends z.ZodTypeAny>(
  opts: GenerateObjectOptions<S>,
): Promise<GenerateObjectResult<z.infer<S>>> {
  const jsonSchema = normalizeSchema(
    zodToJsonSchema(opts.schema, { target: 'openApi3' }) as Record<string, unknown>,
  )

  const hasUserTools = (opts.tools?.length ?? 0) > 0
  const isOpenAILike = opts.provider.name === 'openai'
  const mode: Exclude<GenerateObjectMode, 'auto'> =
    opts.mode && opts.mode !== 'auto'
      ? opts.mode
      : !hasUserTools && isOpenAILike
        ? 'native'
        : 'tool'

  if (mode === 'native') {
    return runNative(opts, jsonSchema)
  }
  return runTool(opts, jsonSchema)
}

// ---------- Modo tool terminal ----------

async function runTool<S extends z.ZodTypeAny>(
  opts: GenerateObjectOptions<S>,
  jsonSchema: Record<string, unknown>,
): Promise<GenerateObjectResult<z.infer<S>>> {
  const toolName = opts.toolName ?? DEFAULT_TOOL_NAME
  let captured: z.infer<S> | undefined
  let didCapture = false

  // La tool terminal: su `parseInput` (Zod) valida; si el modelo se desvía,
  // el throw se convierte en un tool_result de error que el modelo ve y corrige.
  const terminalTool = tool({
    name: toolName,
    description:
      opts.toolDescription ??
      'Entregá la respuesta final como un objeto que cumpla exactamente este schema. ' +
        'Llamá esta tool UNA sola vez, cuando tengas la respuesta completa.',
    schema: opts.schema,
    execute: async (input) => {
      captured = input as z.infer<S>
      didCapture = true
      return 'Respuesta registrada.'
    },
  })

  const system =
    (opts.system ? opts.system + '\n\n' : '') +
    `Cuando tengas la respuesta final, devolvela llamando a la tool "${toolName}" ` +
    `con un objeto que cumpla su schema. No escribas la respuesta como texto suelto.`

  const agent = await createAgent({
    provider: opts.provider,
    cwd: opts.cwd,
    tools: [...(opts.tools ?? []), terminalTool],
    systemPrompt: system,
    executor: opts.executor,
    maxTurns: opts.maxTurns ?? 8,
    stopOnToolNames: [toolName],
  })

  if (opts.onEvent) agent.on('event', opts.onEvent)

  const message = await agent.run(opts.prompt, { abortSignal: opts.abortSignal })

  if (!didCapture) {
    throw new GenerateObjectError(
      `El modelo terminó sin llamar a la tool terminal "${toolName}". ` +
        `Probá subir maxTurns o reforzar el system prompt.`,
      { mode: 'tool', message },
    )
  }

  return { object: captured as z.infer<S>, message, sessionId: agent.id, mode: 'tool' }
}

// ---------- Modo nativo (response_format) ----------

async function runNative<S extends z.ZodTypeAny>(
  opts: GenerateObjectOptions<S>,
  jsonSchema: Record<string, unknown>,
): Promise<GenerateObjectResult<z.infer<S>>> {
  const system =
    opts.system ??
    'Respondé únicamente con un objeto JSON que cumpla el schema solicitado. Sin texto adicional.'

  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: opts.prompt }] }]
  const maxAttempts = (opts.maxRepairAttempts ?? 2) + 1
  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let text = ''
    let message: Message = { role: 'assistant', content: [] }

    for await (const ev of opts.provider.stream({
      systemPrompt: system,
      messages,
      tools: [],
      abortSignal: opts.abortSignal ?? new AbortController().signal,
      outputFormat: { name: schemaName(opts), schema: jsonSchema },
    })) {
      if (ev.type === 'text_delta') {
        text += ev.text
        opts.onEvent?.({ type: 'text_delta', text: ev.text })
      } else if (ev.type === 'thinking_delta') {
        opts.onEvent?.({ type: 'thinking_delta', thinking: ev.thinking })
      } else if (ev.type === 'message_end') {
        message = ev.assistantMessage
      }
    }

    try {
      const parsed = opts.schema.parse(JSON.parse(extractJson(text)))
      return { object: parsed as z.infer<S>, message, mode: 'native' }
    } catch (err) {
      lastError = err
      // Repair: devolvemos el intento y el error de validación para que corrija.
      messages.push(message)
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `Tu salida anterior no cumplió el schema: ${errorMessage(err)}. ` +
              `Devolvé SÓLO el JSON válido, sin explicaciones.`,
          },
        ],
      })
    }
  }

  throw new GenerateObjectError(
    `generateObject (native) no obtuvo una salida válida tras ${maxAttempts} intentos: ${errorMessage(lastError)}`,
    { mode: 'native' },
  )
}

// ---------- Helpers ----------

export class GenerateObjectError extends Error {
  readonly mode: Exclude<GenerateObjectMode, 'auto'>
  readonly message_?: Message
  constructor(message: string, ctx: { mode: Exclude<GenerateObjectMode, 'auto'>; message?: Message }) {
    super(message)
    this.name = 'GenerateObjectError'
    this.mode = ctx.mode
    this.message_ = ctx.message
  }
}

function schemaName<S extends z.ZodTypeAny>(opts: GenerateObjectOptions<S>): string {
  return opts.toolName ?? 'structured_output'
}

function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema['type'] === 'object') return schema
  return { type: 'object', properties: {}, ...schema }
}

/** Extrae el primer bloque JSON de un texto, tolerando fences markdown. */
function extractJson(text: string): string {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) return fence[1].trim()
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1)
  }
  return trimmed
}

function errorMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
  }
  return err instanceof Error ? err.message : String(err)
}
