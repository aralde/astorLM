import type { Provider, ProviderEvent, ProviderStreamOptions } from '../../types.js'
import { computeBackoffDelay, isAbortError } from '../../agent/retry.js'
import { GUARD_DEFAULTS, type GuardOptions, type ResolvedSampling } from './types.js'

/**
 * Thrown when the model stream degenerates (repeats garbage, stalls without
 * producing content, or blows the reasoning budget) and the guard's internal
 * retries are exhausted (or a retry is impossible because visible output was
 * already forwarded).
 *
 * A `DegenerationError` escaping the guard is NOT retried by the loop-level
 * `streamWithRetry` (events were already yielded and it is not a transient
 * network error): the guard owns degeneration retries, the loop policy owns
 * network/HTTP retries.
 */
export class DegenerationError extends Error {
  readonly reason: 'repetition' | 'stall' | 'reasoning-budget'
  readonly attempts: number
  constructor(reason: DegenerationError['reason'], attempts: number, message?: string) {
    super(message ?? `Model stream degenerated (${reason}) after ${attempts} attempt(s).`)
    this.name = 'DegenerationError'
    this.reason = reason
    this.attempts = attempts
  }
}

export interface CreateGuardedProviderOptions {
  /**
   * Guard rules. Omit for defaults (guard on). Pass `false` to disable all guard
   * rules — the wrapper then only injects sampling defaults, if any.
   */
  guard?: GuardOptions | false
  /**
   * Sampling defaults injected into each call when the incoming call omits them.
   * Values already present on the call always win.
   */
  sampling?: ResolvedSampling
}

interface EffectiveGuard {
  enabled: boolean
  maxRepeatedDeltas: number
  stallTimeoutMs: number
  maxThinkingChars: number
  maxAttempts: number
}

function resolveGuard(guard: GuardOptions | false | undefined): EffectiveGuard {
  if (guard === false) {
    return { enabled: false, maxRepeatedDeltas: 0, stallTimeoutMs: 0, maxThinkingChars: 0, maxAttempts: 1 }
  }
  const g = { ...GUARD_DEFAULTS, ...(guard ?? {}) }
  return {
    enabled: true,
    maxRepeatedDeltas: g.maxRepeatedDeltas,
    stallTimeoutMs: g.stallTimeoutMs,
    maxThinkingChars: g.maxThinkingChars,
    maxAttempts: Math.max(1, g.maxAttempts),
  }
}

/** Injects sampling defaults into the stream options without overriding present values. */
function applySampling(opts: ProviderStreamOptions, sampling?: ResolvedSampling): ProviderStreamOptions {
  if (!sampling) return opts
  const merged: ProviderStreamOptions = {
    ...opts,
    maxTokens: opts.maxTokens ?? sampling.maxTokens,
  }
  const s = {
    temperature: opts.sampling?.temperature ?? sampling.temperature,
    topP: opts.sampling?.topP ?? sampling.topP,
    frequencyPenalty: opts.sampling?.frequencyPenalty ?? sampling.frequencyPenalty,
    presencePenalty: opts.sampling?.presencePenalty ?? sampling.presencePenalty,
  }
  // Only attach sampling if at least one field is defined.
  if (Object.values(s).some((v) => v !== undefined)) merged.sampling = s
  return merged
}

/** Abortable sleep: resolves after ms, or rejects with AbortError if the signal fires. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const STALL_ABORT = 'edge-boost:stall'

/**
 * Wraps a {@link Provider} so it detects degenerate model streams and retries
 * cheaply against the same endpoint (following the `createRecordingProvider`
 * delegation pattern). It also injects sampling defaults.
 *
 * Detection (per attempt): identical-delta repetition (compared across
 * text_delta AND thinking_delta, trimmed), a stall timer that only productive
 * events reset, and a reasoning-token budget checked before any content appears.
 *
 * Forwarding: text/tool events are forwarded immediately; once visible output is
 * forwarded, a subsequent detection throws instead of retrying (retrying would
 * duplicate output). `thinking_delta` is also forwarded immediately, so an
 * internal retry may cause thinking to visibly restart — an accepted streaming
 * tradeoff.
 */
