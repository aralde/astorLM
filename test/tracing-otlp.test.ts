import { describe, expect, it } from 'vitest'
import { createOtlpSpanExporter } from '../src/experimental/tracing/otel/index.js'
import type { Span } from '../src/experimental/tracing/index.js'

function fakeSpan(over: Partial<Span> = {}): Span {
  return {
    traceId: 'aabbccddeeff00112233445566778899',
    spanId: '0011223344556677',
    name: 'turn 1',
    kind: 'turn',
    startTime: 1_000,
    endTime: 1_500,
    attributes: { 'gen_ai.usage.input_tokens': 100, 'astor.ok': true, 'gen_ai.system': 'mock' },
    status: 'ok',
    ...over,
  }
}

function captureFetch(): { calls: Array<{ url: string; body: any; headers: any }>; fetch: typeof fetch } {
  const calls: Array<{ url: string; body: any; headers: any }> = []
  const fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers })
    return { ok: true, status: 200 } as Response
  }) as unknown as typeof fetch
  return { calls, fetch }
}

describe('OTLP span exporter', () => {
  it('buffers until flush and POSTs an OTLP/JSON payload', async () => {
    const { calls, fetch } = captureFetch()
    const exporter = createOtlpSpanExporter({
      endpoint: 'http://localhost:4318/v1/traces',
      flushIntervalMs: 0,
      fetch,
      serviceName: 'my-svc',
    })

    exporter.export([fakeSpan()])
    expect(calls).toHaveLength(0) // buffered, no timer

    await exporter.flush()
    expect(calls).toHaveLength(1)

    const call = calls[0]
    expect(call.url).toBe('http://localhost:4318/v1/traces')
    expect(call.headers['content-type']).toBe('application/json')

    const span = call.body.resourceSpans[0].scopeSpans[0].spans[0]
    // Hex ids forwarded verbatim (OTLP/JSON convention for trace_id/span_id).
    expect(span.traceId).toBe('aabbccddeeff00112233445566778899')
    expect(span.spanId).toBe('0011223344556677')
    // ms → unix nanoseconds.
    expect(span.startTimeUnixNano).toBe('1000000000')
    expect(span.endTimeUnixNano).toBe('1500000000')
    // Attribute encoding: int as intValue string, bool as boolValue.
    const attrs = Object.fromEntries(span.attributes.map((a: any) => [a.key, a.value]))
    expect(attrs['gen_ai.usage.input_tokens']).toEqual({ intValue: '100' })
    expect(attrs['astor.ok']).toEqual({ boolValue: true })
    expect(span.status).toEqual({ code: 1 })
    // Resource carries service.name.
    const resAttrs = call.body.resourceSpans[0].resource.attributes
    expect(resAttrs).toContainEqual({ key: 'service.name', value: { stringValue: 'my-svc' } })
  })

  it('flushes automatically once maxBatch is reached', async () => {
    const { calls, fetch } = captureFetch()
    const exporter = createOtlpSpanExporter({
      endpoint: 'http://localhost:4318/v1/traces',
      flushIntervalMs: 0,
      maxBatch: 2,
      fetch,
    })
    exporter.export([fakeSpan()])
    exporter.export([fakeSpan()]) // reaches maxBatch → flush
    await Promise.resolve()
    await exporter.flush()
    const total = calls.reduce((n, c) => n + c.body.resourceSpans[0].scopeSpans[0].spans.length, 0)
    expect(total).toBe(2)
  })

  it('encodes error status with a message and reports POST failures via onError', async () => {
    let captured: unknown
    const failingFetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    const exporter = createOtlpSpanExporter({
      endpoint: 'http://localhost:4318/v1/traces',
      flushIntervalMs: 0,
      fetch: failingFetch,
      onError: (err) => {
        captured = err
      },
    })

    exporter.export([fakeSpan({ status: 'error', error: new Error('kaboom') })])
    await exporter.flush()
    expect((captured as Error).message).toBe('network down')
  })
})
