/**
 * Experimental OTLP exporter for the tracing module.
 *
 * ⚠️ Volatile API. Ships separately from the core `tracing` barrel so the span
 * derivation stays free of any OTLP/wire concerns. Implemented with `fetch`
 * only — no OpenTelemetry SDK dependency. Forward astorlm spans to any
 * OTLP/HTTP collector (OpenTelemetry Collector, Tempo, Honeycomb, Phoenix,
 * Langfuse, …).
 *
 * ```ts
 * import { attachTracer } from 'astorlm/experimental/tracing'
 * import { createOtlpSpanExporter } from 'astorlm/experimental/tracing/otel'
 *
 * const exporter = createOtlpSpanExporter({ endpoint: 'http://localhost:4318/v1/traces' })
 * attachTracer(agent, { exporter })
 * // ... run the agent ...
 * await exporter.shutdown()
 * ```
 */
export { createOtlpSpanExporter } from './otlpExporter.js'
export type { OtlpSpanExporter, OtlpSpanExporterOptions } from './otlpExporter.js'
