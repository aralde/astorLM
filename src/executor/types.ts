/**
 * Abstraction over the backend that executes shell commands on the agent's behalf.
 *
 * The bashTool (and its derivatives `bash_spawn`, `bash_get_output`, `bash_kill`)
 * does not talk to `child_process` directly; it asks the `Executor` to run the
 * command. That allows swapping the execution backend (local, container, remote)
 * without touching the tools or the agent loop.
 *
 * These interfaces live in `core` (they import nothing from Node) so that the
 * SDK can be used from alternative runtimes. The concrete implementations
 * (LocalExecutor, DockerExecutor) live in `node.ts`.
 */

export interface ExecResult {
  stdout: string
  stderr: string
  /** Numeric exit code; `null` if the process was killed by a signal before exiting. */
  exitCode: number | null
  /** Name of the signal that terminated the process, if applicable. */
  signal: string | null
  /** True if the output was truncated for exceeding `maxOutputBytes`. */
  truncated: boolean
}

export interface SpawnHandle {
  /** Opaque identifier assigned by the executor — a PID number or container id. */
  pid: string
}

export interface ProcessStatus {
  pid: string
  running: boolean
  exitCode: number | null
  signal: string | null
  /** stdout output accumulated since the last read. The buffer is drained on query. */
  stdout: string
  stderr: string
}

export interface ExecOptions {
  command: string
  cwd: string
  env?: Record<string, string>
  /** Default 120s. */
  timeoutMs?: number
  /** Default 200 KB. */
  maxOutputBytes?: number
  abortSignal?: AbortSignal
}

export interface SpawnOptions {
  command: string
  cwd: string
  env?: Record<string, string>
  /** Default 200 KB per stream before discarding the old data. */
  maxBufferBytes?: number
  abortSignal?: AbortSignal
}

export interface Executor {
  /** Human-readable identifier — useful for logging and so tools know where they run. */
  readonly name: string

  /** Runs a command and blocks until it finishes or the timeout expires. */
  exec(opts: ExecOptions): Promise<ExecResult>

  /** Starts a process in the background. Resolves as soon as it spawns, does not wait for exit. */
  spawn(opts: SpawnOptions): Promise<SpawnHandle>

  /** Reads the process status and drains the accumulated output buffer. */
  getOutput(pid: string): Promise<ProcessStatus>

  /** Kills the process. No-op if it already finished or the pid does not exist. */
  kill(pid: string, signal?: string): Promise<void>

  /** Closes all pending processes and releases resources. */
  dispose(): Promise<void>
}

/**
 * "Empty" executor that rejects every operation with a clear error. It is the
 * default in `createAgentSession` (core) so the SDK does not require Node: if you
 * are going to use the bashTool, configure a real executor (LocalExecutor in Node,
 * or a custom one).
 */
export function createNoopExecutor(): Executor {
  const fail = (op: string): never => {
    throw new Error(
      `Operation "${op}" requires a configured Executor. ` +
        `Pass { executor } to createAgentSession() — for example, new LocalExecutor() from astorlm/node.`,
    )
  }
  return {
    name: 'noop',
    async exec() { return fail('exec') },
    async spawn() { return fail('spawn') },
    async getOutput() { return fail('getOutput') },
    async kill() { return fail('kill') },
    async dispose() {},
  }
}
