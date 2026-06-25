import type { AgentEvent, AgentEventListener } from '../types.js'

/** Minimal, synchronous pub/sub. */
export class EventBus {
  private listeners = new Set<AgentEventListener>()

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: AgentEvent): void {
    for (const l of this.listeners) {
      try {
        l(event)
      } catch {
        // A broken listener must not break the loop.
      }
    }
  }
}
