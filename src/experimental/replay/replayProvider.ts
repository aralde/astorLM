import type { Provider, ProviderEvent, ProviderStreamOptions } from '../../types.js'
import type { Recording } from './types.js'

export interface ReplayProviderOptions {
  /**
   * What to do when the loop asks for more turns than were recorded. `'throw'`
   * (default) surfaces a clear error; `'end'` yields a synthetic empty
   * `end_turn` so the loop terminates gracefully.
   */
  onExhausted?: 'throw' | 'end'
}

/**
 * A {@link Provider} that replays a {@link Recording} turn by turn instead of
 * calling a model. Deterministic: the same recording yields the same events
 * every time, so you can re-run a captured session locally to debug the loop,
 * tools or hooks without network access or token spend.
 */
export function createReplayProvider(
  recording: Recording,
  options: ReplayProviderOptions = {},
): Provider {
  const onExhausted = options.onExhausted ?? 'throw'
  let index = 0

  return {
    name: `${recording.provider}:replay`,
    model: recording.model,
    async *stream(_opts: ProviderStreamOptions): AsyncIterable<ProviderEvent> {
      const turn = recording.turns[index++]
      if (!turn) {
        if (onExhausted === 'end') {
          yield {
            type: 'message_end',
            stopReason: 'end_turn',
            assistantMessage: { role: 'assistant', content: [] },
          }
          return
        }
        throw new Error(
          `Replay exhausted: the loop requested turn ${index} but the recording has only ${recording.turns.length}.`,
        )
      }
      for (const event of turn) yield event
    },
  }
}
