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
  /** Allows using other compatible endpoints (Groq, OpenRouter, Together, etc.). */
  envVar?: string
  /**
   * Allows the client to run inside a browser-like environment (e.g. a Tauri or
   * Electron webview). Off by default, matching the OpenAI SDK's safe default.
   */
  dangerouslyAllowBrowser?: boolean
  /**
   * Default sampling temperature. A per-call `sampling.temperature` overrides it.
   * When neither is set, the provider keeps its historical default of `0`.
   */
  temperature?: number
  /** Default nucleus sampling (`top_p`). Overridable per call via `sampling.topP`. */
  topP?: number
  /**
   * Default OpenAI-style repetition penalty. Overridable per call via
   * `sampling.frequencyPenalty`. Useful to reduce degenerate token loops on
   * weak/quantized models.
   */
  frequencyPenalty?: number
  /** Default OpenAI-style presence penalty. Overridable per call. */
  presencePenalty?: number
}

/** Resolved sampling defaults carried by the provider instance. */
interface SamplingDefaultsInternal {
  maxTokens?: number
  temperature?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
}

/**
 * Provider over OpenAI's Chat Completions API with streaming + tool calls.
 *
 * Key differences from Anthropic that this adapter resolves:
 *  - Tools go as `{type:'function', function:{name, description, parameters}}`.
 *  - tool_use lives in `assistant.tool_calls` (an array alongside the content),
 *    not as inline blocks. We regroup them by id during the stream.
 *  - tool_results are sent as separate messages with `role:'tool'`, one per
 *    tool_call_id. Here we unpack them when mapping `Message[]`.
 */
export class OpenAIProvider implements Provider {
  readonly name = 'openai'
  readonly model: string
  readonly contextLimit: number
  private readonly client: OpenAI
  private readonly samplingDefaults: SamplingDefaultsInternal

