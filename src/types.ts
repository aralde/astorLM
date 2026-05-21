/**
 * Public type surface for the agent library.
 *
 * Mensajes y bloques siguen el modelo de "content blocks" de Anthropic:
 * un mensaje del assistant puede contener texto + tool_use; un mensaje del
 * user puede contener texto + tool_result. Esto facilita modelar el loop
 * sin perder información intermedia.
 */

import type { Executor } from './executor/types.js'

export type Role = 'user' | 'assistant' | 'system'

export type TextBlock = { type: 'text'; text: string }
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature?: string }
export type RedactedThinkingBlock = { type: 'redacted_thinking'; signature: string }
export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}
export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type ContentBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock | ToolResultBlock

export interface Message {
  id?: string
  role: Role
  content: ContentBlock[]
}

/** Razón por la cual el provider terminó un turno. */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'

// ---------- Tools ----------

export interface ToolContext {
  cwd: string
  abortSignal: AbortSignal
  logger: Logger
  /**
   * Backend de ejecución de comandos shell. Inyectado por la sesión. El bashTool
   * (y derivados: bash_spawn, bash_get_output, bash_kill) delegan acá en vez de
   * hablar con `child_process` directo, lo que permite swappear el backend
   * (local, container, remoto) sin tocar las tools.
   */
  executor: Executor
}

/**
 * Una tool registrada. El tipo del input vive **adentro** del closure de
 * `defineTool` (parseInput valida y castea); el contrato público es uniforme
 * para que un `Tool` sea libremente almacenable en arrays/registry sin
 * romper la varianza.
 */
export interface Tool {
  name: string
  description: string
  /** JSON Schema enviado al provider. */
  inputSchema: Record<string, unknown>
  /** Valida y parsea input crudo proveniente del modelo. */
  parseInput: (raw: unknown) => unknown
  execute: (input: unknown, ctx: ToolContext) => Promise<string>
}

// ---------- Session Hooks ----------

export interface SessionHooks {
  beforeTurn?: (context: { turn: number; messages: Message[] }) => Promise<void>
  beforeProviderCall?: (context: { messages: Message[]; systemPrompt: string }) => Promise<{ messages: Message[]; systemPrompt: string }>
  beforeToolExecution?: (context: { toolName: string; input: unknown; toolUseId: string }) => Promise<{ authorize: boolean; mockResult?: string }>
  afterToolExecution?: (context: { toolName: string; input: unknown; output: string; durationMs: number }) => Promise<string>
  afterTurn?: (context: { turn: number; lastMessage: Message }) => Promise<void>
}

// ---------- Context Optimizer ----------

export interface ContextOptimizerOptions {
  maxTokens: number
  compressThreshold?: number
  keepRecentTurns?: number
  tokenCounter?: (messages: Message[], systemPrompt: string) => number
}

// ---------- Provider ----------

export interface ProviderStreamOptions {
  systemPrompt: string
  messages: Message[]
  tools: Array<Pick<Tool, 'name' | 'description' | 'inputSchema'>>
  abortSignal: AbortSignal
  maxTokens?: number
}

/**
 * Conteo de tokens crudo reportado por el provider para una llamada.
 * Sin pricing ni conversión a USD — el consumidor calcula costo si quiere.
 * `cacheReadTokens` / `cacheCreationTokens` quedan opcionales porque no todos
 * los providers los exponen (Anthropic sí; OpenAI sólo `cached_tokens` cuando
 * el modelo cachea automáticamente; muchos OpenAI-compat no devuelven nada).
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input'; id: string; inputJsonDelta: string }
  | { type: 'tool_use_end'; id: string; name: string; input: unknown }
  | { type: 'message_end'; stopReason: StopReason; assistantMessage: Message; usage?: TokenUsage }

export interface Provider {
  readonly name: string
  readonly model: string
  readonly contextLimit?: number
  stream(opts: ProviderStreamOptions): AsyncIterable<ProviderEvent>
}

// ---------- Retry ----------

/**
 * Política opcional de reintentos para llamadas al provider.
 * Sólo reintenta errores transientes clasificables (HTTP 429, 5xx, timeouts
 * de red, streams cortados antes de cualquier chunk). Si el provider ya
 * emitió eventos en el intento actual, no se reintenta (evitamos duplicar
 * texto streameado al consumidor).
 *
 * Default cuando se omite la opción: no hay reintentos — los errores
 * propagan y la sesión cierra con `session_end: error`.
 */
export interface RetryPolicy {
  /** Cantidad total de intentos (incluye el primero). `1` o `<=1` deshabilita reintentos. */
  maxAttempts: number
  /** Delay base en ms para backoff exponencial. Default: 500. */
  baseDelayMs?: number
  /** Tope máximo del delay por intento. Default: 10_000. */
  maxDelayMs?: number
  /** Si suma jitter aleatorio al delay (recomendado). Default: true. */
  jitter?: boolean
}

// ---------- Agent events (bus) ----------

export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'assistant_message'; message: Message }
  | { type: 'tool_execution_start'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_execution_end'; toolUseId: string; name: string; output: string; isError: boolean; durationMs: number }
  | { type: 'provider_retry'; attempt: number; maxAttempts: number; delayMs: number; error: unknown }
  | { type: 'turn_end'; turn: number; stopReason: StopReason; usage?: TokenUsage }
  | { type: 'session_end'; reason: 'completed' | 'aborted' | 'error'; error?: unknown }

export type AgentEventListener = (event: AgentEvent) => void

// ---------- Logger ----------

export interface Logger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
