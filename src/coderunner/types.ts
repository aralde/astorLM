/**
 * Abstraction for running untrusted *source code* (not shell commands) inside a
 * memory-safe sandbox.
 *
 * This is a sibling primitive to `Executor`, not a replacement for it:
 *
 * - `Executor` runs arbitrary shell commands with the host toolchain
 *   (npm, git, python). Isolation comes from the OS layer (Docker) or nothing
 *   (LocalExecutor). It only works where a daemon + Node child_process exist.
 * - `CodeRunner` runs a self-contained snippet in a language with a WebAssembly
 *   toolchain (JS via QuickJS, later Python via Pyodide). Isolation is
 *   capability-based: the guest has no filesystem, no network and no host
 *   syscalls unless explicitly granted. Because it is pure WASM it runs in any
 *   runtime (Node, Deno, the browser, edge), which is exactly where Docker
 *   cannot reach.
 *
 * These interfaces live in `core` (no Node imports) so the SDK stays
 * runtime-agnostic. Concrete implementations live under
 * `astorlm/experimental/wasm-runner`.
 */

export interface RunCodeOptions {
  /** The source code to evaluate. */
  code: string
  /** Wall-clock budget enforced by an interrupt handler. Default 5_000 ms. */
  timeoutMs?: number
  /** Hard memory cap for the guest runtime, in bytes. Default 64 MB. */
  memoryLimitBytes?: number
  /** Max bytes of captured stdout/stderr before truncation. Default 200 KB. */
  maxOutputBytes?: number
  /**
   * JSON-serializable values copied (read-only) into the guest global scope.
   * Host functions are intentionally *not* supported in this version to keep
   * the isolation guarantee airtight.
   */
  globals?: Record<string, unknown>
  abortSignal?: AbortSignal
}

export interface RunCodeResult {
  /** True if the code ran to completion without throwing, timing out or OOM. */
  ok: boolean
  /** Serialized value of the last evaluated expression, if any. */
  value?: string
  /** Captured `console.log` output. */
  stdout: string
  /** Captured `console.error`/`console.warn` output. */
  stderr: string
  /** Guest-side thrown error message, if the run failed. */
  error?: string
  /** True if stdout/stderr was clipped at `maxOutputBytes`. */
  truncated: boolean
  /** True if the run was aborted because it exceeded `timeoutMs`. */
  timedOut: boolean
  /** True if the run was aborted because it hit `memoryLimitBytes`. */
  outOfMemory: boolean
  /** Wall-clock duration of the run, in milliseconds. */
  durationMs: number
}

export interface CodeRunner {
  /** Readable identifier — useful for logging and tool descriptions. */
  readonly name: string
  /** Language the runner evaluates. */
  readonly language: 'javascript' | 'python' | string
  /** Evaluate a snippet in a fresh sandbox and return the captured result. */
  run(opts: RunCodeOptions): Promise<RunCodeResult>
  /** Release any cached WASM module or pooled resources. */
  dispose(): Promise<void>
}
