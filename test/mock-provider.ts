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
  thinking?: string
  toolCalls?: Array<{ id: string; name: string; input: unknown }>
  stopReason?: StopReason
  /**
   * Si está presente, el turno tira este error **antes** de emitir cualquier
   * evento (simula HTTP fail al iniciar el stream). Usado por los tests de retry.
   */
  failBeforeStream?: unknown
  /**
   * Si está presente, emite los eventos normales hasta acá y luego tira
   * (simula stream interrumpido a mitad). Usado para validar que NO se
   * reintenta cuando ya se emitió algo.
   */
  failAfterPartial?: unknown
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
    }
  }
}
