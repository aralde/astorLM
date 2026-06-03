import type { ProviderEvent } from '../../types.js'

/** The ordered provider events produced during a single `stream()` call (one turn). */
export type RecordedTurn = ProviderEvent[]

/**
 * A serializable capture of every provider event a run produced, turn by turn.
 * Replaying it reproduces the exact model output without hitting the network —
 * the deterministic debugging primitive.
 */
export interface Recording {
  /** Format version, for forward compatibility. */
  version: 1
  provider: string
  model: string
  /** ISO timestamp of when recording started. */
  createdAt: string
  turns: RecordedTurn[]
}
