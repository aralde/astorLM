import { ToolRegistry } from '../tools/registry.js'
import { tool } from '../tools/index.js'
import { z } from 'zod'
import { buildSystemPrompt } from '../prompt/system.js'
import { compilePrompts } from '../prompt/compiler.js'
import type { PromptCompilerOptions } from '../prompt/types.js'
import { runLoop } from './loop.js'
import { isAbortError } from './retry.js'
import { EventBus } from './events.js'
import { noopLogger } from '../types.js'
import { SessionManager } from './sessionManager.js'
import { createNoopExecutor } from '../executor/types.js'
import type { Executor } from '../executor/types.js'
import { SkillRegistry } from '../skills/registry.js'
import { renderSkillsBlock } from '../skills/promptBlock.js'
import { createLoadSkillTool } from '../skills/loadTool.js'
import type { SkillSource, SkillMode } from '../skills/types.js'
import type {
  AgentEventListener,
  Logger,
  Message,
  Provider,
  Tool,
  SessionHooks,
  ContextOptimizerOptions,
  RetryPolicy,
  TokenUsage,
  AgentLoopPattern,
  PlanItem,
  HeartbeatOptions,
} from '../types.js'

/**
 * Configuration options for creating a new agent session.
 */
export interface CreateAgentOptions {
  /** The model provider (e.g., Anthropic, OpenAI). */
  provider: Provider
  /** The current working directory for the agent. Defaults to process.cwd() or '/'. */
  cwd?: string
  /** An array of tools to register to the agent's ToolRegistry. */
  tools?: Tool[]
  /** The base system prompt for the agent. */
  systemPrompt?: string
  /** Options for compiling the system prompt from modules. */
  promptCompiler?: PromptCompilerOptions
  /** Additional system prompt text appended to the base system prompt. */
  appendSystemPrompt?: string
  /** Paths to context files that will be included in the system prompt. */
  contextFiles?: string[]
  /** Logger instance for outputting debug and info messages. */
  logger?: Logger
  /** Maximum number of turns allowed in a single agent loop. */
  maxTurns?: number
  /** Custom identifier for this agent session. Defaults to a random UUID. */
  sessionId?: string
  /** Manager used for session persistence. Defaults to InMemorySessionManager. */
  sessionManager?: SessionManager
  /** Lifecycle hooks for the agent session. */
  hooks?: SessionHooks
  /** Custom file reader function used when reading context files. */
  fileReader?: (path: string) => Promise<string | null>
  /** Configuration for automatic context optimization, or boolean to toggle it. */
  contextOptimizer?: ContextOptimizerOptions | boolean
  /**
   * Política opcional de reintentos para errores transientes del modelo
   * (HTTP 429, 5xx, timeouts de red, streams sin chunks). Opt-in: si se
   * omite, los errores propagan y la sesión cierra con `session_end: error`.
   */
  retry?: RetryPolicy
  /**
   * Backend de ejecución de comandos shell para el bashTool (y derivados).
   * Default: un executor noop que falla con error claro si una tool intenta
   * usarlo. En Node, `createLocalAgent` lo override por LocalExecutor.
   * Para ejecución aislada usá `DockerExecutor` o pasá uno custom.
   */
  executor?: Executor
  /**
   * Skill sources made available to the agent. The session enumerates
   * each source at startup (calling `list()`), aggregates the result
   * into a SkillRegistry, and then either:
   *
   *   - `skillMode: 'on-demand'` (default) — exposes `{name, description}`
   *     in `<available-skills>` and auto-registers a `load_skill` tool
   *     the model invokes to materialise the full body.
   *   - `skillMode: 'all'` — pre-loads every body and inlines them into
   *     the system prompt. Cheaper at runtime, costlier in context.
   *   - `skillMode: 'filesystem'` — list paths only, the model reads
   *     SKILL.md with standard read tool.
   *
   * Conflicting names across sources throw at session creation.
   */
  skillSources?: SkillSource[]
  /** Default: `'on-demand'`. */
  skillMode?: SkillMode
  /** The execution pattern style for the agent loop. Defaults to 'REACT'. */
  pattern?: AgentLoopPattern
  /** Optional proactive heartbeat loop configuration. */
  heartbeat?: HeartbeatOptions
}

/**
 * Represents an active agent session capable of executing tasks,
 * managing conversational context, and interacting with tools.
 */
