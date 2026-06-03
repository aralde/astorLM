import type { AgentEvent } from '../../types.js'
import { createTracer } from './tracer.js'
import type { SpanExporter, SpanHandle, Tracer, TraceableAgent } from './types.js'

export interface AttachTracerOptions {
  /** Sink for finished spans. Typically an in-memory exporter (tests) or OTLP. */
  exporter?: SpanExporter
  /** Clock override (epoch ms). Defaults to `Date.now`. */
  now?: () => number
}

export interface AttachedTracer {
  /** Unsubscribes from the bus. Open spans are left as-is (the run is over or abandoned). */
  detach(): void
  /** Trace id of the run currently in flight, or the most recent one. `undefined` before the first turn. */
  currentTraceId(): string | undefined
}

/**
 * Derives a span tree from an agent's event bus without touching the core loop
 * (strategy "A" — pure bus subscription). One trace per `agent.run()`:
 *
 * ```
 * session                         (one run)
 *   └─ turn                       (per turn_start/turn_end)
 *        ├─ provider_call         (turn_start → assistant_message; records TTFT)
 *        └─ tool_execution        (per tool_execution_start/end)
 * ```
 *
 * The provider span is approximate by design: with strategy A there is no
 * dedicated provider_call event, so it spans from the turn start until the
 * assistant message arrives. Time-to-first-token is captured as an attribute.
 */
export function attachTracer(
  agent: TraceableAgent,
  options: AttachTracerOptions = {},
): AttachedTracer {
  const now = options.now ?? Date.now

  // Per-run state. A run begins at the first turn_start with no open session
  // and ends at session_end.
  let tracer: Tracer | undefined
  let lastTraceId: string | undefined
  let sessionSpan: SpanHandle | undefined
  let turnSpan: SpanHandle | undefined
  let providerSpan: SpanHandle | undefined
  const toolSpans = new Map<string, SpanHandle>()
  let firstDeltaSeen = false
  let turnStartedAt = 0
  let retryCount = 0
  let steeringCount = 0

  const providerAttrs = {
    'gen_ai.system': agent.provider.name,
    'gen_ai.request.model': agent.provider.model,
  }

  function endTurnSpans(): void {
    for (const tool of toolSpans.values()) tool.end()
    toolSpans.clear()
    providerSpan?.end()
    providerSpan = undefined
    turnSpan?.end()
    turnSpan = undefined
  }

  function resetRun(): void {
    sessionSpan = undefined
    turnSpan = undefined
    providerSpan = undefined
    toolSpans.clear()
    tracer = undefined
  }

  function handle(e: AgentEvent): void {
    switch (e.type) {
      case 'turn_start': {
        if (!sessionSpan) {
          tracer = createTracer({ exporter: options.exporter, now })
          lastTraceId = tracer.traceId
          sessionSpan = tracer.startSpan({
            name: 'agent.session',
            kind: 'session',
            attributes: { 'astor.agent_id': agent.id, ...providerAttrs },
          })
        }
        turnStartedAt = now()
        firstDeltaSeen = false
        retryCount = 0
        steeringCount = 0
        turnSpan = tracer!.startSpan({
          name: `turn ${e.turn}`,
          kind: 'turn',
          parentSpanId: sessionSpan.span.spanId,
          attributes: { 'astor.turn': e.turn },
        })
        providerSpan = tracer!.startSpan({
          name: 'provider.stream',
          kind: 'provider_call',
          parentSpanId: turnSpan.span.spanId,
          attributes: { ...providerAttrs },
        })
        break
      }

      case 'text_delta':
      case 'thinking_delta': {
        if (providerSpan && !firstDeltaSeen) {
          firstDeltaSeen = true
          providerSpan.setAttributes({ 'astor.ttft_ms': now() - turnStartedAt })
        }
        break
      }

      case 'provider_retry': {
        retryCount += 1
        providerSpan?.setAttributes({ 'astor.provider_retries': retryCount })
        break
      }

      case 'assistant_message': {
        providerSpan?.setStatus('ok')
        providerSpan?.end()
        providerSpan = undefined
        break
      }

      case 'tool_execution_start': {
        if (!tracer || !turnSpan) break
        const span = tracer.startSpan({
          name: `tool ${e.name}`,
          kind: 'tool_execution',
          parentSpanId: turnSpan.span.spanId,
          attributes: { 'astor.tool.name': e.name, 'astor.tool.use_id': e.toolUseId },
        })
        toolSpans.set(e.toolUseId, span)
        break
      }

      case 'tool_execution_end': {
        const span = toolSpans.get(e.toolUseId)
        if (!span) break
        span.setAttributes({
          'astor.tool.is_error': e.isError,
          'astor.tool.duration_ms': e.durationMs,
          'astor.tool.output_chars': e.output.length,
        })
        span.setStatus(e.isError ? 'error' : 'ok')
        span.end()
        toolSpans.delete(e.toolUseId)
        break
      }

      case 'user_steering': {
        steeringCount += 1
        turnSpan?.setAttributes({ 'astor.steering_count': steeringCount })
        break
      }

      case 'turn_end': {
        turnSpan?.setAttributes({
          'gen_ai.response.finish_reasons': [e.stopReason],
          ...(e.usage
            ? {
                'gen_ai.usage.input_tokens': e.usage.inputTokens,
                'gen_ai.usage.output_tokens': e.usage.outputTokens,
                ...(e.usage.cacheReadTokens !== undefined
                  ? { 'gen_ai.usage.cache_read_tokens': e.usage.cacheReadTokens }
                  : {}),
                ...(e.usage.cacheCreationTokens !== undefined
                  ? { 'gen_ai.usage.cache_creation_tokens': e.usage.cacheCreationTokens }
                  : {}),
              }
            : {}),
        })
        turnSpan?.setStatus('ok')
        // Close any provider span still open (e.g. a turn that ended without
        // emitting an assistant message) plus stragglers, then the turn.
        endTurnSpans()
        break
      }

      case 'session_end': {
        endTurnSpans()
        if (sessionSpan) {
          sessionSpan.setAttributes({ 'astor.session.end_reason': e.reason })
          sessionSpan.setStatus(e.reason === 'error' ? 'error' : 'ok', e.error)
          sessionSpan.end()
        }
        resetRun()
        break
      }

      // Not mapped to spans (yet): plan_updated, heartbeat_tick, contract_violation.
      default:
        break
    }
  }

  const unsubscribe = agent.on('event', handle)

  return {
    detach: unsubscribe,
    currentTraceId: () => lastTraceId,
  }
}
