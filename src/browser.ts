// Browser-safe entry point: the agent loop, providers, tools API and the WASM
// code runner. Imports no `node:*` module, directly or transitively.

export { createAgent } from './agent/session.js'
export type { Agent, CreateAgentOptions } from './agent/session.js'
export { SessionManager, InMemorySessionManager } from './agent/sessionManager.js'
export type { SessionState, CreateSessionOptions } from './agent/sessionManager.js'
export { EventBus } from './agent/events.js'

export { tool } from './tools/define.js'
export type { ToolOptions } from './tools/define.js'
export { ToolRegistry } from './tools/registry.js'

export { AnthropicProvider } from './provider/anthropic.js'
export type { AnthropicProviderOptions } from './provider/anthropic.js'
export { OpenAIProvider } from './provider/openai.js'
export type { OpenAIProviderOptions } from './provider/openai.js'

export { createNoopExecutor } from './executor/types.js'

export { QuickJsCodeRunner, createCodeRunnerTool } from './experimental/wasm-runner/index.js'
export type {
  QuickJsCodeRunnerOptions,
  CreateCodeRunnerToolOptions,
  CodeRunner,
  RunCodeOptions,
  RunCodeResult,
} from './experimental/wasm-runner/index.js'

export type {
  Tool,
  ToolContext,
  Provider,
  ProviderEvent,
  ProviderStreamOptions,
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  StopReason,
  AgentEvent,
} from './types.js'
