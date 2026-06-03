import type { EvalRunResult, Score, Scorer } from './types.js'

function normalize(s: string, opts: { trim?: boolean; caseSensitive?: boolean }): string {
  let out = s
  if (opts.trim !== false) out = out.trim()
  if (!opts.caseSensitive) out = out.toLowerCase()
  return out
}

function expectedString(result: EvalRunResult, override?: unknown): string | undefined {
  const value = override ?? result.case.expected
  return value === undefined || value === null ? undefined : String(value)
}

export interface MatchOptions {
  /** Override the expected value instead of reading `case.expected`. */
  expected?: unknown
  /** Trim whitespace before comparing. Default true. */
  trim?: boolean
  /** Case-sensitive comparison. Default false. */
  caseSensitive?: boolean
}

/** Passes when the output equals the expected value (after normalization). */
export function exactMatch(options: MatchOptions = {}): Scorer {
  return {
    name: 'exact_match',
    score(result): Score {
      const expected = expectedString(result, options.expected)
      if (expected === undefined) {
        return { scorer: 'exact_match', score: 0, passed: false, details: 'no expected value' }
      }
      const a = normalize(result.output, options)
      const b = normalize(expected, options)
      const passed = a === b
      return { scorer: 'exact_match', score: passed ? 1 : 0, passed }
    },
  }
}

/** Passes when the output contains the expected substring. */
export function contains(substring?: string, options: MatchOptions = {}): Scorer {
  return {
    name: 'contains',
    score(result): Score {
      const needle = substring ?? expectedString(result, options.expected)
      if (needle === undefined) {
        return { scorer: 'contains', score: 0, passed: false, details: 'no substring/expected' }
      }
      const haystack = normalize(result.output, options)
      const passed = haystack.includes(normalize(needle, options))
      return { scorer: 'contains', score: passed ? 1 : 0, passed }
    },
  }
}

/** Passes when the regular expression matches the output. */
export function regexMatch(pattern: RegExp): Scorer {
  return {
    name: 'regex_match',
    score(result): Score {
      const passed = pattern.test(result.output)
      return { scorer: 'regex_match', score: passed ? 1 : 0, passed }
    },
  }
}

export type TrajectoryMode = 'exact' | 'ordered-subset' | 'set'

/**
 * Scores the sequence of tool names the agent invoked against an expected list.
 *  - `'exact'`: same names in the same order (1 or 0).
 *  - `'ordered-subset'`: every expected name appears in order (extras allowed);
 *    score is the fraction matched.
 *  - `'set'`: every expected name appears at least once, order ignored; score is
 *    the fraction of expected names present.
 */
export function toolTrajectory(
  expectedTools: string[],
  options: { mode?: TrajectoryMode; passThreshold?: number } = {},
): Scorer {
  const mode = options.mode ?? 'exact'
  const passThreshold = options.passThreshold ?? 1
  return {
    name: 'tool_trajectory',
    score(result): Score {
      const actual = result.toolCalls.map((t) => t.name)
      let score = 0
      if (mode === 'exact') {
        score = actual.length === expectedTools.length && actual.every((n, i) => n === expectedTools[i]) ? 1 : 0
      } else if (mode === 'set') {
        const present = expectedTools.filter((n) => actual.includes(n)).length
        score = expectedTools.length ? present / expectedTools.length : 1
      } else {
        // ordered-subset
        let i = 0
        for (const name of actual) if (name === expectedTools[i]) i += 1
        score = expectedTools.length ? i / expectedTools.length : 1
      }
      return {
        scorer: 'tool_trajectory',
        score,
        passed: score >= passThreshold,
        details: `expected [${expectedTools.join(', ')}] vs actual [${actual.join(', ')}] (${mode})`,
      }
    },
  }
}
