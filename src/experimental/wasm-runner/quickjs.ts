import type { QuickJSContext, QuickJSRuntime, QuickJSWASMModule } from 'quickjs-emscripten'
import type { CodeRunner, RunCodeOptions, RunCodeResult } from '../../coderunner/types.js'

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = 200_000

export interface QuickJsCodeRunnerOptions {
  /** Default wall-clock budget per run. Overridable per `run()`. Default 5_000 ms. */
  timeoutMs?: number
  /** Default memory cap per run. Overridable per `run()`. Default 64 MB. */
  memoryLimitBytes?: number
  /** Default output cap per run. Overridable per `run()`. Default 200 KB. */
  maxOutputBytes?: number
}

/**
 * A `CodeRunner` backed by QuickJS compiled to WebAssembly (via
 * `quickjs-emscripten`). It evaluates JavaScript in a fresh, capability-empty
 * sandbox: the guest has no `fs`, no `process`, no `fetch` and no `import` —
 * only what is explicitly injected through `globals` plus a captured `console`.
 *
 * Because the engine is pure WASM, this runs unchanged in Node, Deno, the
 * browser and edge runtimes — covering the case where `DockerExecutor` cannot
 * (no daemon, no child_process).
 *
 * Each `run()` instantiates and disposes its own runtime + context, so no state
 * leaks between calls. The WASM module itself is loaded once and cached.
 */
export class QuickJsCodeRunner implements CodeRunner {
  readonly name = 'quickjs-wasm'
  readonly language = 'javascript'

  private readonly defaultTimeoutMs: number
  private readonly defaultMemoryLimitBytes: number
  private readonly defaultMaxOutputBytes: number
  private modulePromise: Promise<QuickJSWASMModule> | undefined

  constructor(opts: QuickJsCodeRunnerOptions = {}) {
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.defaultMemoryLimitBytes = opts.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES
    this.defaultMaxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  }

  /**
   * Lazily load the WASM module the first time it is needed, so importing this
   * file does not pull the wasm binary unless a run actually happens.
   */
  private async getModule(): Promise<QuickJSWASMModule> {
    if (!this.modulePromise) {
      this.modulePromise = import('quickjs-emscripten').then((m) => m.getQuickJS())
    }
    return this.modulePromise
  }

  async run(opts: RunCodeOptions): Promise<RunCodeResult> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs
    const memoryLimitBytes = opts.memoryLimitBytes ?? this.defaultMemoryLimitBytes
    const maxOutputBytes = opts.maxOutputBytes ?? this.defaultMaxOutputBytes

    const started = Date.now()
    const QuickJS = await this.getModule()

    const runtime: QuickJSRuntime = QuickJS.newRuntime()
    runtime.setMemoryLimit(memoryLimitBytes)

    // Deadline + abort are both surfaced through the interrupt handler: QuickJS
    // calls it periodically and bails out of evalCode when it returns true.
    const deadline = started + timeoutMs
    let timedOut = false
    runtime.setInterruptHandler(() => {
      if (opts.abortSignal?.aborted) return true
      if (Date.now() > deadline) {
        timedOut = true
        return true
      }
      return false
    })

    const ctx: QuickJSContext = runtime.newContext()

    // Output capture state, with byte budget shared across stdout + stderr.
    const stdout: string[] = []
    const stderr: string[] = []
    let usedBytes = 0
    let truncated = false
    const sink = (target: string[], text: string): void => {
      const remaining = maxOutputBytes - usedBytes
      if (remaining <= 0) {
        truncated = true
        return
      }
      const slice = text.length > remaining ? text.slice(0, remaining) : text
      if (text.length > remaining) truncated = true
      usedBytes += slice.length
      target.push(slice)
    }

