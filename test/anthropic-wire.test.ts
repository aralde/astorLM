import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../src/provider/anthropic.js'
import type { ProviderEvent } from '../src/types.js'

/**
 * Wire-level tests for `AnthropicProvider`.
 *
 * Like `openai-wire.test.ts`, this runs against a real (minimal) HTTP server
 * speaking the Anthropic streaming protocol, so the assertions cover the
 * request body the provider actually sends — the part no mock-driven test can
 * reach, and the part that drifts as the API evolves.
 */

interface CapturedRequest {
  body: Record<string, unknown>
}

function sse(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('AnthropicProvider over HTTP', () => {
  let server: Server
  let baseURL: string
  const requests: CapturedRequest[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (d) => {
        raw += d
      })
      req.on('end', () => {
        requests.push({ body: JSON.parse(raw || '{}') as Record<string, unknown> })

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.write(
          sse('message_start', {
            message: {
              id: 'msg_test',
              type: 'message',
              role: 'assistant',
              model: 'test-model',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          }),
        )
        res.write(
          sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        )
        res.write(
          sse('content_block_delta', {
            index: 0,
            delta: { type: 'text_delta', text: 'Hello' },
          }),
        )
        res.write(sse('content_block_stop', { index: 0 }))
        res.write(
          sse('message_delta', {
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 3 },
          }),
        )
        res.write(sse('message_stop', {}))
        res.end()
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    baseURL = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )
  })

  function provider(extra: Record<string, unknown> = {}) {
    return new AnthropicProvider({
      model: 'test-model',
      apiKey: 'test-key',
      baseURL,
      ...extra,
    })
  }

  function streamOnce(p: AnthropicProvider) {
    return collect(
      p.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] }),
    )
  }

  it('streams text and reports usage', async () => {
    const events = await streamOnce(provider())

    expect(events.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'Hello' },
    ])

    const end = events.at(-1)
    expect(end).toMatchObject({ type: 'message_end', stopReason: 'end_turn' })
    expect(end).toMatchObject({ usage: { inputTokens: 5, outputTokens: 3 } })
  })

  it('sends adaptive thinking and effort in the request body', async () => {
    requests.length = 0
    await streamOnce(
      provider({ thinking: { type: 'adaptive', display: 'summarized' }, effort: 'xhigh' }),
    )

    expect(requests[0]?.body).toMatchObject({
      model: 'test-model',
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'xhigh' },
    })
  })

  it('still supports the fixed thinking budget for older models', async () => {
    requests.length = 0
    await streamOnce(provider({ thinking: { budget_tokens: 2048 } }))

    expect(requests[0]?.body).toMatchObject({
      thinking: { type: 'enabled', budget_tokens: 2048 },
    })
    // Effort is not implied by a thinking budget.
    expect(requests[0]?.body).not.toHaveProperty('output_config')
  })

  it('omits thinking and effort when neither is configured', async () => {
    requests.length = 0
    await streamOnce(provider())

    expect(requests[0]?.body).not.toHaveProperty('thinking')
    expect(requests[0]?.body).not.toHaveProperty('output_config')
  })

  it('exposes a conservative context limit that callers can raise', () => {
    expect(provider().contextLimit).toBe(200000)
    expect(provider({ contextLimit: 1_000_000 }).contextLimit).toBe(1_000_000)
  })
})
