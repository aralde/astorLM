import OpenAI from 'openai'
import { AuthStorage } from '../auth/storage.js'
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderEvent,
  ProviderStreamOptions,
  StopReason,
  TokenUsage,
} from '../types.js'

export interface OpenAIProviderOptions {
  model: string
  apiKey?: string
  auth?: AuthStorage
  maxTokens?: number
  baseURL?: string
  /** Permite usar otros endpoints compatibles (Groq, OpenRouter, Together, etc.). */
  envVar?: string
}

/**
 * Provider sobre la Chat Completions API de OpenAI con streaming + tool calls.
 *
 * Diferencias clave con Anthropic que este adapter resuelve:
 *  - Tools van como `{type:'function', function:{name, description, parameters}}`.
 *  - Los tool_use viven en `assistant.tool_calls` (array al costado del content),
 *    no como bloques inline. Los reagrupamos por id durante el stream.
 *  - Los tool_results se envían como mensajes separados con `role:'tool'`,
 *    uno por cada tool_call_id. Acá los desempaquetamos al mapear `Message[]`.
 */
export class OpenAIProvider implements Provider {
  readonly name = 'openai'
  readonly model: string
  readonly contextLimit: number
  private readonly client: OpenAI
  private readonly maxTokens?: number

  constructor(opts: OpenAIProviderOptions) {
    const auth = opts.auth ?? AuthStorage.default()
    const envVar = opts.envVar ?? 'OPENAI_API_KEY'
    const apiKey = opts.apiKey ?? auth.require(envVar)
    this.client = new OpenAI({ apiKey, baseURL: opts.baseURL })
    this.model = opts.model
    this.maxTokens = opts.maxTokens
    this.contextLimit = opts.model.includes('gpt-3.5') ? 16385 : 128000
  }

  async *stream(opts: ProviderStreamOptions): AsyncIterable<ProviderEvent> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: opts.systemPrompt },
      ...flattenMessages(opts.messages, this.model),
    ]

    const tools = opts.tools.map<OpenAI.Chat.ChatCompletionTool>((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }))

    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        stream: true,
        temperature: 0,
        // Pedimos usage en el último chunk (OpenAI y la mayoría de los compat lo soportan;
        // los que no, simplemente devuelven `chunk.usage = null` y lo ignoramos).
        stream_options: { include_usage: true },
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' as const } : {}),
        ...(opts.maxTokens ?? this.maxTokens ? { max_tokens: opts.maxTokens ?? this.maxTokens } : {}),
      },
      { signal: opts.abortSignal },
    )

    // Buffers para reconstruir el mensaje final.
    let textAcc = ''
    let reasoningAcc = ''
    type ToolCallBuf = { id: string; name: string; argsAcc: string; emittedStart: boolean }
    const toolCalls: Record<number, ToolCallBuf> = {}
    let finishReason: OpenAI.Chat.Completions.ChatCompletionChunk.Choice['finish_reason'] = null
    let usageRaw: OpenAI.Completions.CompletionUsage | null = null

    // Parser de tags de pensamiento para modelos/proxies que devuelven <think>...</think> en content
    let inThinkingTag = false
    let tagBuffer = ''
    const startTag = '<think>'
    const endTag = '</think>'
    const startPrefixes = ['<think', '<thin', '<thi', '<th', '<t', '<']
    const endPrefixes = ['</think', '</thin', '</thi', '</th', '</t', '</', '<']

    for await (const chunk of stream) {
      // Con stream_options.include_usage, el último chunk trae `usage` y
      // viene típicamente con `choices: []` — lo capturamos antes de saltarlo.
      if (chunk.usage) usageRaw = chunk.usage
      const choice = chunk.choices[0]
      if (!choice) continue
      const d = choice.delta

      const reasoning = (d as any).reasoning_content || (d as any).reasoning
      if (reasoning) {
        reasoningAcc += reasoning
        yield { type: 'thinking_delta', thinking: reasoning }
      }

      if (d.content) {
        tagBuffer += d.content
        
        let changed = true
        while (changed) {
          changed = false
          if (!inThinkingTag) {
            const idx = tagBuffer.indexOf(startTag)
            if (idx !== -1) {
              const textPart = tagBuffer.slice(0, idx)
              if (textPart.length > 0) {
                textAcc += textPart
                yield { type: 'text_delta', text: textPart }
              }
              inThinkingTag = true
              tagBuffer = tagBuffer.slice(idx + startTag.length)
              changed = true
            }
          } else {
            const idx = tagBuffer.indexOf(endTag)
            if (idx !== -1) {
              const thinkingPart = tagBuffer.slice(0, idx)
              if (thinkingPart.length > 0) {
                reasoningAcc += thinkingPart
                yield { type: 'thinking_delta', thinking: thinkingPart }
              }
              inThinkingTag = false
              tagBuffer = tagBuffer.slice(idx + endTag.length)
              changed = true
            }
          }
        }

        // Determinar si al final del buffer queda un prefijo del tag que estamos buscando
        if (tagBuffer.length > 0) {
          const prefixes = inThinkingTag ? endPrefixes : startPrefixes
          let matchedPrefixLen = 0
          for (const prefix of prefixes) {
            if (tagBuffer.endsWith(prefix)) {
              matchedPrefixLen = prefix.length
              break
            }
          }

          const yieldLen = tagBuffer.length - matchedPrefixLen
          if (yieldLen > 0) {
            const yieldText = tagBuffer.slice(0, yieldLen)
            if (inThinkingTag) {
              reasoningAcc += yieldText
              yield { type: 'thinking_delta', thinking: yieldText }
            } else {
              textAcc += yieldText
              yield { type: 'text_delta', text: yieldText }
            }
            tagBuffer = tagBuffer.slice(yieldLen)
          }
        }
      }

      if (d.tool_calls) {
        for (const tc of d.tool_calls) {
          const idx = tc.index
          let buf = toolCalls[idx]
          if (!buf) {
            buf = { id: tc.id ?? '', name: tc.function?.name ?? '', argsAcc: '', emittedStart: false }
            toolCalls[idx] = buf
          }
          if (tc.id && !buf.id) buf.id = tc.id
          if (tc.function?.name && !buf.name) buf.name = tc.function.name
          if (!buf.emittedStart && buf.id && buf.name) {
            buf.emittedStart = true
            yield { type: 'tool_use_start', id: buf.id, name: buf.name }
          }
          if (tc.function?.arguments) {
            buf.argsAcc += tc.function.arguments
            if (buf.emittedStart) {
              yield { type: 'tool_use_input', id: buf.id, inputJsonDelta: tc.function.arguments }
            }
          }
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason
    }

    // Flush del buffer del tag parser al terminar el stream
    if (tagBuffer.length > 0) {
      if (inThinkingTag) {
        reasoningAcc += tagBuffer
        yield { type: 'thinking_delta', thinking: tagBuffer }
      } else {
        textAcc += tagBuffer
        yield { type: 'text_delta', text: tagBuffer }
      }
      tagBuffer = ''
    }

    // Cerrar tool_uses pendientes con su input parseado.
    const content: ContentBlock[] = []
    if (reasoningAcc.length) content.push({ type: 'thinking', thinking: reasoningAcc })
    if (textAcc.length) content.push({ type: 'text', text: textAcc })
    for (const idx of Object.keys(toolCalls).map(Number).sort((a, b) => a - b)) {
      const buf = toolCalls[idx]!
      const input = buf.argsAcc.length ? safeJson(buf.argsAcc) : {}
      yield { type: 'tool_use_end', id: buf.id, name: buf.name, input }
      content.push({ type: 'tool_use', id: buf.id, name: buf.name, input })
    }

    const stopReason: StopReason =
      finishReason === 'tool_calls'
        ? 'tool_use'
        : finishReason === 'length'
          ? 'max_tokens'
          : finishReason === 'stop'
            ? 'end_turn'
            : 'end_turn'

    const usage = mapUsage(usageRaw)
    yield {
      type: 'message_end',
      stopReason,
      assistantMessage: { role: 'assistant', content },
      ...(usage ? { usage } : {}),
    }
  }
}

