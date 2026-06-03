/**
 * Experimental `tracing` module.
 *
 * ⚠️ Volatile API. Signatures may change between minor releases. What is
 * stable: the conceptual primitives (Tracer / Span / SpanExporter) and the
 * bus-derived span tree (session → turn → provider_call | tool_execution).
 *
 * Runtime-agnostic: the span derivation reads only the agent event bus and uses
 * Web Crypto for ids. The OpenTelemetry/OTLP exporter (Node) ships separately
 * under a `./otel` subpath in a later release.
 *
 * Design notes: see the observability roadmap (tracing → OTel) under .docs/.
 */
export { createTracer } from './tracer.js'
export type { CreateTracerOptions } from './tracer.js'
export { attachTracer } from './busTracer.js'
export type { AttachTracerOptions, AttachedTracer } from './busTracer.js'
export { createInMemoryExporter } from './inMemoryExporter.js'
export type { InMemoryExporter } from './inMemoryExporter.js'
export type {
  Span,
  SpanKind,
  SpanStatus,
  SpanExporter,
  SpanHandle,
  StartSpanOptions,
  Tracer,
  TraceableAgent,
} from './types.js'
