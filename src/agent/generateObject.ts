import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { createAgent } from './session.js'
import { tool } from '../tools/index.js'
import type { AgentEvent, Message, Provider, Tool } from '../types.js'
import type { Executor } from '../executor/types.js'

/**
 * Strategy for obtaining the typed output:
 *
 *   - `'tool'`   — "terminal tool": a synthetic tool whose schema is the desired
 *                  one is registered, and the model is instructed to call it to
 *                  deliver the answer. That tool's input IS the object. Works on
 *                  any provider and coexists with other tools. Zod validation +
 *                  the agent's repair loop fix deviations automatically.
 *   - `'native'` — the provider's `response_format: json_schema` (constrained
 *                  decoding on OpenAI). Stronger guarantee, but does NOT allow
 *                  tools in the same call. If the provider doesn't support it,
 *                  degrades to prompt + validation + retries.
 *   - `'auto'`   — (default) `'native'` when there are no tools and the provider
 *                  is OpenAI-compatible; `'tool'` otherwise.
 */
export type GenerateObjectMode = 'auto' | 'tool' | 'native'

export interface GenerateObjectOptions<S extends z.ZodTypeAny> {
  /** Model provider. */
  provider: Provider
  /** Zod schema the response must satisfy. Types the result. */
  schema: S
  /** User instruction/prompt. */
  prompt: string
  /** Optional system prompt. If omitted, a minimal task-oriented one is used. */
  system?: string
  /** Extra tools the agent may use before delivering the answer. Forces `'tool'` mode. */
  tools?: Tool[]
  /** Working directory (relevant only if the tools touch the filesystem). */
  cwd?: string
  /** Strategy. Default `'auto'`. */
  mode?: GenerateObjectMode
  /** Execution backend for the tools (`'tool'` mode). */
  executor?: Executor
  /** Cap on the agent's turns in `'tool'` mode. Default 8 (leaves room for repair). */
  maxTurns?: number
  /** Repair retries in `'native'` mode when the output fails validation. Default 2. */
  maxRepairAttempts?: number
  /** Name of the terminal tool in `'tool'` mode. Default `'provide_final_answer'`. */
  toolName?: string
  /** Description of the terminal tool. */
  toolDescription?: string
  /** Subscription to the agent's events (stream, tools, etc.). */
  onEvent?: (event: AgentEvent) => void
  /** Cancellation signal. */
  abortSignal?: AbortSignal
}

export interface GenerateObjectResult<T> {
  /** The typed object, validated against the schema. */
  object: T
  /** The assistant message that produced (or closed) the answer. */
  message: Message
  /** Session id (only in `'tool'` mode, which runs a real agent). */
  sessionId?: string
  /** Strategy actually used. */
  mode: Exclude<GenerateObjectMode, 'auto'>
}

const DEFAULT_TOOL_NAME = 'provide_final_answer'

/**
 * Generates a typed object from a prompt, validating it against a Zod schema.
 *
 * This is the SDK's high-level API for structured output. The general primitive
 * is the **terminal tool** (`'tool'` mode), which reuses tool validation and the
 * agent's repair loop; `'native'` mode leverages the provider's `response_format`
 * when there are no tools and a hard guarantee is wanted.
 *
 * @example
 * ```ts
 * const Sentiment = z.object({ label: z.enum(['pos','neg','neu']), score: z.number() })
 * const { object } = await generateObject({
 *   provider: new OpenAIProvider({ model: 'qwen2.5-coder', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' }),
 *   schema: Sentiment,
 *   prompt: "Classify: 'I loved the service'",
 * })
 * object.label // 'pos' (typed)
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

// ---------- Terminal tool mode ----------

async function runTool<S extends z.ZodTypeAny>(
  opts: GenerateObjectOptions<S>,
  jsonSchema: Record<string, unknown>,
): Promise<GenerateObjectResult<z.infer<S>>> {
  const toolName = opts.toolName ?? DEFAULT_TOOL_NAME
  let captured: z.infer<S> | undefined
  let didCapture = false

  // The terminal tool: its `parseInput` (Zod) validates; if the model deviates,
  // the throw becomes an error tool_result that the model sees and corrects.
  const terminalTool = tool({
    name: toolName,
    description:
      opts.toolDescription ??
      'Deliver the final answer as an object that exactly satisfies this schema. ' +
        'Call this tool ONCE, when you have the complete answer.',
    schema: opts.schema,
    execute: async (input) => {
      captured = input as z.infer<S>
      didCapture = true
      return 'Answer recorded.'
    },
  })

  const system =
    (opts.system ? opts.system + '\n\n' : '') +
    `When you have the final answer, return it by calling the "${toolName}" tool ` +
    `with an object that satisfies its schema. Do not write the answer as free text.`

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
      `The model finished without calling the terminal tool "${toolName}". ` +
        `Try raising maxTurns or reinforcing the system prompt.`,
      { mode: 'tool', message },
    )
  }

  return { object: captured as z.infer<S>, message, sessionId: agent.id, mode: 'tool' }
}

// ---------- Native mode (response_format) ----------

async function runNative<S extends z.ZodTypeAny>(
  opts: GenerateObjectOptions<S>,
  jsonSchema: Record<string, unknown>,
): Promise<GenerateObjectResult<z.infer<S>>> {
  const system =
    opts.system ??
    'Respond only with a JSON object that satisfies the requested schema. No additional text.'

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
      // Repair: return the attempt and the validation error so it can fix it.
      messages.push(message)
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `Your previous output did not satisfy the schema: ${errorMessage(err)}. ` +
              `Return ONLY the valid JSON, with no explanations.`,
          },
        ],
      })
    }
  }

  throw new GenerateObjectError(
    `generateObject (native) did not obtain a valid output after ${maxAttempts} attempts: ${errorMessage(lastError)}`,
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

/** Extracts the first JSON block from a text, tolerating markdown fences. */
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
