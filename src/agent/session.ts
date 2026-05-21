import { ToolRegistry } from '../tools/registry.js'
import { buildSystemPrompt } from '../prompt/system.js'
import { runLoop } from './loop.js'
import { EventBus } from './events.js'
import { noopLogger } from '../types.js'
import { SessionManager } from './sessionManager.js'
import { createNoopExecutor } from '../executor/types.js'
import type { Executor } from '../executor/types.js'
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
} from '../types.js'

export interface CreateAgentSessionOptions {
  provider: Provider
  cwd?: string
  tools?: Tool[]
  systemPrompt?: string
  appendSystemPrompt?: string
  contextFiles?: string[]
  logger?: Logger
  maxTurns?: number
  sessionId?: string
  sessionManager?: SessionManager
  hooks?: SessionHooks
  fileReader?: (path: string) => Promise<string | null>
  contextOptimizer?: ContextOptimizerOptions | boolean
  /**
   * Política opcional de reintentos para errores transientes del provider
   * (HTTP 429, 5xx, timeouts de red, streams sin chunks). Opt-in: si se
   * omite, los errores propagan y la sesión cierra con `session_end: error`.
   */
  retry?: RetryPolicy
  /**
   * Backend de ejecución de comandos shell para el bashTool (y derivados).
   * Default: un executor noop que falla con error claro si una tool intenta
   * usarlo. En Node, `createNodeAgentSession` lo override por LocalExecutor.
   * Para ejecución aislada usá `DockerExecutor` o pasá uno custom.
   */
  executor?: Executor
}

export interface AgentSession {
  readonly id: string
  readonly provider: Provider
  readonly registry: ToolRegistry
  readonly cwd: string
  getMessages(): Message[]
  /**
   * Devuelve el acumulado de tokens consumidos por esta sesión a lo largo
   * de todos los turnos. Sin pricing — sólo conteo crudo. Si ningún provider
   * reportó usage todavía, devuelve ceros.
   */
  getUsage(): TokenUsage
  subscribe(listener: AgentEventListener): () => void
  registerTool(tool: Tool): void
  prompt(text: string, opts?: { abortSignal?: AbortSignal }): Promise<Message>
  abort(reason?: unknown): void
}

/**
 * Crea una sesión del agente. Esta es la API pública principal del SDK.
 * Es async porque carga el estado persistido del `sessionManager` (si hay)
 * antes de devolver la sesión: al `await` esta función ya podés `subscribe`,
 * `getMessages` y `prompt` sin sorpresas.
 *
 * No es un singleton: podés tener múltiples sesiones independientes en paralelo.
 */
export async function createAgentSession(opts: CreateAgentSessionOptions): Promise<AgentSession> {
  const cwd = opts.cwd ?? (typeof process !== 'undefined' ? process.cwd() : '/')
  const registry = new ToolRegistry()
  if (opts.tools) registry.registerMany(opts.tools)

  const useOptimizer = opts.contextOptimizer !== false
  let contextOptimizer: ContextOptimizerOptions | undefined = undefined
  if (useOptimizer) {
    if (typeof opts.contextOptimizer === 'object') {
      contextOptimizer = opts.contextOptimizer
    } else if (opts.provider.contextLimit) {
      contextOptimizer = {
        maxTokens: opts.provider.contextLimit,
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
  } catch (err) {
    logger.error('Failed to initialize session from manager:', err)
  }

  const saveState = async () => {
    try {
      await manager.save({
        id,
        parentId,
        messages: messages.slice(),
        metadata,
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
  bus.subscribe((event) => {
    if (event.type === 'turn_end' && event.usage) {
      sessionUsage.inputTokens += event.usage.inputTokens
      sessionUsage.outputTokens += event.usage.outputTokens
      if (typeof event.usage.cacheReadTokens === 'number') {
        sessionUsage.cacheReadTokens = (sessionUsage.cacheReadTokens ?? 0) + event.usage.cacheReadTokens
      }
      if (typeof event.usage.cacheCreationTokens === 'number') {
        sessionUsage.cacheCreationTokens = (sessionUsage.cacheCreationTokens ?? 0) + event.usage.cacheCreationTokens
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

  let activeCtrl: AbortController | null = null
  let systemPromptCache: string | null = null
  const getSystemPrompt = async () => {
    if (systemPromptCache) return systemPromptCache
    systemPromptCache = await buildSystemPrompt({
      cwd,
      systemPrompt: opts.systemPrompt,
      appendSystemPrompt: opts.appendSystemPrompt,
      contextFiles: opts.contextFiles,
      fileReader: opts.fileReader,
    })
    return systemPromptCache
  }

  return {
    id,
    provider: opts.provider,
    registry,
    cwd,
    getMessages: () => messages.slice(),
    getUsage: () => ({ ...sessionUsage }),
    subscribe: (l) => bus.subscribe(l),
    registerTool: (t) => registry.register(t),
    abort(reason) {
      activeCtrl?.abort(reason)
    },
    async prompt(text, promptOpts) {
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

      try {
        const result = await runLoop({
          provider: opts.provider,
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
        })
        bus.emit({ type: 'session_end', reason: 'completed' })
        await saveState()
        return result
      } catch (err) {
        const aborted = (err as { name?: string }).name === 'AbortError'
        bus.emit({
          type: 'session_end',
          reason: aborted ? 'aborted' : 'error',
          error: aborted ? undefined : err,
        })
        await saveState()
        throw err
      } finally {
        if (activeCtrl === ctrl) activeCtrl = null
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
      }
    },
  }
}
