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
  AgentLoopPattern,
  PlanItem,
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
  pattern?: AgentLoopPattern
  plan?: PlanItem[]
  /**
   * Terminal tools: if the model calls one of these and its execution does NOT
   * fail, the loop returns the assistant message immediately after recording its
   * `tool_result`, without opening another turn. `generateObject` uses it to
   * close as soon as the model delivers the typed answer. If the tool fails
   * (e.g. schema validation), it does NOT stop: the error `tool_result` goes back
   * to the model so it retries (repair loop).
   */
  stopOnToolNames?: string[]
}

const DEFAULT_MAX_TURNS = 25

/**
 * Agent loop. Each "turn" = one provider call + execution of the tools it
 * requested. Ends when the provider returns `end_turn` (no pending tool_use),
 * maxTurns is reached, or the run is aborted.
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
    if (opts.pattern === 'PLAN_EXECUTE' && opts.plan) {
      const planStr = `\n\n[Active Plan State]\n` + 
        (opts.plan.length === 0 
          ? '(No tasks defined yet. Use add_plan_item tool to define tasks)' 
          : opts.plan.map(i => `- [${i.status.toUpperCase()}] ${i.description} (ID: ${i.id})`).join('\n'))
      providerSystemPrompt += planStr
    }
    let toolSchemas = opts.registry.toSchemas()
    let toolChoice: 'auto' | 'none' | 'required' | undefined = undefined

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
      if (hookRes.toolChoice) {
        toolChoice = hookRes.toolChoice
      }
    }

    const stream = streamWithRetry({
      provider: opts.provider,
      streamOpts: {
        systemPrompt: providerSystemPrompt,
        messages: providerMessages,
        tools: toolSchemas,
        abortSignal: opts.abortSignal,
        ...(toolChoice ? { toolChoice } : {}),
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
      throw new Error('Provider finished without emitting message_end')
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

    // Execute tools in parallel.
    const ctx: ToolContext = {
      cwd: opts.cwd,
      abortSignal: opts.abortSignal,
      logger: opts.logger,
      executor: opts.executor,
    }

    let steeredFeedback: { toolUseId: string; feedback: string } | null = null

    const results = await Promise.all(
      toolUses.map(async (tu) => {
        // If another tool already triggered steering, cancel this one immediately
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
          // Re-check steering before running the real tool, in case a parallel tool triggered it
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

    // Terminal tool: if any terminal tool ran without error, we close the loop
    // here. `results` is index-aligned with `toolUses` (Promise.all preserves
    // order), so we can match name ↔ result.
    if (opts.stopOnToolNames?.length) {
      const hitTerminal = toolUses.some(
        (tu, i) => opts.stopOnToolNames!.includes(tu.name) && !results[i]?.is_error,
      )
      if (hitTerminal) return assistantMessage
    }
  }

  if (!lastAssistant) throw new Error('Loop finished without an assistant message')
  return lastAssistant
}

function isToolUse(b: ContentBlock): b is ToolUseBlock {
  return b.type === 'tool_use'
}
