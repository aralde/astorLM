import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent } from '../src/agent/session.js'
import { tool } from '../src/tools/define.js'
import {
  runEval,
  exactMatch,
  contains,
  regexMatch,
  toolTrajectory,
  llmJudge,
  type EvalRunResult,
} from '../src/experimental/evals/index.js'
import { MockProvider } from './mock-provider.js'

const baseResult = (over: Partial<EvalRunResult> = {}): EvalRunResult => ({
  case: { id: 'c1', input: 'q', expected: 'Hello World' },
  output: 'Hello World',
  toolCalls: [],
  ...over,
})

describe('scorers', () => {
  it('exactMatch normalizes case + whitespace by default', async () => {
    const s = await exactMatch().score(baseResult({ output: '  hello world  ' }))
    expect(s.passed).toBe(true)
  })

  it('contains and regexMatch', async () => {
    expect((await contains('world').score(baseResult())).passed).toBe(true)
    expect((await regexMatch(/^Hello/).score(baseResult())).passed).toBe(true)
    expect((await regexMatch(/^bye/).score(baseResult())).passed).toBe(false)
  })

  it('toolTrajectory modes', async () => {
    const r = baseResult({ toolCalls: [{ name: 'ls', input: {} }, { name: 'read', input: {} }] })
    expect((await toolTrajectory(['ls', 'read']).score(r)).score).toBe(1)
    expect((await toolTrajectory(['read']).score(r)).passed).toBe(false) // exact mode, length mismatch
    expect((await toolTrajectory(['read'], { mode: 'set' }).score(r)).score).toBe(1)
    expect((await toolTrajectory(['ls', 'grep'], { mode: 'set' }).score(r)).score).toBe(0.5)
  })

  it('llmJudge parses a JSON verdict on a 0..10 scale and normalizes', async () => {
    const judgeProvider = new MockProvider([{ text: '{"score": 8, "reason": "accurate"}', stopReason: 'end_turn' }])
    const scorer = llmJudge({ provider: judgeProvider, rubric: 'Reward accuracy.', passThreshold: 0.7 })
    const s = await scorer.score(baseResult())
    expect(s.score).toBeCloseTo(0.8, 5)
    expect(s.passed).toBe(true)
    expect(s.details).toBe('accurate')
  })

  it('llmJudge fails closed on unparseable output', async () => {
    const judgeProvider = new MockProvider([{ text: 'I think it is pretty good honestly', stopReason: 'end_turn' }])
    const s = await llmJudge({ provider: judgeProvider, rubric: 'x' }).score(baseResult())
    expect(s.passed).toBe(false)
    expect(s.score).toBe(0)
  })
})

describe('runEval', () => {
  it('runs each case through a fresh agent and aggregates a report', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-evals-'))
    const echo = tool({
      name: 'echo',
      description: 'echoes',
      schema: z.object({ s: z.string() }),
      execute: async ({ s }) => `echo:${s}`,
    })

    const dataset = [
      { id: 'good', input: 'say hi', expected: 'hello there' },
      { id: 'bad', input: 'say bye', expected: 'hello there' },
    ]

    const report = await runEval({
      dataset,
      concurrency: 2,
      createAgent: async (c) => {
        // Each case gets a fresh scripted agent: 'good' answers correctly.
        const text = c.id === 'good' ? 'hello there' : 'goodbye'
        const provider = new MockProvider([
          { toolCalls: [{ id: 't1', name: 'echo', input: { s: 'x' } }], stopReason: 'tool_use' },
          { text, stopReason: 'end_turn' },
        ])
        return createAgent({ provider, cwd: dir, tools: [echo] })
      },
      scorers: [exactMatch(), toolTrajectory(['echo'])],
    })

    expect(report.summary.total).toBe(2)
    expect(report.summary.passed).toBe(1)
    expect(report.summary.passRate).toBe(0.5)
    // Both cases used the echo tool, so trajectory passes for both.
    expect(report.summary.byScorer.tool_trajectory.passRate).toBe(1)
    expect(report.summary.byScorer.exact_match.passRate).toBe(0.5)
    // Order preserved despite concurrency.
    expect(report.cases.map((c) => c.result.case.id)).toEqual(['good', 'bad'])
    expect(report.cases[0].result.toolCalls.map((t) => t.name)).toEqual(['echo'])
  })

  it('captures errors as a failed case instead of throwing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-evals-'))
    const report = await runEval({
      dataset: [{ id: 'boom', input: 'x' }],
      createAgent: async () => {
        // A provider with no scripted turns throws inside the loop.
        const provider = new MockProvider([])
        return createAgent({ provider, cwd: dir })
      },
      scorers: [contains('anything')],
    })
    expect(report.summary.passed).toBe(0)
    expect(report.cases[0].result.error).toBeDefined()
  })
})
