import type {
  Span,
  SpanExporter,
  SpanHandle,
  StartSpanOptions,
  Tracer,
} from './types.js'

export interface CreateTracerOptions {
  /** Reuse an existing trace id (e.g. to correlate with an upstream request). */
  traceId?: string
  /** Sink for finished spans. Omit for a tracer that only builds spans in place. */
  exporter?: SpanExporter
  /** Clock override (epoch ms). Defaults to `Date.now`. Useful for deterministic tests. */
  now?: () => number
}

/** Web-Crypto-backed random hex of `bytes` length, runtime-agnostic (Node 20+, browsers). */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(arr)
  let out = ''
  for (const b of arr) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Creates a {@link Tracer}. The tracer is a thin span factory: it stamps a
 * shared trace id, generates span ids, and forwards each span to the exporter
 * when it ends. It does not infer parent/child relationships — the caller
 * supplies `parentSpanId`. See {@link attachTracer} for the bus-driven wiring.
 */
export function createTracer(options: CreateTracerOptions = {}): Tracer {
  const now = options.now ?? Date.now
  const traceId = options.traceId ?? randomHex(16)
  const exporter = options.exporter

  return {
    traceId,
    startSpan(opts: StartSpanOptions): SpanHandle {
      const span: Span = {
        traceId,
        spanId: randomHex(8),
        parentSpanId: opts.parentSpanId,
        name: opts.name,
        kind: opts.kind,
        startTime: opts.startTime ?? now(),
        attributes: { ...opts.attributes },
        status: 'unset',
      }

      let ended = false

      return {
        span,
        setAttributes(attrs) {
          Object.assign(span.attributes, attrs)
        },
        setStatus(status, error) {
          span.status = status
          if (status === 'error' && error !== undefined) span.error = error
        },
        end(endTime) {
          if (ended) return
          ended = true
          span.endTime = endTime ?? now()
          // A broken exporter must not break the agent loop.
          try {
            exporter?.export([span])
          } catch {
            /* swallow */
          }
        },
      }
    },
  }
}
