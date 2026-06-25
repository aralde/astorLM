/**
 * Public type surface for the agent library.
 *
 * Messages and blocks follow Anthropic's "content blocks" model:
 * an assistant message may contain text + tool_use; a user message may
 * contain text + tool_result. This makes it easy to model the loop
 * without losing intermediate information.
 */

import type { Executor } from './executor/types.js'

export type AgentLoopPattern = 'REACT' | 'PLAN_EXECUTE'

export interface PlanItem {
  id: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'failed'
}

export interface HeartbeatOptions {
  intervalMs: number
  checkPrompt: string
  /**
   * Optional local TypeScript condition that enables the Latent Heartbeat.
   * When defined, each tick runs this function locally and ONLY calls the LLM
   * if it returns true. Keeps token cost at zero until the trigger fires.
   */
  localCondition?: (cwd: string) => boolean | Promise<boolean>
  /**
   * Maximum time in milliseconds the heartbeat may run in the background.
   * Once elapsed, the heartbeat stops automatically. Defaults to 300000
   * (5 minutes) to avoid runaway loops. Set to Infinity or 0 to disable
   * the time limit.
   */
  timeoutMs?: number
  /**
   * Maximum number of ticks to run before stopping automatically.
   */
  maxTicks?: number
  /**
   * Per-tick run timeout in milliseconds. Each heartbeat tick aborts its
   * in-flight `run()` after this long. Decoupled from `intervalMs`: the
   * `isRunning` guard already prevents overlapping ticks, so this only acts as
   * a safety net for a hung run. Defaults to 60000 (60s) — keep it above the
   * model's typical turn latency so slow but valid runs are not cut short.
   */
  runTimeoutMs?: number
  /**
   * When false, prevents the heartbeat from auto-starting at agent creation
   * even if it was provided in the initial options. Defaults to true.
   */
  autoStart?: boolean
}

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

/** Reason why the provider ended a turn. */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'

// ---------- Tools ----------

export interface ToolContext {
  cwd: string
  abortSignal: AbortSignal
  logger: Logger
  /**
   * Shell command execution backend. Injected by the session. The bashTool
   * (and derivatives: bash_spawn, bash_get_output, bash_kill) delegate here
   * instead of talking to `child_process` directly, which allows swapping the
   * backend (local, container, remote) without touching the tools.
   */
  executor: Executor
}

/**
 * A registered tool. The input type lives **inside** the `defineTool` closure
 * (parseInput validates and casts); the public contract is uniform so that a
 * `Tool` can be freely stored in arrays/registry without breaking variance.
 */
export interface Tool {
  name: string
  description: string
  /** JSON Schema sent to the provider. */
  inputSchema: Record<string, unknown>
  /** Validates and parses raw input coming from the model. */
  parseInput: (raw: unknown) => unknown
  execute: (input: unknown, ctx: ToolContext) => Promise<string>
}

// ---------- Session Hooks ----------

export interface SessionHooks {
  beforeTurn?: (context: {
    turn: number
    accumulatedTurns: number
    messages: Message[]
    sessionUsage: TokenUsage
    cwd: string
    bus?: { emit: (event: AgentEvent) => void }
  }) => Promise<void>
  beforeProviderCall?: (context: {
    messages: Message[]
    systemPrompt: string
    tools: Array<Pick<Tool, 'name' | 'description' | 'inputSchema'>>
    cwd: string
    bus?: { emit: (event: AgentEvent) => void }
  }) => Promise<{
    messages: Message[]
    systemPrompt: string
    tools?: Array<Pick<Tool, 'name' | 'description' | 'inputSchema'>>
  }>
  beforeToolExecution?: (context: {
    toolName: string
    input: unknown
    toolUseId: string
    cwd: string
    bus?: { emit: (event: AgentEvent) => void }
  }) => Promise<{ authorize: boolean; mockResult?: string; steer?: boolean; feedback?: string }>
  afterToolExecution?: (context: {
    toolName: string
    input: unknown
    output: string
    durationMs: number
    isError: boolean
    cwd: string
    bus?: { emit: (event: AgentEvent) => void }
  }) => Promise<string>
  afterTurn?: (context: {
    turn: number
    lastMessage: Message
    cwd: string
    bus?: { emit: (event: AgentEvent) => void }
  }) => Promise<void>
}

// ---------- Context Optimizer ----------

export interface ContextOptimizerOptions {
  maxTokens: number
  compressThreshold?: number
  keepRecentTurns?: number
  tokenCounter?: (messages: Message[], systemPrompt: string) => number
}

// ---------- Provider ----------

/**
 * Request for typed output from the provider (structured output — forcing the
 * model's response to satisfy a JSON Schema). Each provider maps it to its
 * native mechanism:
 *   - OpenAI / OpenAI-compatible → `response_format: { type: 'json_schema' }`
 *     (constrained decoding: the model cannot emit tokens outside the schema).
 *   - Providers without native support → ignore it; the guarantee falls on the
 *     prompt and on the consumer's validation + retries (see `generateObject`).
 *
 * Only applies when tools are NOT sent in the same call: `response_format` and
 * `tool_choice` do not coexist reliably. The "output as a terminal tool"
 * pattern (`generateObject` in `'tool'` mode) covers the case with tools.
 */
export interface OutputFormat {
  /** Schema name (e.g. "sentiment_result"). */
  name: string
  /** JSON Schema the response must satisfy. */
  schema: Record<string, unknown>
  /** Provider strict mode (OpenAI `strict: true`). Default: true. */
  strict?: boolean
}

export interface ProviderStreamOptions {
  systemPrompt: string
  messages: Message[]
  tools: Array<Pick<Tool, 'name' | 'description' | 'inputSchema'>>
  abortSignal: AbortSignal
  maxTokens?: number
  /** Optional typed output (structured output). See {@link OutputFormat}. */
  outputFormat?: OutputFormat
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

/**
 * Raw token count reported by the provider for a single call.
 * No pricing or USD conversion — the consumer computes cost if it wants.
 * `cacheReadTokens` / `cacheCreationTokens` stay optional because not all
 * providers expose them (Anthropic does; OpenAI only `cached_tokens` when the
 * model caches automatically; many OpenAI-compat servers return nothing).
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

// ---------- Retry ----------

/**
 * Optional retry policy for provider calls.
 * Only retries classifiable transient errors (HTTP 429, 5xx, network timeouts,
 * streams cut before any chunk). If the provider already emitted events in the
 * current attempt, it is not retried (we avoid duplicating text already
 * streamed to the consumer).
 *
 * Default when the option is omitted: no retries — errors propagate and the
 * session closes with `session_end: error`.
 */
export interface RetryPolicy {
  /** Total number of attempts (includes the first). `1` or `<=1` disables retries. */
  maxAttempts: number
  /** Base delay in ms for exponential backoff. Default: 500. */
  baseDelayMs?: number
  /** Maximum cap on the per-attempt delay. Default: 10_000. */
  maxDelayMs?: number
  /** Whether to add random jitter to the delay (recommended). Default: true. */
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
  | { type: 'user_steering'; toolUseId: string; feedback: string }
  | { type: 'turn_end'; turn: number; stopReason: StopReason; usage?: TokenUsage }
  | { type: 'session_end'; reason: 'completed' | 'aborted' | 'error'; error?: unknown }
  | { type: 'contract_violation'; rule: string; details: string }
  | { type: 'heartbeat_tick'; checkPrompt: string }
  | { type: 'plan_updated'; plan: PlanItem[] }

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
