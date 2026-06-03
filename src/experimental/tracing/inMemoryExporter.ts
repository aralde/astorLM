import type { Span, SpanExporter } from './types.js'

export interface InMemoryExporter extends SpanExporter {
  /** Spans collected so far, in completion order. */
  readonly spans: Span[]
  /** Returns the root span (kind `session`) if one was recorded. */
  root(): Span | undefined
  /** Direct children of a span, in completion order. */
  childrenOf(spanId: string): Span[]
  clear(): void
}

/**
 * Collects finished spans in an array. Intended for tests and local inspection;
 * not for production volume (it never evicts).
 */
export function createInMemoryExporter(): InMemoryExporter {
  const spans: Span[] = []
  return {
    spans,
    export(batch) {
      spans.push(...batch)
    },
    root() {
      return spans.find((s) => s.kind === 'session')
    },
    childrenOf(spanId) {
      return spans.filter((s) => s.parentSpanId === spanId)
    },
    clear() {
      spans.length = 0
    },
  }
}
