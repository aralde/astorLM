import type {
  Message,
  Provider,
  ProviderEvent,
  ProviderStreamOptions,
  StopReason,
  TokenUsage,
} from '../src/types.js'

/**
 * Scripted MockProvider. Accepts a list of "turns"; on each call to stream()
 * it returns the events of the next turn. Useful for testing the agent loop
 * without touching the real API.
 */
export interface ScriptedTurn {
  text?: string
  thinking?: string
  toolCalls?: Array<{ id: string; name: string; input: unknown }>
  stopReason?: StopReason
  /**
   * If present, the turn throws this error **before** emitting any event
   * (simulates an HTTP fail when starting the stream). Used by the retry tests.
   */
  failBeforeStream?: unknown
  /**
   * If present, emits the normal events up to here and then throws
   * (simulates a stream interrupted halfway). Used to validate that it does
   * NOT retry once something has already been emitted.
   */
  failAfterPartial?: unknown
  /** Usage reported by this turn (included in `message_end`). */
  usage?: TokenUsage
}

export class MockProvider implements Provider {
  readonly name = 'mock'
  readonly model = 'mock-1'
  public calls: ProviderStreamOptions[] = []
  private index = 0

  constructor(private readonly turns: ScriptedTurn[]) {}

  async *stream(opts: ProviderStreamOptions): AsyncIterable<ProviderEvent> {
    this.calls.push(opts)
    const turn = this.turns[this.index++]
    if (!turn) throw new Error('MockProvider: no scripted turns left')

    if (turn.failBeforeStream !== undefined) {
      throw turn.failBeforeStream
    }

    const content: Message['content'] = []
    if (turn.thinking) {
      yield { type: 'thinking_delta', thinking: turn.thinking }
      content.push({ type: 'thinking', thinking: turn.thinking })
    }
    if (turn.text) {
      yield { type: 'text_delta', text: turn.text }
      content.push({ type: 'text', text: turn.text })
    }
    if (turn.failAfterPartial !== undefined) {
      throw turn.failAfterPartial
    }
    for (const tc of turn.toolCalls ?? []) {
      yield { type: 'tool_use_start', id: tc.id, name: tc.name }
      yield { type: 'tool_use_end', id: tc.id, name: tc.name, input: tc.input }
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
    }
    const stopReason: StopReason =
      turn.stopReason ?? (turn.toolCalls?.length ? 'tool_use' : 'end_turn')
    yield {
      type: 'message_end',
      stopReason,
      assistantMessage: { role: 'assistant', content },
      ...(turn.usage ? { usage: turn.usage } : {}),
    }
  }
}