export interface Agent {
  /** The unique identifier of this agent session. */
  readonly id: string
  /** The provider used by this agent. */
  readonly provider: Provider
  /** The tool registry managing tools available to this agent. */
  readonly registry: ToolRegistry
  /** The current working directory for the agent. */
  readonly cwd: string
  /** The execution pattern style of this agent. */
  readonly pattern: AgentLoopPattern

  /**
   * Retrieves the current conversation messages for this session.
   * @returns An array of Message objects.
   */
  getMessages(): Message[]
  /**
   * Devuelve el acumulado de tokens consumidos por esta sesión a lo largo
   * de todos los turnos. Sin pricing — sólo conteo crudo. Si ningún modelo
   * reportó usage todavía, devuelve ceros.
   */
  getUsage(): TokenUsage
  /**
   * Registers a new tool to the agent's tool registry.
   * @param tool - The tool to register.
   */
  registerTool(tool: Tool): void
  /**
   * Runs the agent with the given user input, starting the agent loop.
   * @param input - The text input or an object containing the input string.
   * @param opts - Execution options such as an abort signal.
   * @returns A Promise resolving to the final message produced by the agent.
   */
  run(input: string | { input: string }, opts?: { abortSignal?: AbortSignal }): Promise<Message>
  /**
   * Forks the current agent session, creating a new session branch from the current or a specific state.
   * @param opts - Options for configuring the fork (e.g. `newSessionId`, `branchFromMessageId`).
   * @returns A Promise resolving to the newly forked Agent instance.
   */
  fork(opts?: { newSessionId?: string; branchFromMessageId?: string }): Promise<Agent>
  /**
   * Subscribes to events emitted by the agent (e.g., 'text', 'tool-start').
   * @param event - The event name to subscribe to.
   * @param listener - The callback function for the event.
   * @returns A function to unsubscribe from the event.
   */
  on(event: string, listener: (...args: any[]) => void): () => void
  /**
   * Aborts the current execution loop, if running.
   * @param reason - Optional reason for abortion.
   */
  abort(reason?: unknown): void
  /**
   * Starts the proactive heartbeat loop.
   * @param opts - Optional heartbeat configuration overrides.
   */
  startHeartbeat(opts?: HeartbeatOptions): void
  /**
   * Stops the active proactive heartbeat loop.
   */
  stopHeartbeat(): void
  /**
   * Returns the current plan items if in PLAN_EXECUTE mode.
   */
  getPlan(): PlanItem[]
}

/**
 * Creates an agent session. This is the main public API of the SDK.
 * It is async because it loads the persisted state from the `sessionManager` (if present)
 * before returning the agent: after `await`, you can immediately use `on`, `getMessages`,
 * and `run` without issues.
 *
 * This is not a singleton: you can have multiple independent agents running in parallel.
 *
 * @param opts - Options to configure the new agent.
 * @returns A Promise that resolves to the initialized Agent instance.
 */
