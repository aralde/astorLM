import Anthropic from '@anthropic-ai/sdk'
import { AuthStorage } from '../auth/storage.js'
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderEvent,
  ProviderStreamOptions,
  StopReason,
  TokenUsage,
  ToolUseBlock,
} from '../types.js'

export interface AnthropicProviderOptions {
  model: string
  apiKey?: string
  auth?: AuthStorage
  maxTokens?: number
  baseURL?: string
  thinking?: {
    budget_tokens: number
  }
}

/**
 * Provider sobre @anthropic-ai/sdk usando el streaming nativo.
 * Convierte:
 *   - nuestros `Message[]` → formato Anthropic
 *   - stream Anthropic → `ProviderEvent`s normalizados
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic'
  readonly model: string
  readonly contextLimit: number
  private readonly client: Anthropic
  private readonly maxTokens: number
  private readonly thinking?: { budget_tokens: number }

  constructor(opts: AnthropicProviderOptions) {
    const auth = opts.auth ?? AuthStorage.default()
    const apiKey = opts.apiKey ?? auth.require('ANTHROPIC_API_KEY')
    this.client = new Anthropic({ apiKey, baseURL: opts.baseURL })
    this.model = opts.model
    this.maxTokens = opts.maxTokens ?? 4096
    this.contextLimit = 200000
    this.thinking = opts.thinking
  }

  async *stream(opts: ProviderStreamOptions): AsyncIterable<ProviderEvent> {
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: opts.maxTokens ?? this.maxTokens,
        system: opts.systemPrompt,
        messages: opts.messages.map(toAnthropicMessage).filter((m) => m !== null) as Anthropic.MessageParam[],
        tools: opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
        ...(this.thinking ? { thinking: { type: 'enabled', budget_tokens: this.thinking.budget_tokens } } : {}),
      },
      { signal: opts.abortSignal },
    )

    // Buffer de bloques en construcción (para tool_use partial_json y thinking).
    type BlockBuf =
      | { type: 'text'; text: string }
      | { type: 'thinking'; thinking: string }
      | { type: 'tool_use'; id: string; name: string; jsonAcc: string }
    const blocks: Record<number, BlockBuf> = {}

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block
          if (block.type === 'text') {
            blocks[event.index] = { type: 'text', text: '' }
          } else if (block.type === 'thinking') {
            blocks[event.index] = { type: 'thinking', thinking: '' }
          } else if (block.type === 'tool_use') {
            blocks[event.index] = { type: 'tool_use', id: block.id, name: block.name, jsonAcc: '' }
            yield { type: 'tool_use_start', id: block.id, name: block.name }
          }
          break
        }
        case 'content_block_delta': {
          const buf = blocks[event.index]
          const delta = event.delta
          if (delta.type === 'text_delta' && buf?.type === 'text') {
            buf.text += delta.text
            yield { type: 'text_delta', text: delta.text }
          } else if (delta.type === 'thinking_delta' && buf?.type === 'thinking') {
            buf.thinking += delta.thinking
            yield { type: 'thinking_delta', thinking: delta.thinking }
          } else if (delta.type === 'input_json_delta' && buf?.type === 'tool_use') {
            buf.jsonAcc += delta.partial_json
            yield { type: 'tool_use_input', id: buf.id, inputJsonDelta: delta.partial_json }
          }
          break
        }
        case 'content_block_stop': {
          const buf = blocks[event.index]
          if (buf?.type === 'tool_use') {
            const input = buf.jsonAcc.length ? safeJson(buf.jsonAcc) : {}
            yield { type: 'tool_use_end', id: buf.id, name: buf.name, input }
          }
          break
        }
        default:
          break
      }
    }

    const finalMsg = await stream.finalMessage()
    const assistantMessage: Message = {
      role: 'assistant',
      content: finalMsg.content.map(blockFromAnthropic),
    }
    const usage = mapUsage(finalMsg.usage)
    yield {
      type: 'message_end',
      stopReason: mapStopReason(finalMsg.stop_reason),
      assistantMessage,
      ...(usage ? { usage } : {}),
    }
  }
}

function mapUsage(u: Anthropic.Message['usage'] | undefined | null): TokenUsage | undefined {
  if (!u) return undefined
  const usage: TokenUsage = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
  }
  if (typeof u.cache_read_input_tokens === 'number') {
    usage.cacheReadTokens = u.cache_read_input_tokens
  }
  if (typeof u.cache_creation_input_tokens === 'number') {
    usage.cacheCreationTokens = u.cache_creation_input_tokens
  }
  return usage
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

function mapStopReason(r: Anthropic.Message['stop_reason']): StopReason {
  switch (r) {
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    case 'stop_sequence':
      return 'stop_sequence'
    default:
      return 'end_turn'
  }
}

function blockFromAnthropic(b: Anthropic.ContentBlock): ContentBlock {
  if (b.type === 'text') return { type: 'text', text: b.text }
  if (b.type === 'thinking') {
    return { type: 'thinking', thinking: b.thinking, signature: b.signature }
  }
  if (b.type === 'redacted_thinking') {
    return { type: 'redacted_thinking', signature: b.data }
  }
  if (b.type === 'tool_use') {
    const tu: ToolUseBlock = { type: 'tool_use', id: b.id, name: b.name, input: b.input }
    return tu
  }
  return { type: 'text', text: '' }
}

function toAnthropicMessage(m: Message): Anthropic.MessageParam | null {
  if (m.role === 'system') return null
  const content: Anthropic.ContentBlockParam[] = []
  for (const b of m.content) {
    if (b.type === 'text') {
      if (b.text.length) content.push({ type: 'text', text: b.text })
    } else if (b.type === 'thinking') {
      content.push({ type: 'thinking', thinking: b.thinking, signature: b.signature ?? '' })
    } else if (b.type === 'redacted_thinking') {
      content.push({ type: 'redacted_thinking', data: b.signature })
    } else if (b.type === 'tool_use') {
      content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input as object })
    } else if (b.type === 'tool_result') {
      content.push({
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content: b.content,
        is_error: b.is_error,
      })
    }
  }
  if (!content.length) return null
  return { role: m.role, content }
}
