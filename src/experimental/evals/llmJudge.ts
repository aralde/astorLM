import type { Provider } from '../../types.js'
import type { EvalRunResult, Score, Scorer } from './types.js'

export interface LlmJudgeOptions {
  /** Provider used to run the judge model (e.g. an OpenAIProvider). */
  provider: Provider
  /**
   * Rubric describing what a good answer looks like. Injected into the judge
   * prompt. Be specific — the judge only sees this, the input and the output.
   */
  rubric: string
  /** Minimum normalized score (0..1) to count as passing. Default 0.7. */
  passThreshold?: number
  /** Judge sampling cap. Default 512. */
  maxTokens?: number
  /** Override the judge's system prompt entirely. */
  systemPrompt?: string
}

const DEFAULT_SYSTEM_PROMPT =
  'You are a strict evaluator. Read the rubric, the task and the answer, then ' +
  'grade the answer. Respond with ONLY a JSON object: {"score": <0..10>, "reason": "<short>"}. ' +
  'No prose, no code fences.'

/** Collects the full assistant text from a single provider stream call. */
async function runJudge(provider: Provider, systemPrompt: string, userText: string, maxTokens: number): Promise<string> {
  let text = ''
  const controller = new AbortController()
  for await (const ev of provider.stream({
    systemPrompt,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    tools: [],
    abortSignal: controller.signal,
    maxTokens,
  })) {
    if (ev.type === 'text_delta') text += ev.text
    else if (ev.type === 'message_end') {
      for (const block of ev.assistantMessage.content) {
        if (block.type === 'text' && !text) text += block.text
      }
    }
  }
  return text
}

/** Extracts the first JSON object from a string and parses it. */
function parseVerdict(raw: string): { score: number; reason?: string } | undefined {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    const obj = JSON.parse(match[0]) as { score?: unknown; reason?: unknown }
    const n = Number(obj.score)
    if (!Number.isFinite(n)) return undefined
    // Accept 0..1 or 0..10; normalize the latter.
    const normalized = n > 1 ? n / 10 : n
    return { score: Math.max(0, Math.min(1, normalized)), reason: obj.reason ? String(obj.reason) : undefined }
  } catch {
    return undefined
  }
}

/**
 * LLM-as-judge scorer: asks a model to grade the agent's answer against a
 * rubric and returns a normalized 0..1 score. Robust to noisy output (extracts
 * the first JSON object; tolerates a 0..10 or 0..1 scale). Per the project
 * convention, point `provider` at a local OpenAI-compatible endpoint.
 */
export function llmJudge(options: LlmJudgeOptions): Scorer {
  const passThreshold = options.passThreshold ?? 0.7
  const maxTokens = options.maxTokens ?? 512
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT

  return {
    name: 'llm_judge',
    async score(result: EvalRunResult): Promise<Score> {
      const userText =
        `# Rubric\n${options.rubric}\n\n` +
        `# Task\n${result.case.input}\n\n` +
        (result.case.expected !== undefined ? `# Reference answer\n${String(result.case.expected)}\n\n` : '') +
        `# Answer to grade\n${result.output}`

      let raw: string
      try {
        raw = await runJudge(options.provider, systemPrompt, userText, maxTokens)
      } catch (err) {
        return { scorer: 'llm_judge', score: 0, passed: false, details: `judge error: ${String(err)}` }
      }

      const verdict = parseVerdict(raw)
      if (!verdict) {
        return { scorer: 'llm_judge', score: 0, passed: false, details: `unparseable verdict: ${raw.slice(0, 120)}` }
      }
      return {
        scorer: 'llm_judge',
        score: verdict.score,
        passed: verdict.score >= passThreshold,
        details: verdict.reason,
      }
    },
  }
}