export async function createAgent(opts: CreateAgentOptions): Promise<Agent> {
  const provider = opts.provider
  if (!provider) {
    throw new Error('createAgent requires a provider option.')
  }
  const cwd = opts.cwd ?? (typeof process !== 'undefined' ? process.cwd() : '/')
  const registry = new ToolRegistry()
  if (opts.tools) registry.registerMany(opts.tools)

  const pattern: AgentLoopPattern = opts.pattern ?? 'REACT'
  const plan: PlanItem[] = []
  // Short, sequential, never-reused ids ("1", "2", ...). UUIDs are hostile
  // to smaller models that have to echo the id back in update_plan_item.
  // Reassigned to the loaded plan length after the session manager restores
  // persisted state below.
  let planCounter = 0

  if (pattern === 'PLAN_EXECUTE') {
    const addPlanItemTool = tool({
      name: 'add_plan_item',
      description: 'Add a new task to the plan. Call it at the start of the session to map out the work.',
      schema: z.object({
        description: z.string().describe('Description of the task to perform')
      }),
      execute: async ({ description }) => {
        const itemId = String(++planCounter)
        plan.push({
          id: itemId,
          description,
          status: 'pending'
        })
        bus.emit({ type: 'plan_updated', plan: plan.slice() })
        return `Task added successfully with ID: ${itemId}`
      }
    })

    const updatePlanItemTool = tool({
      name: 'update_plan_item',
      description: 'Update the status of an existing plan task (pending, running, completed, failed).',
      schema: z.object({
        id: z.string().describe('The ID of the task to update'),
        status: z.enum(['pending', 'running', 'completed', 'failed']).describe('The new task status')
      }),
      execute: async ({ id: itemId, status }) => {
        const item = plan.find(i => i.id === itemId)
        if (!item) {
          return `Error: Plan item with ID ${itemId} not found.`
        }
        item.status = status
        bus.emit({ type: 'plan_updated', plan: plan.slice() })
        return `Task ${itemId} status updated to ${status}.`
      }
    })

    registry.register(addPlanItemTool)
    registry.register(updatePlanItemTool)
  }

  const useOptimizer = opts.contextOptimizer !== false
  let contextOptimizer: ContextOptimizerOptions | undefined = undefined
  if (useOptimizer) {
    if (typeof opts.contextOptimizer === 'object') {
      contextOptimizer = opts.contextOptimizer
    } else if (provider.contextLimit) {
      contextOptimizer = {
        maxTokens: provider.contextLimit,
      }
    }
  }

  const bus = new EventBus()
  const messages: Message[] = []
  const logger = opts.logger ?? noopLogger

  const manager = opts.sessionManager ?? SessionManager.inMemory()
  const id = opts.sessionId ?? crypto.randomUUID()

  let parentId: string | undefined = undefined
  let metadata: Record<string, unknown> = {}
  let createdAt = Date.now()

  // Inicialización: cargar (o crear) el estado del manager antes de devolver la sesión.
  try {
    let state = await manager.get(id)
    if (!state) {
      state = await manager.create({ id })
    }
    parentId = state.parentId
    metadata = state.metadata ?? {}
    createdAt = state.createdAt
    messages.push(...state.messages)
    // Restore the PLAN_EXECUTE plan persisted in metadata so it survives
    // resume and fork. Ids stay sequential: continue the counter from the
    // highest restored id.
    if (pattern === 'PLAN_EXECUTE' && Array.isArray(metadata.plan)) {
      plan.push(...(metadata.plan as PlanItem[]))
      planCounter = plan.reduce((max, i) => Math.max(max, Number(i.id) || 0), 0)
    }
  } catch (err) {
    logger.error('Failed to initialize session from manager:', err)
  }

  const saveState = async () => {
    try {
      await manager.save({
        id,
        parentId,
        messages: messages.slice(),
        metadata:
          pattern === 'PLAN_EXECUTE' ? { ...metadata, plan: plan.slice() } : metadata,
        createdAt,
        updatedAt: Date.now(),
      })
    } catch (err) {
      logger.error('Failed to save session state:', err)
    }
  }

  // Acumulador de tokens por sesión. Se alimenta de los `turn_end` que
  // emite el loop con el usage reportado por el provider. Mantener acá
  // (y no en el loop) permite que sobreviva entre `prompt()` sucesivos.
  const sessionUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let sessionTurns = 0
  bus.subscribe((event) => {
    if (event.type === 'turn_end') {
      sessionTurns++
      if (event.usage) {
        sessionUsage.inputTokens += event.usage.inputTokens
        sessionUsage.outputTokens += event.usage.outputTokens
        if (typeof event.usage.cacheReadTokens === 'number') {
          sessionUsage.cacheReadTokens = (sessionUsage.cacheReadTokens ?? 0) + event.usage.cacheReadTokens
        }
        if (typeof event.usage.cacheCreationTokens === 'number') {
          sessionUsage.cacheCreationTokens = (sessionUsage.cacheCreationTokens ?? 0) + event.usage.cacheCreationTokens
        }
      }
    }
  })

  // Subscribe to the bus to auto-save state
  bus.subscribe((event) => {
    if (
      event.type === 'assistant_message' ||
      event.type === 'turn_end' ||
      event.type === 'session_end'
    ) {
      // Fire-and-forget background save
      saveState()
    }
  })

  const executor: Executor = opts.executor ?? createNoopExecutor()

  // Skills: build the registry once, then dispatch on the selected
  // mode. Each mode has a different deal with the model:
  //
  //   - 'on-demand': meta-tool. We register `load_skill` and the model
  //     calls it when it wants a body. Elegant; fragile on small models.
  //   - 'all': no tools. We inline every body into the system prompt at
  //     init time. Cheapest at runtime; eats context.
  //   - 'filesystem': canonical pattern (Claude Code / Codex / Gemini).
  //     We list paths only; the model reads SKILL.md with the standard
  //     `read` tool that already lives in the registry. Robust across
  //     models because there is no meta-step to reason about.
  const skillMode: SkillMode = opts.skillMode ?? 'on-demand'
  const skillRegistry = new SkillRegistry(opts.skillSources ?? [])
  await skillRegistry.init()
  let skillsBlock = ''
  if (skillRegistry.size > 0) {
    if (skillMode === 'filesystem') {
      // Hard precondition: every available skill must expose a path.
      // Mixing FS skills with in-memory ones in this mode is a config
      // error — fail at session creation, not mid-turn.
      const pathless = skillRegistry.list().filter((s) => !s.path)
      if (pathless.length > 0) {
        const offenders = pathless.map((s) => `"${s.name}" (source "${s.source}")`).join(', ')
        throw new Error(
          `skillMode: 'filesystem' requires every skill to expose a filesystem path; ` +
            `the following skills do not: ${offenders}. ` +
            `Use createFileSystemSkillSource for these skills, or pick another mode.`,
        )
      }
      skillsBlock = renderSkillsBlock(skillRegistry.list(), 'filesystem')
      // No meta-tool registered: the agent will reach for SKILL.md via
      // its own `read` tool. The consumer is responsible for making sure
      // such a tool exists in the session — `createCodingTools()` and
      // `createReadOnlyTools()` both include it.
    } else if (skillMode === 'on-demand') {
      skillsBlock = renderSkillsBlock(skillRegistry.list(), 'on-demand')
      // Register the load tool only when there is at least one skill —
      // exposing an unusable tool would just waste context.
      if (!registry.has('load_skill')) {
        registry.register(createLoadSkillTool(skillRegistry))
      }
    } else {
      const loaded = await skillRegistry.loadAll()
      skillsBlock = renderSkillsBlock(loaded, 'all')
    }
  }

  let activeCtrl: AbortController | null = null
  let systemPromptCache: string | null = null
  const getSystemPrompt = async () => {
    if (systemPromptCache) return systemPromptCache

    if (opts.promptCompiler) {
      const { report } = compilePrompts(opts.promptCompiler)
      if (report.conflicts.length > 0) {
        for (const conflict of report.conflicts) {
          const msg = `[Prompt Compiler] ${conflict.severity.toUpperCase()} - ${conflict.description} (Modules: ${conflict.moduleIds.join(', ')})`
          if (conflict.severity === 'high') {
            logger.error(msg)
          } else {
            logger.warn(msg)
          }
        }
      }
      logger.info(`[Prompt Compiler] System prompt compiled successfully (${report.tokenEstimate} estimated tokens).`)
    }

    systemPromptCache = await buildSystemPrompt({
      cwd,
      systemPrompt: opts.systemPrompt,
      promptCompiler: opts.promptCompiler,
      appendSystemPrompt: opts.appendSystemPrompt,
      contextFiles: opts.contextFiles,
      fileReader: opts.fileReader,
      skillsBlock,
    })
    return systemPromptCache
  }

  let isRunning = false
  let heartbeatIntervalId: any = null
  let heartbeatTimeoutId: any = null
  let activeHeartbeatOpts = opts.heartbeat

  function startHeartbeat(heartbeatOpts?: HeartbeatOptions) {
    if (heartbeatOpts) {
      activeHeartbeatOpts = heartbeatOpts
    }
    stopHeartbeat()
    if (!activeHeartbeatOpts) {
      logger.warn('startHeartbeat called but no heartbeat options were configured or passed.')
      return
    }

    let tickCount = 0
    const intervalMs = activeHeartbeatOpts.intervalMs

    const timeoutMs = activeHeartbeatOpts.timeoutMs ?? 300000 // default 5 minutes
    if (timeoutMs > 0 && timeoutMs !== Infinity) {
      heartbeatTimeoutId = setTimeout(() => {
        logger.info('Heartbeat stopped automatically due to timeout.')
        stopHeartbeat()
      }, timeoutMs)
    }

    heartbeatIntervalId = setInterval(async () => {
      if (isRunning) {
        // Discard heartbeat tick if agent is already running
        return
      }

      if (activeHeartbeatOpts!.maxTicks) {
        tickCount++
        if (tickCount > activeHeartbeatOpts!.maxTicks) {
          stopHeartbeat()
          return
        }
      }

      if (activeHeartbeatOpts!.localCondition) {
        try {
          const shouldRun = await activeHeartbeatOpts!.localCondition(cwd)
          if (!shouldRun) {
            // Latent trigger condition not met, skip calling the LLM
            return
          }
        } catch (err) {
          logger.error('Error executing local heartbeat condition:', err)
          return
        }
      }

      const checkPrompt = activeHeartbeatOpts!.checkPrompt
      bus.emit({ type: 'heartbeat_tick', checkPrompt })
      const ctrl = new AbortController()
      // Per-tick run timeout, decoupled from the interval. The isRunning guard
      // already prevents overlapping ticks, so this is only a safety net for a
      // hung run — keep it generous so slow (but valid) model turns can finish.
      const runTimeoutMs = activeHeartbeatOpts!.runTimeoutMs ?? 60000
      const timer = setTimeout(() => ctrl.abort(), runTimeoutMs)
      try {
        await run(checkPrompt, { abortSignal: ctrl.signal })
      } catch (err) {
        if (ctrl.signal.aborted || isAbortError(err)) {
          logger.warn('Heartbeat run timed out and was aborted.')
        } else {
          logger.error('Error during heartbeat execution:', err)
        }
      } finally {
        clearTimeout(timer)
      }
    }, intervalMs)
  }

  function stopHeartbeat() {
    if (heartbeatIntervalId) {
      clearInterval(heartbeatIntervalId)
      heartbeatIntervalId = null
    }
    if (heartbeatTimeoutId) {
      clearTimeout(heartbeatTimeoutId)
      heartbeatTimeoutId = null
    }
  }

  // Auto-start heartbeat if configured at creation and not explicitly disabled
  if (activeHeartbeatOpts && activeHeartbeatOpts.autoStart !== false) {
    startHeartbeat()
  }

  async function run(input: string | { input: string }, promptOpts?: { abortSignal?: AbortSignal }): Promise<Message> {
    if (isRunning) {
      throw new Error('Agent is already running a task.')
    }
    isRunning = true

    const text = typeof input === 'string' ? input : input.input
    const externalSignal = promptOpts?.abortSignal
    const ctrl = new AbortController()
    activeCtrl = ctrl
    const onExternalAbort = () => ctrl.abort(externalSignal?.reason)
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort(externalSignal.reason)
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }

    messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
    })
    await saveState()

    const previousTurns = sessionTurns
    try {
      const result = await runLoop({
        provider,
        registry,
        bus,
        messages,
        systemPrompt: await getSystemPrompt(),
        cwd,
        abortSignal: ctrl.signal,
        maxTurns: opts.maxTurns,
        logger,
        hooks: opts.hooks,
        contextOptimizer,
        retry: opts.retry,
        executor,
        sessionUsage,
        previousTurns,
        pattern,
        plan,
      })
      bus.emit({ type: 'session_end', reason: 'completed' })
      await saveState()
      return result
    } catch (err) {
      const aborted = ctrl.signal.aborted || isAbortError(err)
      bus.emit({
        type: 'session_end',
        reason: aborted ? 'aborted' : 'error',
        error: aborted ? undefined : err,
      })
      await saveState()
      throw err
    } finally {
      isRunning = false
      if (activeCtrl === ctrl) activeCtrl = null
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
    }
  }

  return {
    id,
    provider,
    registry,
    cwd,
    pattern,
    getMessages: () => messages.slice(),
    getUsage: () => ({ ...sessionUsage }),
    registerTool: (t) => registry.register(t),
    abort(reason) {
      activeCtrl?.abort(reason)
    },
    run,
    async fork(forkOpts) {
      const childState = await manager.create({
        id: forkOpts?.newSessionId,
        parentId: id,
        branchFromMessageId: forkOpts?.branchFromMessageId,
      })
      return createAgent({
        ...opts,
        sessionId: childState.id,
      })
    },
    on(event: string, listener: (...args: any[]) => void): () => void {
      return bus.subscribe((e) => {
        if (event === 'event') {
          listener(e)
        } else if (event === 'text' && e.type === 'text_delta') {
          listener(e.text)
        } else if (event === 'thinking' && e.type === 'thinking_delta') {
          listener(e.thinking)
        } else if (event === 'tool-start' && e.type === 'tool_execution_start') {
          listener({ name: e.name, input: e.input })
        } else if (event === 'tool-end' && e.type === 'tool_execution_end') {
          listener({ name: e.name, output: e.output, isError: e.isError })
        } else if (event === 'error' && e.type === 'session_end' && e.reason === 'error') {
          listener(e.error)
        }
      })
    },
    startHeartbeat,
    stopHeartbeat,
    getPlan: () => plan.slice(),
  }
}

