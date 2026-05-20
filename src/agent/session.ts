import { randomUUID } from 'node:crypto'
import { ToolRegistry } from '../tools/registry.js'
import { buildSystemPrompt } from '../prompt/system.js'
import { runLoop } from './loop.js'
import { EventBus } from './events.js'
import { noopLogger } from '../types.js'
import { SessionManager } from './sessionManager.js'
import type {
  AgentEventListener,
  Logger,
  Message,
  Provider,
  Tool,
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
}

export interface AgentSession {
  readonly id: string
  readonly initPromise: Promise<void>
  readonly provider: Provider
  readonly registry: ToolRegistry
  readonly cwd: string
  getMessages(): Message[]
  subscribe(listener: AgentEventListener): () => void
  registerTool(tool: Tool): void
  prompt(text: string, opts?: { abortSignal?: AbortSignal }): Promise<Message>
  abort(reason?: unknown): void
}

/**
 * Crea una sesión del agente. Esta es la API pública principal del SDK.
 * No es un singleton: podés tener múltiples sesiones independientes en paralelo.
 */
export function createAgentSession(opts: CreateAgentSessionOptions): AgentSession {
  const cwd = opts.cwd ?? process.cwd()
  const registry = new ToolRegistry()
  if (opts.tools) registry.registerMany(opts.tools)

  const bus = new EventBus()
  const messages: Message[] = []
  const logger = opts.logger ?? noopLogger

  const manager = opts.sessionManager ?? SessionManager.inMemory()
  const id = opts.sessionId ?? randomUUID()

  let parentId: string | undefined = undefined
  let metadata: Record<string, unknown> = {}
  let createdAt = Date.now()

  // Initialize asynchronously in the background
  const initPromise = (async () => {
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
  })()

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

  let activeCtrl: AbortController | null = null
  let systemPromptCache: string | null = null
  const getSystemPrompt = async () => {
    if (systemPromptCache) return systemPromptCache
    systemPromptCache = await buildSystemPrompt({
      cwd,
      systemPrompt: opts.systemPrompt,
      appendSystemPrompt: opts.appendSystemPrompt,
      contextFiles: opts.contextFiles,
    })
    return systemPromptCache
  }

  return {
    id,
    initPromise,
    provider: opts.provider,
    registry,
    cwd,
    getMessages: () => messages.slice(),
    subscribe: (l) => bus.subscribe(l),
    registerTool: (t) => registry.register(t),
    abort(reason) {
      activeCtrl?.abort(reason)
    },
    async prompt(text, promptOpts) {
      await initPromise

      const externalSignal = promptOpts?.abortSignal
      const ctrl = new AbortController()
      activeCtrl = ctrl
      const onExternalAbort = () => ctrl.abort(externalSignal?.reason)
      if (externalSignal) {
        if (externalSignal.aborted) ctrl.abort(externalSignal.reason)
        else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
      }

      messages.push({
        id: randomUUID(),
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
