import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import type {
  ExecOptions,
  ExecResult,
  Executor,
  ProcessStatus,
  SpawnHandle,
  SpawnOptions,
} from './types.js'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 200_000
const DEFAULT_MAX_BUFFER_BYTES = 200_000

interface SpawnedProcess {
  pid: string
  child: ChildProcess
  stdout: string[]
  stderr: string[]
  stdoutBytes: number
  stderrBytes: number
  maxBuffer: number
  exitCode: number | null
  signal: string | null
  running: boolean
}

/**
 * Executor that runs commands in the host process with `child_process.spawn`.
 * It is the default when a session is created with `createNodeAgentSession` and
 * preserves the bashTool's historical behavior: native shell, combined or
 * separate output, size-based truncation, appended exit code.
 *
 * It does NOT isolate — the command inherits the process's permissions. For
 * isolated execution use `DockerExecutor` or a custom remote executor.
 */
export class LocalExecutor implements Executor {
  readonly name = 'local'
  private readonly processes = new Map<string, SpawnedProcess>()
  private nextId = 1

  async exec(opts: ExecOptions): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

    return await new Promise<ExecResult>((resolve) => {
      const child = nodeSpawn(opts.command, {
        cwd: opts.cwd,
        shell: true,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        signal: opts.abortSignal,
      })

      let stdoutBytes = 0
      let stderrBytes = 0
      let truncated = false
      const stdoutChunks: string[] = []
      const stderrChunks: string[] = []

      const append = (chunks: string[], counter: { v: number }, data: Buffer) => {
        const remaining = maxBytes - counter.v
        if (remaining <= 0) {
          truncated = true
          return
        }
        const slice = data.length > remaining ? data.subarray(0, remaining) : data
        if (data.length > remaining) truncated = true
        counter.v += slice.length
        chunks.push(slice.toString('utf8'))
      }

      const outCounter = { v: 0 }
      const errCounter = { v: 0 }
      child.stdout?.on('data', (d: Buffer) => {
        append(stdoutChunks, outCounter, d)
        stdoutBytes = outCounter.v
      })
      child.stderr?.on('data', (d: Buffer) => {
        append(stderrChunks, errCounter, d)
        stderrBytes = errCounter.v
      })

      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)

      child.on('close', (code, signal) => {
        clearTimeout(timer)
        void stdoutBytes
        void stderrBytes
        resolve({
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
          exitCode: code,
          signal,
          truncated,
        })
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({
          stdout: stdoutChunks.join(''),
          stderr: `[error spawning: ${err.message}]`,
          exitCode: null,
          signal: null,
          truncated,
        })
      })
    })
  }

  async spawn(opts: SpawnOptions): Promise<SpawnHandle> {
    const child = nodeSpawn(opts.command, {
      cwd: opts.cwd,
      shell: true,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      signal: opts.abortSignal,
      detached: false,
    })

    const pid = child.pid != null ? String(child.pid) : `local-${this.nextId++}`
    const maxBuffer = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES

    const state: SpawnedProcess = {
      pid,
      child,
      stdout: [],
      stderr: [],
      stdoutBytes: 0,
      stderrBytes: 0,
      maxBuffer,
      exitCode: null,
      signal: null,
      running: true,
    }
    this.processes.set(pid, state)

    const append = (kind: 'stdout' | 'stderr', data: Buffer) => {
      const remaining = state.maxBuffer - (kind === 'stdout' ? state.stdoutBytes : state.stderrBytes)
      if (remaining <= 0) return
      const slice = data.length > remaining ? data.subarray(0, remaining) : data
      if (kind === 'stdout') {
        state.stdoutBytes += slice.length
        state.stdout.push(slice.toString('utf8'))
      } else {
        state.stderrBytes += slice.length
        state.stderr.push(slice.toString('utf8'))
      }
    }

    child.stdout?.on('data', (d: Buffer) => append('stdout', d))
    child.stderr?.on('data', (d: Buffer) => append('stderr', d))
    child.on('close', (code, sig) => {
      state.exitCode = code
      state.signal = sig
      state.running = false
    })
    child.on('error', (err) => {
      state.stderr.push(`[error: ${err.message}]`)
      state.stderrBytes += err.message.length
      state.running = false
    })

    return { pid }
  }

  async getOutput(pid: string): Promise<ProcessStatus> {
    const state = this.processes.get(pid)
    if (!state) {
      throw new Error(`Process "${pid}" does not exist (it may have been cleaned up).`)
    }
    const stdout = state.stdout.join('')
    const stderr = state.stderr.join('')
    state.stdout = []
    state.stderr = []
    state.stdoutBytes = 0
    state.stderrBytes = 0

    return {
      pid,
      running: state.running,
      exitCode: state.exitCode,
      signal: state.signal,
      stdout,
      stderr,
    }
  }

  async kill(pid: string, signal: string = 'SIGTERM'): Promise<void> {
    const state = this.processes.get(pid)
    if (!state) return
    if (!state.running) return
    this.killChild(state, signal)
  }

  async dispose(): Promise<void> {
    for (const state of this.processes.values()) {
      if (state.running) this.killChild(state, 'SIGTERM')
    }
    this.processes.clear()
  }

  private killChild(state: SpawnedProcess, signal: string): void {
    // On Windows, `spawn(cmd, { shell: true })` starts cmd.exe which in turn
    // starts the real process. Killing only cmd.exe orphans the child, so we
    // use `taskkill /F /T` to terminate the whole tree.
    if (process.platform === 'win32' && state.child.pid != null) {
      try {
        nodeSpawn('taskkill', ['/pid', String(state.child.pid), '/T', '/F'])
      } catch { /* no-op */ }
      return
    }
    try {
      state.child.kill(signal as NodeJS.Signals)
    } catch {
      // Already dead or no permissions — no-op.
    }
  }
}
