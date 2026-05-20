// API pública del SDK.
export { createAgentSession } from './agent/session.js'
export type { AgentSession, CreateAgentSessionOptions } from './agent/session.js'
export { SessionManager, InMemorySessionManager, FileSessionManager } from './agent/sessionManager.js'
export type { SessionState, CreateSessionOptions } from './agent/sessionManager.js'
export { AstorAgent } from './agent/facade.js'
export type { AstorAgentOptions, AstorOutputMode } from './agent/facade.js'

export {
  defineTool,
  ToolRegistry,
  createCodingTools,
  createReadOnlyTools,
  readTool,
  writeTool,
  editTool,
  bashTool,
  lsTool,
  grepTool,
  globTool,
} from './tools/index.js'

export { AnthropicProvider } from './provider/anthropic.js'
export type { AnthropicProviderOptions } from './provider/anthropic.js'
export { OpenAIProvider } from './provider/openai.js'
export type { OpenAIProviderOptions } from './provider/openai.js'

export { mountMcpServer } from './mcp/client.js'
export type { MountMcpServerOptions, MountedMcpServer, McpTransportConfig } from './mcp/client.js'

export { AuthStorage } from './auth/storage.js'
export { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT } from './prompt/system.js'
export { EventBus } from './agent/events.js'

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
  AgentEventListener,
  Logger,
  Role,
} from './types.js'
