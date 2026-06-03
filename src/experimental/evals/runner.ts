import type { Message } from '../../types.js'
import type {
  EvalCase,
  EvalReport,
  EvalRunResult,
  EvaluableAgent,
  Scorer,
  ScoredCase,
} from './types.js'

export interface RunEvalOptions {
  /** The cases to evaluate. */
  dataset: EvalCase[]
  /**
   * Builds a FRESH agent per case — each case must run in isolation (no shared
   * history). Receives the case so you can tailor tools/prompt if needed.
   */
  createAgent: (testCase: EvalCase) => Promise<EvaluableAgent>
  /** Scorers applied to every case result. */
  scorers: Scorer[]
  /** Max cases evaluated in parallel. Default 1 (sequential). */
  concurrency?: number
  /** Called as each case finishes scoring (progress / streaming reports). */
  onResult?: (scored: ScoredCase) => void
}

function finalText(message: Message): string {
  return message.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

async function runCase(testCase: EvalCase, options: RunEvalOptions): Promise<ScoredCase> {
  const toolCalls: EvalRunResult['toolCalls'] = []
  let result: EvalRunResult

  try {
    const agent = await options.createAgent(testCase)
    const off = agent.on('event', (e) => {
      if (e.type === 'tool_execution_start') toolCalls.push({ name: e.name, input: e.input })
    })
    try {
      const final = await agent.run(testCase.input)
      result = {
        case: testCase,
        output: finalText(final),
        toolCalls,
        finalMessage: final,
        usage: agent.getUsage?.(),
      }
    } finally {
      off()
    }
  } catch (error) {
    result = { case: testCase, output: '', toolCalls, error }
  }

  const scores = await Promise.all(options.scorers.map((s) => s.score(result)))
  const scored: ScoredCase = { result, scores, passed: scores.every((s) => s.passed) }
  options.onResult?.(scored)
  return scored
}

/** Simple bounded-concurrency map over the dataset, preserving input order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) break
      results[i] = await fn(items[i] as T)
    }
  })
  await Promise.all(workers)
  return results
}

function summarize(cases: ScoredCase[], scorers: Scorer[]): EvalReport['summary'] {
  const total = cases.length
  const passed = cases.filter((c) => c.passed).length
  const byScorer: EvalReport['summary']['byScorer'] = {}
  for (const scorer of scorers) {
    const relevant = cases.map((c) => c.scores.find((s) => s.scorer === scorer.name)).filter((s): s is NonNullable<typeof s> => !!s)
    const avg = relevant.length ? relevant.reduce((n, s) => n + s.score, 0) / relevant.length : 0
    const passRate = relevant.length ? relevant.filter((s) => s.passed).length / relevant.length : 0
    byScorer[scorer.name] = { avg, passRate }
  }
  return { total, passed, passRate: total ? passed / total : 0, byScorer }
}

/**
 * Runs every case through a fresh agent, applies the scorers, and aggregates a
 * report. Deterministic ordering regardless of concurrency. Pair the agent
 * factory with {@link createReplayProvider} for fast, network-free regression
 * runs, or with a live provider for real evaluation.
 */
export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const cases = await mapPool(options.dataset, options.concurrency ?? 1, (c) => runCase(c, options))
  return { cases, summary: summarize(cases, options.scorers) }
}
