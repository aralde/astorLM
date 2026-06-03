import type { Span, SpanExporter, SpanKind } from '../types.js'

/**
 * OTLP/HTTP (JSON) span exporter, implemented with `fetch` only — no
 * OpenTelemetry SDK dependency. Works against any OTLP-compatible collector:
 * the OpenTelemetry Collector, Grafana Tempo, Honeycomb, Arize Phoenix,
 * Langfuse, etc.
 *
 * Spans are buffered and flushed by batch size or on a timer; the exporter our
 * tracer calls receives one span at a time, so batching here avoids one POST
 * per span. Trace/span ids are forwarded as hex strings, which is exactly what
 * the OTLP/JSON encoding mandates for the `trace_id`/`span_id` byte fields.
 */
export interface OtlpSpanExporterOptions {
  /** Full traces endpoint, e.g. `http://localhost:4318/v1/traces`. */
  endpoint: string
  /** Extra headers (auth tokens, vendor keys). */
  headers?: Record<string, string>
  /** `service.name` resource attribute. Default `'astorlm'`. */
  serviceName?: string
  /** Instrumentation scope name. Default `'astorlm.tracing'`. */
  scopeName?: string
  /** Instrumentation scope version. */
  scopeVersion?: string
  /** Flush the buffer every N ms. `0`/`Infinity` disables the timer (manual `flush()`). Default 5000. */
  flushIntervalMs?: number
  /** Flush as soon as the buffer reaches this many spans. Default 256. */
  maxBatch?: number
  /** `fetch` override (tests, custom agents). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Called when a flush POST fails. Spans in the failed batch are dropped. */
  onError?: (err: unknown) => void
}

export interface OtlpSpanExporter extends SpanExporter {
  /** Sends any buffered spans now and resolves when the POST settles. */
  flush(): Promise<void>
  /** Stops the timer and flushes once. Call before process exit. */
  shutdown(): Promise<void>
}

// OTel SpanKind numeric codes (proto enum).
const OTEL_KIND: Record<SpanKind, number> = {
  session: 1, // INTERNAL
  turn: 1, // INTERNAL
  provider_call: 3, // CLIENT
  tool_execution: 1, // INTERNAL
}

/** Epoch ms → unix nanoseconds as a decimal string (OTLP/JSON int64 convention). */
function toUnixNano(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString()
}

/** Maps a JS value to an OTLP `AnyValue`. Integers use intValue (string); the rest fall back to JSON. */
function toAnyValue(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') return { stringValue: v }
  if (typeof v === 'boolean') return { boolValue: v }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toAnyValue) } }
  return { stringValue: JSON.stringify(v) }
}

function toAttributes(attrs: Record<string, unknown>): Array<{ key: string; value: unknown }> {
  return Object.entries(attrs).map(([key, v]) => ({ key, value: toAnyValue(v) }))
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function toOtlpSpan(span: Span): Record<string, unknown> {
  const status =
    span.status === 'error'
      ? { code: 2, message: errorMessage(span.error) } // STATUS_CODE_ERROR
      : span.status === 'ok'
        ? { code: 1 } // STATUS_CODE_OK
        : { code: 0 } // STATUS_CODE_UNSET

  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: OTEL_KIND[span.kind],
    startTimeUnixNano: toUnixNano(span.startTime),
    endTimeUnixNano: toUnixNano(span.endTime ?? span.startTime),
    attributes: toAttributes(span.attributes),
    status,
  }
}

export function createOtlpSpanExporter(options: OtlpSpanExporterOptions): OtlpSpanExporter {
  const {
    endpoint,
    headers = {},
    serviceName = 'astorlm',
    scopeName = 'astorlm.tracing',
    scopeVersion,
    flushIntervalMs = 5000,
    maxBatch = 256,
    fetch: fetchImpl = globalThis.fetch,
    onError,
  } = options

  if (!endpoint) throw new Error('createOtlpSpanExporter requires an `endpoint`.')
  if (typeof fetchImpl !== 'function') {
    throw new Error('createOtlpSpanExporter: no `fetch` available; pass one via options.fetch.')
  }

  let buffer: Span[] = []
  let timer: ReturnType<typeof setInterval> | undefined

  function buildPayload(spans: Span[]): unknown {
    return {
      resourceSpans: [
        {
          resource: {
            attributes: toAttributes({ 'service.name': serviceName }),
          },
          scopeSpans: [
            {
              scope: { name: scopeName, ...(scopeVersion ? { version: scopeVersion } : {}) },
              spans: spans.map(toOtlpSpan),
            },
          ],
        },
      ],
    }
  }

  async function flush(): Promise<void> {
    if (buffer.length === 0) return
    const batch = buffer
    buffer = []
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(buildPayload(batch)),
      })
      if (!res.ok) throw new Error(`OTLP export failed: HTTP ${res.status}`)
    } catch (err) {
      onError?.(err)
    }
  }

  if (flushIntervalMs > 0 && Number.isFinite(flushIntervalMs)) {
    timer = setInterval(() => {
      void flush()
    }, flushIntervalMs)
    // Don't keep the Node event loop alive just for the flush timer.
    ;(timer as { unref?: () => void }).unref?.()
  }

  return {
    export(spans) {
      buffer.push(...spans)
      if (buffer.length >= maxBatch) void flush()
    },
    flush,
    async shutdown() {
      if (timer) clearInterval(timer)
      timer = undefined
      await flush()
    },
  }
}
