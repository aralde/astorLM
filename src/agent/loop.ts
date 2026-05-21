import type { EventBus } from './events.js'
import type { ToolRegistry } from '../tools/registry.js'
import type {
  ContentBlock,
  Message,
  Provider,
  ToolContext,
  ToolResultBlock,
  ToolUseBlock,
  SessionHooks,
  ContextOptimizerOptions,
  RetryPolicy,
} from '../types.js'
import { optimizeContext, estimateTokens } from './optimizer.js'
import { streamWithRetry } from './retry.js'

export interface RunLoopOptions {
  provider: Provider
  registry: ToolRegistry
  bus: EventBus
  messages: Message[]
  systemPrompt: string
  cwd: string
  abortSignal: AbortSignal
  maxTurns?: number
  logger: ToolContext['logger']
  hooks?: SessionHooks
  contextOptimizer?: ContextOptimizerOptions
  retry?: RetryPolicy
}

const DEFAULT_MAX_TURNS = 25

/**
 * Bucle del agente. Cada "turno" = una llamada al provider + ejecución
 * de las tools que pidió. Termina cuando el provider devuelve `end_turn`
 * (no quedan tool_use pendientes) o se alcanza maxTurns o se aborta.
 */
export async function runLoop(opts: RunLoopOptions): Promise<Message> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
  let lastAssistant: Message | null = null

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts.abortSignal.aborted) throw new DOMException('Aborted', 'AbortError')

    if (opts.contextOptimizer) {
      const { messages: optimizedMessages, optimized } = optimizeContext(
        opts.messages,
        opts.systemPrompt,
        {
          maxTokens: opts.contextOptimizer.maxTokens,
          compressThreshold: opts.contextOptimizer.compressThreshold ?? 0.8,
          keepRecentTurns: opts.contextOptimizer.keepRecentTurns ?? 3,
          tokenCounter: opts.contextOptimizer.tokenCounter ?? estimateTokens,
        }
      )
      if (optimized) {
        opts.logger.info('Context optimized. Pruned/condensed messages to save tokens.')
        opts.messages.length = 0
        opts.messages.push(...optimizedMessages)
      }
    }

    if (opts.hooks?.beforeTurn) {
      await opts.hooks.beforeTurn({ turn, messages: opts.messages })
    }

    opts.bus.emit({ type: 'turn_start', turn })

    let assistantMessage: Message | null = null
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' = 'end_turn'

    let providerMessages = opts.messages
    let providerSystemPrompt = opts.systemPrompt

    if (opts.hooks?.beforeProviderCall) {
      const hookRes = await opts.hooks.beforeProviderCall({
        messages: providerMessages,
        systemPrompt: providerSystemPrompt,
      })
      providerMessages = hookRes.messages
      providerSystemPrompt = hookRes.systemPrompt
    }

    const stream = streamWithRetry({
      provider: opts.provider,
      streamOpts: {
        systemPrompt: providerSystemPrompt,
        messages: providerMessages,
        tools: opts.registry.toSchemas(),
        abortSignal: opts.abortSignal,
      },
      policy: opts.retry,
      bus: opts.bus,
      abortSignal: opts.abortSignal,
    })

    for await (const ev of stream) {
      switch (ev.type) {
        case 'text_delta':
          opts.bus.emit({ type: 'text_delta', text: ev.text })
          break
        case 'thinking_delta':
          opts.bus.emit({ type: 'thinking_delta', thinking: ev.thinking })
          break
        case 'message_end':
          assistantMessage = ev.assistantMessage
          stopReason = ev.stopReason
          break
        default:
          break
      }
    }

    if (!assistantMessage) {
      throw new Error('Provider terminó sin emitir message_end')
    }

    if (!assistantMessage.id) {
      assistantMessage.id = crypto.randomUUID()
    }
    opts.messages.push(assistantMessage)
    lastAssistant = assistantMessage
    opts.bus.emit({ type: 'assistant_message', message: assistantMessage })

    const toolUses = assistantMessage.content.filter(isToolUse)
    if (toolUses.length === 0 || stopReason === 'end_turn') {
      opts.bus.emit({ type: 'turn_end', turn, stopReason })
      if (opts.hooks?.afterTurn) {
        await opts.hooks.afterTurn({ turn, lastMessage: assistantMessage })
      }
      return assistantMessage
    }

    // Ejecutar tools en paralelo.
    const ctx: ToolContext = {
      cwd: opts.cwd,
      abortSignal: opts.abortSignal,
      logger: opts.logger,
    }

    const results = await Promise.all(
      toolUses.map(async (tu) => {
        opts.bus.emit({
          type: 'tool_execution_start',
          toolUseId: tu.id,
          name: tu.name,
          input: tu.input,
        })

        let authorize = true
        let mockResult: string | undefined = undefined

        if (opts.hooks?.beforeToolExecution) {
          const hookRes = await opts.hooks.beforeToolExecution({
            toolName: tu.name,
            input: tu.input,
            toolUseId: tu.id,
          })
          authorize = hookRes.authorize
          mockResult = hookRes.mockResult
        }

        let output: string
        let isError = false
        const started = performance.now()

        if (!authorize) {
          output = 'Execution rejected by user policy.'
          isError = true
        } else if (mockResult !== undefined) {
          output = mockResult
        } else {
          const res = await opts.registry.run(tu.name, tu.input, ctx)
          output = res.output
          isError = res.isError
        }

        const durationMs = performance.now() - started

        if (opts.hooks?.afterToolExecution) {
          output = await opts.hooks.afterToolExecution({
            toolName: tu.name,
            input: tu.input,
            output,
            durationMs,
          })
        }

        opts.bus.emit({
          type: 'tool_execution_end',
          toolUseId: tu.id,
          name: tu.name,
          output: output,
          isError: isError,
          durationMs: durationMs,
        })
        const block: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: tu.id,
          content: output,
          is_error: isError,
        }
        return block
      }),
    )

    opts.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: results as ContentBlock[],
    })
    opts.bus.emit({ type: 'turn_end', turn, stopReason })

    if (opts.hooks?.afterTurn) {
      await opts.hooks.afterTurn({ turn, lastMessage: assistantMessage })
    }
  }

  if (!lastAssistant) throw new Error('Loop terminó sin mensaje del assistant')
  return lastAssistant
}

function isToolUse(b: ContentBlock): b is ToolUseBlock {
  return b.type === 'tool_use'
}