export function createGuardedProvider(inner: Provider, options: CreateGuardedProviderOptions = {}): Provider {
  const guard = resolveGuard(options.guard)
  const sampling = options.sampling

  return {
    name: inner.name,
    model: inner.model,
    contextLimit: inner.contextLimit,
    async *stream(opts: ProviderStreamOptions): AsyncIterable<ProviderEvent> {
      const effective = applySampling(opts, sampling)
      const maxAttempts = guard.maxAttempts

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Per-attempt controller chained to the outer signal.
        const attemptCtrl = new AbortController()
        const onOuterAbort = () => attemptCtrl.abort(opts.abortSignal.reason)
        if (opts.abortSignal.aborted) attemptCtrl.abort(opts.abortSignal.reason)
        else opts.abortSignal.addEventListener('abort', onOuterAbort, { once: true })

        // Detection state (reset each attempt).
        let lastTrim: string | null = null
        let repeatCount = 0
        let thinkingChars = 0
        let sawProductive = false
        let forwardedProductive = false
        let degeneration: DegenerationError['reason'] | null = null
        let stallTimer: ReturnType<typeof setTimeout> | undefined

        const armStall = () => {
          if (!guard.enabled || guard.stallTimeoutMs <= 0) return
          if (stallTimer) clearTimeout(stallTimer)
          stallTimer = setTimeout(() => {
            degeneration = 'stall'
            attemptCtrl.abort(STALL_ABORT)
          }, guard.stallTimeoutMs)
        }

        try {
          armStall()
          const innerOpts: ProviderStreamOptions = { ...effective, abortSignal: attemptCtrl.signal }
          for await (const ev of inner.stream(innerOpts)) {
            yield ev

            const productive =
              ev.type === 'text_delta' ||
              ev.type === 'tool_use_start' ||
              ev.type === 'tool_use_input' ||
              ev.type === 'tool_use_end' ||
              ev.type === 'message_end'
            if (
              ev.type === 'text_delta' ||
              ev.type === 'tool_use_start' ||
              ev.type === 'tool_use_input' ||
              ev.type === 'tool_use_end'
            ) {
              forwardedProductive = true
            }
            if (productive) {
              sawProductive = true
              armStall()
            }

            if (guard.enabled && (ev.type === 'text_delta' || ev.type === 'thinking_delta')) {
              const payload = ev.type === 'text_delta' ? ev.text : ev.thinking
              const trimmed = payload.trim()
              if (trimmed.length > 0 && trimmed === lastTrim) repeatCount++
              else repeatCount = 0
              lastTrim = trimmed

              if (ev.type === 'thinking_delta' && !sawProductive) {
                thinkingChars += payload.length
              }

              if (guard.maxRepeatedDeltas > 0 && repeatCount >= guard.maxRepeatedDeltas) {
                degeneration = 'repetition'
              } else if (
                guard.maxThinkingChars > 0 &&
                !sawProductive &&
                thinkingChars >= guard.maxThinkingChars
              ) {
                degeneration = 'reasoning-budget'
              }
            }

            if (degeneration) {
              attemptCtrl.abort(STALL_ABORT)
              break
            }
          }
        } catch (err) {
          // Genuine outer abort: propagate, never retry.
          if (opts.abortSignal.aborted && !degeneration) throw err
          if (isAbortError(err) && !degeneration) throw err
          // Not our degeneration and not an abort → a real provider/network error;
          // let it propagate (the loop-level retry policy owns those).
          if (!degeneration) throw err
          // Otherwise it is the abort we triggered for a detected degeneration —
          // swallow it and fall through to the degeneration handling below.
        } finally {
          if (stallTimer) clearTimeout(stallTimer)
          opts.abortSignal.removeEventListener('abort', onOuterAbort)
        }

        if (!degeneration) return // stream completed cleanly

        // Cannot retry once visible output was forwarded, or attempts are used up.
        if (forwardedProductive || attempt >= maxAttempts) {
          throw new DegenerationError(degeneration, attempt)
        }
        await abortableSleep(
          computeBackoffDelay(attempt, { maxAttempts, baseDelayMs: 500, maxDelayMs: 10_000 }),
          opts.abortSignal,
        )
        // loop → next attempt
      }
    },
  }
}