function mapUsage(u: OpenAI.Completions.CompletionUsage | null | undefined): TokenUsage | undefined {
  if (!u) return undefined
  const usage: TokenUsage = {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
  }
  // OpenAI expone `prompt_tokens_details.cached_tokens` cuando el modelo usa
  // automatic prompt caching. No hay equivalente claro a "cache creation"
  // en la API de OpenAI — se omite.
  const cached = (u as any).prompt_tokens_details?.cached_tokens
  if (typeof cached === 'number') usage.cacheReadTokens = cached
  return usage
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

/**
 * Aplana nuestros `Message[]` al formato OpenAI:
 *   - assistant con tool_use → assistant con `tool_calls` (+ content opcional)
 *   - user con tool_result   → un mensaje `role:'tool'` por cada tool_result
 *   - texto plano queda igual
 */
function flattenMessages(msgs: Message[], model?: string): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
  for (const m of msgs) {
    if (m.role === 'system') {
      const text = m.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
      if (text) out.push({ role: 'system', content: text })
      continue
    }
    if (m.role === 'assistant') {
      let text = ''
      let reasoning = ''
      const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = []
      for (const b of m.content) {
        if (b.type === 'text') text += b.text
        else if (b.type === 'thinking') {
          reasoning += b.thinking
        } else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          })
        }
      }
      const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: text || null,
      }
      if (reasoning && model && (model.startsWith('o1') || model.startsWith('o3') || model.includes('reasoner') || model.includes('deepseek'))) {
        (msg as any).reasoning_content = reasoning
      }
      if (toolCalls.length) msg.tool_calls = toolCalls
      out.push(msg)
      continue
    }
    // role === 'user' — puede contener texto o uno-o-más tool_result.
    const toolResults = m.content.filter((b) => b.type === 'tool_result')
    if (toolResults.length) {
      for (const b of toolResults) {
        if (b.type !== 'tool_result') continue
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content })
      }
      // Si además había texto, agregarlo como user normal después.
      const text = m.content
        .filter((b) => b.type === 'text')
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
      if (text) out.push({ role: 'user', content: text })
    } else {
      const text = m.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
      out.push({ role: 'user', content: text })
    }
  }
  return out
}