    try {
      this.installConsole(ctx, sink, stdout, stderr)
      this.installGlobals(ctx, opts.globals)

      const evalResult = ctx.evalCode(opts.code, 'sandbox.js')

      if (evalResult.error) {
        const dumped = ctx.dump(evalResult.error)
        evalResult.error.dispose()
        const outOfMemory = isOutOfMemory(dumped)
        return {
          ok: false,
          stdout: stdout.join(''),
          stderr: stderr.join(''),
          error: timedOut
            ? `Execution timed out after ${timeoutMs} ms`
            : outOfMemory
              ? `Out of memory (limit ${memoryLimitBytes} bytes)`
              : formatError(dumped),
          truncated,
          timedOut,
          outOfMemory,
          durationMs: Date.now() - started,
        }
      }

      const value = ctx.dump(evalResult.value)
      evalResult.value.dispose()
      return {
        ok: true,
        value: serializeValue(value),
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        truncated,
        timedOut: false,
        outOfMemory: false,
        durationMs: Date.now() - started,
      }
    } finally {
      ctx.dispose()
      runtime.dispose()
    }
  }

  async dispose(): Promise<void> {
    // The cached WASM module is process-global in quickjs-emscripten; there is
    // nothing per-instance to free. Drop the reference so a later run reloads.
    this.modulePromise = undefined
  }

  /** Inject a minimal `console` that funnels into the output sinks. */
  private installConsole(
    ctx: QuickJSContext,
    sink: (target: string[], text: string) => void,
    stdout: string[],
    stderr: string[],
  ): void {
    const consoleObj = ctx.newObject()

    const makeLogger = (target: string[]) =>
      ctx.newFunction('log', (...args) => {
        const line = args.map((h) => stringifyHandle(ctx, h)).join(' ')
        sink(target, line + '\n')
      })

    const log = makeLogger(stdout)
    const info = makeLogger(stdout)
    const warn = makeLogger(stderr)
    const error = makeLogger(stderr)

    ctx.setProp(consoleObj, 'log', log)
    ctx.setProp(consoleObj, 'info', info)
    ctx.setProp(consoleObj, 'warn', warn)
    ctx.setProp(consoleObj, 'error', error)
    ctx.setProp(ctx.global, 'console', consoleObj)

    log.dispose()
    info.dispose()
    warn.dispose()
    error.dispose()
    consoleObj.dispose()
  }

  /**
   * Copy JSON-serializable globals into the guest. We marshal by evaluating a
   * `globalThis.<key> = <json>` prelude rather than building handles by hand —
   * simpler and it round-trips nested structures faithfully.
   */
  private installGlobals(ctx: QuickJSContext, globals?: Record<string, unknown>): void {
    if (!globals) return
    for (const [key, raw] of Object.entries(globals)) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
        throw new Error(`Invalid global name: ${JSON.stringify(key)}`)
      }
      const json = JSON.stringify(raw)
      if (json === undefined) continue // skip functions/undefined silently
      const prelude = ctx.evalCode(`globalThis.${key} = ${json};`, 'globals.js')
      if (prelude.error) {
        prelude.error.dispose()
        throw new Error(`Failed to inject global "${key}"`)
      }
      prelude.value.dispose()
    }
  }
}

/** Best-effort conversion of a dumped guest value to a display string. */
function stringifyHandle(ctx: QuickJSContext, handle: import('quickjs-emscripten').QuickJSHandle): string {
  const value = ctx.dump(handle)
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function serializeValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatError(dumped: unknown): string {
  if (dumped && typeof dumped === 'object') {
    const obj = dumped as { name?: unknown; message?: unknown; stack?: unknown }
    const name = typeof obj.name === 'string' ? obj.name : 'Error'
    const message = typeof obj.message === 'string' ? obj.message : JSON.stringify(dumped)
    // QuickJS exposes a `stack` without the message prefix, so we build the
    // canonical `Name: message` head ourselves and append the trace if present.
    const head = `${name}: ${message}`
    return typeof obj.stack === 'string' && obj.stack.trim().length > 0
      ? `${head}\n${obj.stack.trimEnd()}`
      : head
  }
  return String(dumped)
}

function isOutOfMemory(dumped: unknown): boolean {
  if (dumped && typeof dumped === 'object') {
    const message = (dumped as { message?: unknown }).message
    if (typeof message === 'string') return /out of memory/i.test(message)
  }
  return typeof dumped === 'string' && /out of memory/i.test(dumped)
}
