import { randomUUID } from 'node:crypto'
import type { EventBus } from './events.js'
import type { ToolRegistry } from '../tools/registry.js'
import type {
  ContentBlock,
  Message,
  Provider,
  ToolContext,
  ToolResultBlock,
  ToolUseBlock,
} from '../types.js'

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

    opts.bus.emit({ type: 'turn_start', turn })

    let assistantMessage: Message | null = null
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' = 'end_turn'

    const stream = opts.provider.stream({
      systemPrompt: opts.systemPrompt,
      messages: opts.messages,
      tools: opts.registry.toSchemas(),
      abortSignal: opts.abortSignal,
    })

    for await (const ev of stream) {
      switch (ev.type) {
        case 'text_delta':
          opts.bus.emit({ type: 'text_delta', text: ev.text })
          break
        case 'message_end':
          assistantMessage = ev.assistantMessage
          stopReason = ev.stopReason
          break
        // tool_use_start / _input / _end: ya tenemos el bloque final en message_end.
        default:
          break
      }
    }

    if (!assistantMessage) {
      throw new Error('Provider terminó sin emitir message_end')
    }

    if (!assistantMessage.id) {
      assistantMessage.id = randomUUID()
    }
    opts.messages.push(assistantMessage)
    lastAssistant = assistantMessage
    opts.bus.emit({ type: 'assistant_message', message: assistantMessage })

    const toolUses = assistantMessage.content.filter(isToolUse)
    if (toolUses.length === 0 || stopReason === 'end_turn') {
      opts.bus.emit({ type: 'turn_end', turn, stopReason })
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
        const res = await opts.registry.run(tu.name, tu.input, ctx)
        opts.bus.emit({
          type: 'tool_execution_end',
          toolUseId: tu.id,
          name: tu.name,
          output: res.output,
          isError: res.isError,
          durationMs: res.durationMs,
        })
        const block: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: tu.id,
          content: res.output,
          is_error: res.isError,
        }
        return block
      }),
    )

    opts.messages.push({
      id: randomUUID(),
      role: 'user',
      content: results as ContentBlock[],
    })
    opts.bus.emit({ type: 'turn_end', turn, stopReason })
  }

  if (!lastAssistant) throw new Error('Loop terminó sin mensaje del assistant')
  return lastAssistant
}

function isToolUse(b: ContentBlock): b is ToolUseBlock {
  return b.type === 'tool_use'
}
