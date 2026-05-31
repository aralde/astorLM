// Public SDK surface.
// This barrel exports both the runtime-agnostic core and the Node-specific local runner.

export { createAgent } from './agent/session.js'
export type { Agent, CreateAgentOptions } from './agent/session.js'
export { createSubagentTool } from './agent/subagent.js'
export type { SubagentToolOptions } from './agent/subagent.js'
export { createSteeringController } from './agent/steering.js'
export type { SteeringController } from './agent/steering.js'
export { SessionManager, InMemorySessionManager } from './agent/sessionManager.js'
export type { SessionState, CreateSessionOptions } from './agent/sessionManager.js'

export { tool } from './tools/define.js'
export type { ToolOptions } from './tools/define.js'
export { ToolRegistry } from './tools/registry.js'

export { AnthropicProvider } from './provider/anthropic.js'
export type { AnthropicProviderOptions } from './provider/anthropic.js'
export { OpenAIProvider } from './provider/openai.js'
export type { OpenAIProviderOptions } from './provider/openai.js'

export { AuthStorage } from './auth/storage.js'
export { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT } from './prompt/system.js'
export { compilePrompts } from './prompt/compiler.js'
export type { PromptModule, PromptCompilerOptions, PromptCompilerConflict, PromptCompilerReport } from './prompt/types.js'
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
  AgentLoopPattern,
  PlanItem,
  HeartbeatOptions,
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
  parseAllowedTools,
  restrictToolsHook,
} from './skills/index.js'
export type {
  Skill,
  SkillMetadata,
  SkillSource,
  SkillMode,
  InMemorySkillSourceOptions,
  ParsedFrontmatter,
  RestrictToolsOptions,
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

// Re-export Node-specific local API for unified imports
export * from './core.js'
