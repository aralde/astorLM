import type { EventBus } from './events.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { Executor } from '../executor/types.js'
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
  TokenUsage,
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
  executor: Executor
  sessionUsage: TokenUsage
  previousTurns: number
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
      await opts.hooks.beforeTurn({
        turn,
        accumulatedTurns: opts.previousTurns + turn,
        messages: opts.messages,
        sessionUsage: opts.sessionUsage,
        cwd: opts.cwd,
        bus: opts.bus,
      })
    }

    opts.bus.emit({ type: 'turn_start', turn })

    let assistantMessage: Message | null = null
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' = 'end_turn'
    let turnUsage: TokenUsage | undefined = undefined

    let providerMessages = opts.messages
    let providerSystemPrompt = opts.systemPrompt
    let toolSchemas = opts.registry.toSchemas()

    if (opts.hooks?.beforeProviderCall) {
      const hookRes = await opts.hooks.beforeProviderCall({
        messages: providerMessages,
        systemPrompt: providerSystemPrompt,
        tools: toolSchemas,
        cwd: opts.cwd,
        bus: opts.bus,
      })
      providerMessages = hookRes.messages
      providerSystemPrompt = hookRes.systemPrompt
      if (hookRes.tools) {
        toolSchemas = hookRes.tools
      }
    }

    const stream = streamWithRetry({
      provider: opts.provider,
      streamOpts: {
        systemPrompt: providerSystemPrompt,
        messages: providerMessages,
        tools: toolSchemas,
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
          turnUsage = ev.usage
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
      opts.bus.emit({ type: 'turn_end', turn, stopReason, ...(turnUsage ? { usage: turnUsage } : {}) })
      if (opts.hooks?.afterTurn) {
        await opts.hooks.afterTurn({
          turn,
          lastMessage: assistantMessage,
          cwd: opts.cwd,
          bus: opts.bus,
        })
      }
      return assistantMessage
    }

    // Ejecutar tools en paralelo.
    const ctx: ToolContext = {
      cwd: opts.cwd,
      abortSignal: opts.abortSignal,
      logger: opts.logger,
      executor: opts.executor,
    }

    let steeredFeedback: { toolUseId: string; feedback: string } | null = null

    const results = await Promise.all(
      toolUses.map(async (tu) => {
        // Si otra herramienta ya activó steering, cancelamos esta inmediatamente
        const currentSteered = steeredFeedback as { toolUseId: string; feedback: string } | null
        if (currentSteered) {
          const output = `Cancelled due to user steering on tool '${toolUses.find((u) => u.id === currentSteered.toolUseId)?.name ?? 'unknown'}'.`
          const block: ToolResultBlock = {
            type: 'tool_result',
            tool_use_id: tu.id,
            content: output,
            is_error: true,
          }
          return block
        }

        opts.bus.emit({
          type: 'tool_execution_start',
          toolUseId: tu.id,
          name: tu.name,
          input: tu.input,
        })

        let authorize = true
        let mockResult: string | undefined = undefined
        let steer = false
        let feedback: string | undefined = undefined

        if (opts.hooks?.beforeToolExecution) {
          const hookRes = await opts.hooks.beforeToolExecution({
            toolName: tu.name,
            input: tu.input,
            toolUseId: tu.id,
            cwd: opts.cwd,
            bus: opts.bus,
          })
          authorize = hookRes.authorize
          mockResult = hookRes.mockResult
          steer = hookRes.steer ?? false
          feedback = hookRes.feedback
        }

        let output: string
        let isError = false
        const started = performance.now()

        if (steer) {
          steeredFeedback = { toolUseId: tu.id, feedback: feedback ?? 'Execution cancelled by user feedback.' }
          output = feedback ?? 'Execution cancelled by user feedback.'
          isError = true
          opts.bus.emit({
            type: 'user_steering',
            toolUseId: tu.id,
            feedback: output,
          })
        } else if (!authorize) {
          output = mockResult ?? 'Execution rejected by user policy.'
          isError = true
        } else if (mockResult !== undefined) {
          output = mockResult
        } else {
          // Re-chequear steering antes de ejecutar la tool real, por si otra tool en paralelo lo activó
          const currentSteered2 = steeredFeedback as { toolUseId: string; feedback: string } | null
          if (currentSteered2) {
            output = `Cancelled due to user steering on tool '${toolUses.find((u) => u.id === currentSteered2.toolUseId)?.name ?? 'unknown'}'.`
            isError = true
          } else {
            const res = await opts.registry.run(tu.name, tu.input, ctx)
            output = res.output
            isError = res.isError
          }
        }

        const durationMs = performance.now() - started

        const hasSteered = steeredFeedback !== null
        if (!steer && !hasSteered && opts.hooks?.afterToolExecution) {
          output = await opts.hooks.afterToolExecution({
            toolName: tu.name,
            input: tu.input,
            output,
            durationMs,
            isError,
            cwd: opts.cwd,
            bus: opts.bus,
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

    const contentBlocks: ContentBlock[] = [...results]
    const finalSteered = steeredFeedback as { feedback: string } | null
    if (finalSteered) {
      contentBlocks.push({
        type: 'text',
        text: `[User Steering Feedback]: ${finalSteered.feedback}`,
      })
    }

    opts.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: contentBlocks,
    })
    opts.bus.emit({ type: 'turn_end', turn, stopReason, ...(turnUsage ? { usage: turnUsage } : {}) })

    if (opts.hooks?.afterTurn) {
      await opts.hooks.afterTurn({
        turn,
        lastMessage: assistantMessage,
        cwd: opts.cwd,
        bus: opts.bus,
      })
    }
  }

  if (!lastAssistant) throw new Error('Loop terminó sin mensaje del assistant')
  return lastAssistant
}

function isToolUse(b: ContentBlock): b is ToolUseBlock {
  return b.type === 'tool_use'
}
