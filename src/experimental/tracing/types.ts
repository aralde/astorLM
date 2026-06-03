import type { AgentEvent } from '../../types.js'

/**
 * Span kinds produced by the bus-derived tracer. The hierarchy is:
 * `session` → `turn` → (`provider_call` | `tool_execution`).
 */
export type SpanKind = 'session' | 'turn' | 'provider_call' | 'tool_execution'

/** Terminal status of a span. `unset` means it ended without an explicit verdict. */
export type SpanStatus = 'ok' | 'error' | 'unset'

/**
 * A single tracing span. Ids are hex strings sized to match the OpenTelemetry
 * wire format (16-byte trace id, 8-byte span id) so the future OTLP exporter
 * can forward them without remapping.
 */
export interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: SpanKind
  /** Epoch milliseconds. */
  startTime: number
  /** Epoch milliseconds; set when the span ends. */
  endTime?: number
  attributes: Record<string, unknown>
  status: SpanStatus
  /** Present only when `status === 'error'`. */
  error?: unknown
}

/**
 * Sink for finished spans. Implementations forward spans somewhere
 * (memory, stdout, OTLP, a vendor SDK). `export` is called once per span as
 * it ends, receiving a single-element batch; it may be async.
 */
export interface SpanExporter {
  export(spans: Span[]): void | Promise<void>
}

export interface StartSpanOptions {
  name: string
  kind: SpanKind
  parentSpanId?: string
  attributes?: Record<string, unknown>
  /** Override the start timestamp (epoch ms). Defaults to the tracer clock. */
  startTime?: number
}

/** Mutable handle to an in-flight span. */
export interface SpanHandle {
  readonly span: Span
  setAttributes(attrs: Record<string, unknown>): void
  setStatus(status: SpanStatus, error?: unknown): void
  /** Closes the span and forwards it to the exporter (idempotent). */
  end(endTime?: number): void
}

/** Produces spans under a shared trace id and forwards finished ones to the exporter. */
export interface Tracer {
  readonly traceId: string
  startSpan(opts: StartSpanOptions): SpanHandle
}

/**
 * Minimal structural view of an Agent that the tracer needs. Kept structural so
 * the tracing module stays runtime-agnostic and decoupled from the full Agent
 * surface — any object exposing these three members can be traced.
 */
export interface TraceableAgent {
  readonly id: string
  readonly provider: { readonly name: string; readonly model: string }
  on(event: 'event', listener: (e: AgentEvent) => void): () => void
}
