import { ToolRegistry } from '../tools/registry.js'
import { buildSystemPrompt } from '../prompt/system.js'
import { runLoop } from './loop.js'
import { EventBus } from './events.js'
import { noopLogger } from '../types.js'
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
}

export interface AgentSession {
  readonly provider: Provider
  readonly registry: ToolRegistry
  readonly cwd: string
  getMessages(): Message[]
  subscribe(listener: AgentEventListener): () => void
  registerTool(tool: Tool): void
  prompt(text: string, opts?: { abortSignal?: AbortSignal }): Promise<Message>
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
    provider: opts.provider,
    registry,
    cwd,
    getMessages: () => messages.slice(),
    subscribe: (l) => bus.subscribe(l),
    registerTool: (t) => registry.register(t),
    async prompt(text, promptOpts) {
      const externalSignal = promptOpts?.abortSignal
      const ctrl = new AbortController()
      const onExternalAbort = () => ctrl.abort(externalSignal?.reason)
      if (externalSignal) {
        if (externalSignal.aborted) ctrl.abort(externalSignal.reason)
        else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
      }

      messages.push({ role: 'user', content: [{ type: 'text', text }] })

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
        return result
      } catch (err) {
        const aborted = (err as { name?: string }).name === 'AbortError'
        bus.emit({
          type: 'session_end',
          reason: aborted ? 'aborted' : 'error',
          error: aborted ? undefined : err,
        })
        throw err
      } finally {
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
      }
    },
  }
}
