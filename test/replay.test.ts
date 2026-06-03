import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent } from '../src/agent/session.js'
import { tool } from '../src/tools/define.js'
import {
  createRecordingProvider,
  createReplayProvider,
} from '../src/experimental/replay/index.js'
import { MockProvider } from './mock-provider.js'

function makeProvider() {
  return new MockProvider([
    {
      text: 'let me check',
      toolCalls: [{ id: 't1', name: 'echo', input: { s: 'hi' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 3 },
    },
    { text: 'final answer', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 5 } },
  ])
}

const echo = tool({
  name: 'echo',
  description: 'echoes',
  schema: z.object({ s: z.string() }),
  execute: async ({ s }) => `echo:${s}`,
})

describe('record & replay', () => {
  it('records provider events turn by turn and replays them deterministically', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-replay-'))

    // 1. Record a real (mock) run.
    const recorder = createRecordingProvider(makeProvider())
    const agent = await createAgent({ provider: recorder, cwd: dir, tools: [echo] })
    const original = await agent.run('do the thing')

    const recording = recorder.getRecording()
    expect(recording.turns).toHaveLength(2)
    expect(recording.model).toBe('mock-1')
    // Round-trips through JSON like a persisted file.
    const persisted = JSON.parse(JSON.stringify(recording))

    // 2. Replay it with no model at all.
    const replayProvider = createReplayProvider(persisted)
    const replayAgent = await createAgent({ provider: replayProvider, cwd: dir, tools: [echo] })
    const replayed = await replayAgent.run('do the thing')

    // Same final assistant text both times.
    const textOf = (m: typeof original) =>
      m.content.filter((b) => b.type === 'text').map((b: any) => b.text).join('')
    expect(textOf(replayed)).toBe(textOf(original))
    expect(textOf(replayed)).toContain('final answer')
  })

  it('throws when the loop asks for more turns than recorded (default)', async () => {
    const recording = {
      version: 1 as const,
      provider: 'mock',
      model: 'mock-1',
      createdAt: new Date().toISOString(),
      // Only a tool_use turn — the loop will want a second turn that isn't there.
      turns: [
        [
          { type: 'tool_use_start', id: 't1', name: 'echo' },
          { type: 'tool_use_end', id: 't1', name: 'echo', input: { s: 'hi' } },
          {
            type: 'message_end',
            stopReason: 'tool_use',
            assistantMessage: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 't1', name: 'echo', input: { s: 'hi' } }],
            },
          },
        ],
      ],
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-replay-'))
    const agent = await createAgent({
      provider: createReplayProvider(recording as any),
      cwd: dir,
      tools: [echo],
    })
    await expect(agent.run('go')).rejects.toThrow(/Replay exhausted/)
  })

  it('ends gracefully with onExhausted: "end"', async () => {
    const recording = {
      version: 1 as const,
      provider: 'mock',
      model: 'mock-1',
      createdAt: new Date().toISOString(),
      turns: [
        [
          { type: 'tool_use_start', id: 't1', name: 'echo' },
          { type: 'tool_use_end', id: 't1', name: 'echo', input: { s: 'hi' } },
          {
            type: 'message_end',
            stopReason: 'tool_use',
            assistantMessage: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 't1', name: 'echo', input: { s: 'hi' } }],
            },
          },
        ],
      ],
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-replay-'))
    const agent = await createAgent({
      provider: createReplayProvider(recording as any, { onExhausted: 'end' }),
      cwd: dir,
      tools: [echo],
    })
    const final = await agent.run('go')
    expect(final.role).toBe('assistant')
  })
})
