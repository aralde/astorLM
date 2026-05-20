import type {
  Message,
  Provider,
  ProviderEvent,
  ProviderStreamOptions,
  StopReason,
} from '../src/types.js'

/**
 * MockProvider scriptado. Acepta una lista de "turnos"; en cada llamada
 * a stream() devuelve los eventos del próximo turno. Útil para testear
 * el agent loop sin tocar la API real.
 */
export interface ScriptedTurn {
  text?: string
  toolCalls?: Array<{ id: string; name: string; input: unknown }>
  stopReason?: StopReason
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
    if (!turn) throw new Error('MockProvider: no quedan turnos scripteados')

    const content: Message['content'] = []
    if (turn.text) {
      yield { type: 'text_delta', text: turn.text }
      content.push({ type: 'text', text: turn.text })
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
    }
  }
}