  constructor(opts: OpenAIProviderOptions) {
    const auth = opts.auth ?? AuthStorage.default()
    const envVar = opts.envVar ?? 'OPENAI_API_KEY'
    const apiKey = opts.apiKey ?? auth.require(envVar)
    this.client = new OpenAI({
      apiKey,
      baseURL: opts.baseURL,
      dangerouslyAllowBrowser: opts.dangerouslyAllowBrowser ?? false,
    })
    this.model = opts.model
    this.samplingDefaults = {
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      topP: opts.topP,
      frequencyPenalty: opts.frequencyPenalty,
      presencePenalty: opts.presencePenalty,
    }
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

    const params = buildChatCompletionParams(opts, {
      model: this.model,
      messages,
      tools,
      defaults: this.samplingDefaults,
    })

    const stream = await this.client.chat.completions.create(params, {
      signal: opts.abortSignal,
    })

    // Buffers to reconstruct the final message.
    let textAcc = ''
    let reasoningAcc = ''
    type ToolCallBuf = { id: string; name: string; argsAcc: string; emittedStart: boolean }
    const toolCalls: Record<number, ToolCallBuf> = {}
    let finishReason: OpenAI.Chat.Completions.ChatCompletionChunk.Choice['finish_reason'] = null
    let usageRaw: OpenAI.Completions.CompletionUsage | null = null

    // Thinking-tag parser for models/proxies that return <think>...</think> in content
    let inThinkingTag = false
    let tagBuffer = ''
    const startTag = '<think>'
    const endTag = '</think>'
    const startPrefixes = ['<think', '<thin', '<thi', '<th', '<t', '<']
    const endPrefixes = ['</think', '</thin', '</thi', '</th', '</t', '</', '<']

    for await (const chunk of stream) {
      // With stream_options.include_usage, the last chunk carries `usage` and
      // typically comes with `choices: []` — we capture it before skipping it.
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

        // Determine whether the end of the buffer holds a prefix of the tag we're looking for
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

    // Flush the tag parser's buffer when the stream ends
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

    // Close pending tool_uses with their parsed input.
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

/**
 * Builds the Chat Completions request body from our stream options plus the
 * provider's configured defaults. Extracted as a pure function so the parameter
 * resolution (sampling precedence, tool_choice, response_format) is unit-testable
 * without an HTTP client.
 *
 * Resolution order for every sampling knob: per-call `opts.sampling.*` >
 * constructor default > hard default (`temperature: 0`; the rest omitted when
 * unset). `tool_choice` defaults to `'auto'` and only appears when tools are sent.
 *
 * @internal
 */
export function buildChatCompletionParams(
  opts: ProviderStreamOptions,
  cfg: {
    model: string
    messages: OpenAI.Chat.ChatCompletionMessageParam[]
    tools: OpenAI.Chat.ChatCompletionTool[]
    defaults: {
      maxTokens?: number
      temperature?: number
      topP?: number
      frequencyPenalty?: number
      presencePenalty?: number
    }
  },
): OpenAI.Chat.ChatCompletionCreateParamsStreaming {
  const s = opts.sampling
  const temperature = s?.temperature ?? cfg.defaults.temperature ?? 0
  const topP = s?.topP ?? cfg.defaults.topP
  const frequencyPenalty = s?.frequencyPenalty ?? cfg.defaults.frequencyPenalty
  const presencePenalty = s?.presencePenalty ?? cfg.defaults.presencePenalty
  const maxTokens = opts.maxTokens ?? cfg.defaults.maxTokens

  // Typed output (structured output). `response_format: json_schema` applies
  // constrained decoding — the model cannot stray from the schema. It does not
  // coexist with `tools`/`tool_choice`, so we only send it when there are no tools.
  const responseFormat =
    opts.outputFormat && cfg.tools.length === 0
      ? {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: opts.outputFormat.name,
              schema: opts.outputFormat.schema,
              strict: opts.outputFormat.strict ?? true,
            },
          },
        }
      : {}

  return {
    model: cfg.model,
    stream: true,
    temperature,
    // Request usage in the last chunk (OpenAI and most compat servers support it;
    // those that don't simply return `chunk.usage = null` and we ignore it).
    stream_options: { include_usage: true },
    messages: cfg.messages,
    ...(cfg.tools.length > 0
      ? { tools: cfg.tools, tool_choice: opts.toolChoice ?? ('auto' as const) }
      : {}),
    ...(topP !== undefined ? { top_p: topP } : {}),
    ...(frequencyPenalty !== undefined ? { frequency_penalty: frequencyPenalty } : {}),
    ...(presencePenalty !== undefined ? { presence_penalty: presencePenalty } : {}),
    ...responseFormat,
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
  }
}

function mapUsage(u: OpenAI.Completions.CompletionUsage | null | undefined): TokenUsage | undefined {
  if (!u) return undefined
  const usage: TokenUsage = {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
  }
  // OpenAI exposes `prompt_tokens_details.cached_tokens` when the model uses
  // automatic prompt caching. There is no clear equivalent to "cache creation"
  // in OpenAI's API — it is omitted.
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
 * Flattens our `Message[]` into the OpenAI format:
 *   - assistant with tool_use → assistant with `tool_calls` (+ optional content)
 *   - user with tool_result   → one `role:'tool'` message per tool_result
 *   - plain text stays the same
 *
 * @internal - exported for unit testing the message flattening.
 */
export function flattenMessages(msgs: Message[], model?: string): OpenAI.Chat.ChatCompletionMessageParam[] {
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
        // Send "" (not null) even when the assistant message only carries
        // tool_calls. Both are spec-valid, but several OpenAI-compatible backends
        // (free OpenRouter tiers, local servers) have chat templates that
        // mishandle a null content — the empty string is the safer serialization.
        content: text,
      }
      if (reasoning && model && (model.startsWith('o1') || model.startsWith('o3') || model.includes('reasoner') || model.includes('deepseek'))) {
        (msg as any).reasoning_content = reasoning
      }
      if (toolCalls.length) msg.tool_calls = toolCalls
      out.push(msg)
      continue
    }
    // role === 'user' — may contain text or one-or-more tool_result.
    const toolResults = m.content.filter((b) => b.type === 'tool_result')
    if (toolResults.length) {
      for (const b of toolResults) {
        if (b.type !== 'tool_result') continue
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content })
      }
      // If there was also text, add it as a normal user message afterwards.
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

