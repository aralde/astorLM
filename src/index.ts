// Public SDK surface (core, runtime-agnostic).
// Experimental modules are imported from dedicated subpaths, e.g.:
//   import { createErrorRegistry } from 'astorlm/experimental/error-registry'
// Never from this main barrel — the subpath itself signals volatility.

export { createAgentSession } from './agent/session.js'
export type { AgentSession, CreateAgentSessionOptions } from './agent/session.js'
export { SessionManager, InMemorySessionManager } from './agent/sessionManager.js'
export type { SessionState, CreateSessionOptions } from './agent/sessionManager.js'

export { defineTool } from './tools/define.js'
export { ToolRegistry } from './tools/registry.js'

export { AnthropicProvider } from './provider/anthropic.js'
export type { AnthropicProviderOptions } from './provider/anthropic.js'
export { OpenAIProvider } from './provider/openai.js'
export type { OpenAIProviderOptions } from './provider/openai.js'

export { AuthStorage } from './auth/storage.js'
export { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT } from './prompt/system.js'
export { EventBus } from './agent/events.js'
export { estimateTokens, optimizeContext } from './agent/optimizer.js'

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
  SessionHooks,
  ContextOptimizerOptions,
  RetryPolicy,
  TokenUsage,
} from './types.js'

export { isTransientError, computeBackoffDelay } from './agent/retry.js'

export {
  SkillRegistry,
  createInMemorySkillSource,
  parseSkillFrontmatter,
  renderSkillsBlock,
  createLoadSkillTool,
  validateSkillName,
  validateSkillDescription,
  validateSkillSpec,
  SkillValidationError,
  SKILL_VALIDATION_LIMITS,
} from './skills/index.js'
export type {
  Skill,
  SkillMetadata,
  SkillSource,
  SkillMode,
  InMemorySkillSourceOptions,
  ParsedFrontmatter,
} from './skills/index.js'

export { createNoopExecutor } from './executor/types.js'

export type {
  Executor,
  ExecResult,
  ExecOptions,
  SpawnOptions,
  SpawnHandle,
  ProcessStatus,
} from './executor/types.js'
