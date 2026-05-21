/**
 * Public type surface for the agent library.
 *
 * Mensajes y bloques siguen el modelo de "content blocks" de Anthropic:
 * un mensaje del assistant puede contener texto + tool_use; un mensaje del
 * user puede contener texto + tool_result. Esto facilita modelar el loop
 * sin perder información intermedia.
 */

export type Role = 'user' | 'assistant' | 'system'

export type TextBlock = { type: 'text'; text: string }
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

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

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

// ---------- Provider ----------

export interface ProviderStreamOptions {
  systemPrompt: string
  messages: Message[]
  tools: Array<Pick<Tool, 'name' | 'description' | 'inputSchema'>>
  abortSignal: AbortSignal
  maxTokens?: number
}

export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input'; id: string; inputJsonDelta: string }
  | { type: 'tool_use_end'; id: string; name: string; input: unknown }
  | { type: 'message_end'; stopReason: StopReason; assistantMessage: Message }

export interface Provider {
  readonly name: string
  readonly model: string
  stream(opts: ProviderStreamOptions): AsyncIterable<ProviderEvent>
}

// ---------- Agent events (bus) ----------

export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; text: string }
  | { type: 'assistant_message'; message: Message }
  | { type: 'tool_execution_start'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_execution_end'; toolUseId: string; name: string; output: string; isError: boolean; durationMs: number }
  | { type: 'turn_end'; turn: number; stopReason: StopReason }
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
