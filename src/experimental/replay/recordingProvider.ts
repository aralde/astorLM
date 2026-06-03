import type { Provider, ProviderEvent, ProviderStreamOptions } from '../../types.js'
import type { Recording, RecordedTurn } from './types.js'

export interface RecordingProviderOptions {
  /** Called with the captured events each time a turn finishes streaming. */
  onTurn?: (turn: RecordedTurn) => void
  /** Clock override for `createdAt`. Defaults to `() => new Date().toISOString()`. */
  nowIso?: () => string
}

export interface RecordingProvider extends Provider {
  /** Returns a serializable snapshot of everything recorded so far. */
  getRecording(): Recording
}

/**
 * Wraps a real {@link Provider}, passing every event straight through to the
 * loop while capturing it into a {@link Recording}. The capture is at the
 * provider boundary, so it records exactly what the model emitted — independent
 * of tools, hooks or wall-clock timing. Serialize `getRecording()` to JSON to
 * persist a run; feed it to {@link createReplayProvider} to reproduce it.
 */
export function createRecordingProvider(
  inner: Provider,
  options: RecordingProviderOptions = {},
): RecordingProvider {
  const nowIso = options.nowIso ?? (() => new Date().toISOString())
  const turns: RecordedTurn[] = []
  const createdAt = nowIso()

  return {
    name: inner.name,
    model: inner.model,
    contextLimit: inner.contextLimit,
    async *stream(opts: ProviderStreamOptions): AsyncIterable<ProviderEvent> {
      const captured: RecordedTurn = []
      for await (const event of inner.stream(opts)) {
        captured.push(event)
        yield event
      }
      turns.push(captured)
      options.onTurn?.(captured)
    },
    getRecording() {
      return {
        version: 1,
        provider: inner.name,
        model: inner.model,
        createdAt,
        turns: turns.map((t) => [...t]),
      }
    },
  }
}
