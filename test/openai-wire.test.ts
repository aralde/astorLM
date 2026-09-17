import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent } from '../src/agent/session.js'
import { OpenAIProvider } from '../src/provider/openai.js'
import { tool } from '../src/tools/define.js'

/**
 * Wire-level tests for `OpenAIProvider`.
 *
 * The rest of the suite drives the loop through `mock-provider.ts`, which stops
 * short of the SDK: it never exercises the HTTP request the provider builds or
 * the SSE stream it parses back. Those are exactly the parts that move when the
 * `openai` dependency crosses a major version, so this file stands up a real
 * (if minimal) OpenAI-compatible server and runs the agent against it.
 *
 * What it covers: the request body the provider sends, streamed text deltas,
 * a streamed tool call reassembled from `arguments` fragments, the tool result
 * round-trip, and usage reported on the final chunk.
 */

interface CapturedRequest {
  path: string
  authorization?: string
  body: Record<string, unknown>
}

/** One SSE frame, as an OpenAI-compatible server writes it. */
function chunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake-model',
    ...payload,
  })}\n\n`
}

describe('OpenAIProvider over HTTP', () => {
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
        const body = JSON.parse(raw || '{}') as Record<string, unknown>
        requests.push({
          path: req.url ?? '',
          authorization: req.headers.authorization,
          body,
        })

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })

        const isFirstTurn = requests.length === 1

        if (isFirstTurn) {
          // Turn 1: a tool call, with the arguments split across frames the way
          // a real server streams them.
          res.write(
            chunk({
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_abc',
                        type: 'function',
                        function: { name: 'get_weather', arguments: '' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
          )
          for (const fragment of ['{"ci', 'ty":"Buenos ', 'Aires"}']) {
            res.write(
              chunk({
                choices: [
                  {
                    index: 0,
                    delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] },
                    finish_reason: null,
                  },
                ],
              }),
            )
          }
          res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
          res.write(
            chunk({
              choices: [],
              usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
            }),
          )
        } else {
          // Turn 2: plain text, streamed token by token.
          for (const piece of ['It is ', '22C and ', 'sunny.']) {
            res.write(
              chunk({
                choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
              }),
            )
          }
          res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
          res.write(
            chunk({
              choices: [],
              usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
            }),
          )
        }

        res.write('data: [DONE]\n\n')
        res.end()
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    baseURL = `http://127.0.0.1:${port}/v1`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )
  })

  it('completes a tool-calling turn against a real HTTP endpoint', async () => {
    const executed: string[] = []

    const getWeather = tool({
      name: 'get_weather',
      description: 'Returns the current temperature for a city',
      schema: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        executed.push(city)
        return `Weather in ${city}: 22C, sunny.`
      },
    })

    const agent = await createAgent({
      provider: new OpenAIProvider({ model: 'fake-model', baseURL, apiKey: 'test-key' }),
      tools: [getWeather],
    })

    let streamed = ''
    agent.on('text', (text) => {
      streamed += text
    })

    const result = await agent.run('How is the weather in Buenos Aires?')

    // The tool call survived being split across SSE frames and parsed as JSON.
    expect(executed).toEqual(['Buenos Aires'])
    // Text deltas reached the subscriber, not just the final message.
    expect(streamed).toBe('It is 22C and sunny.')

    // The returned assistant message carries the same text as the stream.
    const finalText = result.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('')
    expect(finalText).toBe('It is 22C and sunny.')

    // Usage accumulated across both turns of the run.
    expect(agent.getUsage()).toMatchObject({ inputTokens: 31, outputTokens: 12 })
  })

  it('sends a well-formed request the server can act on', () => {
    const [first, second] = requests
    expect(requests).toHaveLength(2)

    expect(first.path).toBe('/v1/chat/completions')
    expect(first.authorization).toBe('Bearer test-key')
    expect(first.body).toMatchObject({
      model: 'fake-model',
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
    })

    // Tools are advertised in the OpenAI function shape.
    const tools = first.body['tools'] as Array<Record<string, any>>
    expect(tools[0]).toMatchObject({ type: 'function', function: { name: 'get_weather' } })
    expect(tools[0]['function']['parameters']).toMatchObject({ type: 'object' })

    // The second turn carries the assistant tool call and its result back.
    const messages = second.body['messages'] as Array<Record<string, any>>
    const assistant = messages.find((m) => m['role'] === 'assistant')
    expect(assistant?.['tool_calls']?.[0]).toMatchObject({
      id: 'call_abc',
      function: { name: 'get_weather' },
    })
    const toolResult = messages.find((m) => m['role'] === 'tool')
    expect(toolResult).toMatchObject({ tool_call_id: 'call_abc' })
    expect(String(toolResult?.['content'])).toContain('22C')
  })
})
