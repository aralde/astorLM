import { spawn as nodeSpawn } from 'node:child_process'
import type {
  ExecOptions,
  ExecResult,
  Executor,
  ProcessStatus,
  SpawnHandle,
  SpawnOptions,
} from './types.js'

export interface DockerExecutorOptions {
  /** Imagen base que se usa para cada container. Default `node:20-alpine`. */
  image?: string
  /** Configuración de red. Default `none` (sin red, máximo aislamiento). */
  network?: 'none' | 'bridge' | 'host' | string
  /** Args extra para `docker run`. Útil para `--memory`, `--cpus`, `-e`, etc. */
  extraDockerArgs?: string[]
  /** Binario de docker. Default `docker`. Cambialo si usás podman o ruta no estándar. */
  dockerBin?: string
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 200_000

/**
 * Executor que corre cada comando dentro de un container efímero. Usa el binario
 * `docker` por CLI (no dockerode) para no agregar deps pesadas.
 *
 * - `exec(cmd)` → `docker run --rm -v cwd:/work -w /work <image> sh -c <cmd>`.
 * - `spawn(cmd)` → `docker run -d --rm ...` devolviendo container id como pid;
 *   `getOutput` usa `docker logs`; `kill` usa `docker kill`.
 *
 * Notas de portabilidad: el bind-mount de `cwd` requiere que Docker Desktop
 * (Windows) o el daemon (Linux/Mac) tenga acceso al filesystem del host. En
 * Windows con rutas tipo `T:\...`, Docker las traduce automáticamente.
 */
export class DockerExecutor implements Executor {
  readonly name = 'docker'
  private readonly image: string
  private readonly network: string
  private readonly extraArgs: string[]
  private readonly dockerBin: string
  private readonly containers = new Set<string>()

  constructor(opts: DockerExecutorOptions = {}) {
    this.image = opts.image ?? 'node:20-alpine'
    this.network = opts.network ?? 'none'
    this.extraArgs = opts.extraDockerArgs ?? []
    this.dockerBin = opts.dockerBin ?? 'docker'
  }

  async exec(opts: ExecOptions): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

    const envArgs: string[] = []
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        envArgs.push('-e', `${k}=${v}`)
      }
    }

    const args = [
      'run', '--rm',
      `--network=${this.network}`,
      '-v', `${opts.cwd}:/work`,
      '-w', '/work',
      ...envArgs,
      ...this.extraArgs,
      this.image,
      'sh', '-c', opts.command,
    ]

    return await new Promise<ExecResult>((resolve) => {
      const child = nodeSpawn(this.dockerBin, args, { signal: opts.abortSignal })

      let stdoutBytes = 0
      let stderrBytes = 0
      let truncated = false
      const stdoutChunks: string[] = []
      const stderrChunks: string[] = []

      const append = (chunks: string[], current: number, data: Buffer): number => {
        const remaining = maxBytes - current
        if (remaining <= 0) {
          truncated = true
          return current
        }
        const slice = data.length > remaining ? data.subarray(0, remaining) : data
        if (data.length > remaining) truncated = true
        chunks.push(slice.toString('utf8'))
        return current + slice.length
      }

      child.stdout?.on('data', (d: Buffer) => { stdoutBytes = append(stdoutChunks, stdoutBytes, d) })
      child.stderr?.on('data', (d: Buffer) => { stderrBytes = append(stderrChunks, stderrBytes, d) })

      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)

      child.on('close', (code, signal) => {
        clearTimeout(timer)
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
          stdout: '',
          stderr: `[error invocando docker: ${err.message}. ¿Está corriendo el daemon?]`,
          exitCode: null,
          signal: null,
          truncated: false,
        })
      })
    })
  }

  async spawn(opts: SpawnOptions): Promise<SpawnHandle> {
    const envArgs: string[] = []
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        envArgs.push('-e', `${k}=${v}`)
      }
    }

    const args = [
      'run', '-d', '--rm',
      `--network=${this.network}`,
      '-v', `${opts.cwd}:/work`,
      '-w', '/work',
      ...envArgs,
      ...this.extraArgs,
      this.image,
      'sh', '-c', opts.command,
    ]

    const containerId = await new Promise<string>((resolve, reject) => {
      const child = nodeSpawn(this.dockerBin, args, { signal: opts.abortSignal })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      child.on('close', (code) => {
        if (code === 0) resolve(stdout.trim())
        else reject(new Error(`docker run -d falló (exit ${code}): ${stderr.trim()}`))
      })
      child.on('error', (err) => reject(err))
    })

    this.containers.add(containerId)
    return { pid: containerId }
  }

  async getOutput(pid: string): Promise<ProcessStatus> {
    // `docker inspect` para estado, `docker logs` para output. Hacemos los dos
    // en paralelo. Si no existe, asumimos que ya terminó y fue limpiado.
    const [inspectRes, logsRes] = await Promise.all([
      this.runDocker(['inspect', '--format', '{{.State.Running}}|{{.State.ExitCode}}', pid]),
      this.runDocker(['logs', pid]),
    ])

    let running = false
    let exitCode: number | null = null
    if (inspectRes.exitCode === 0) {
      const [runStr, codeStr] = inspectRes.stdout.trim().split('|')
      running = runStr === 'true'
      const parsed = Number.parseInt(codeStr ?? '', 10)
      exitCode = Number.isNaN(parsed) ? null : parsed
    } else {
      // Container ya removido (--rm).
      this.containers.delete(pid)
    }

    return {
      pid,
      running,
      exitCode,
      signal: null,
      stdout: logsRes.stdout,
      stderr: logsRes.stderr,
    }
  }

  async kill(pid: string, signal: string = 'SIGTERM'): Promise<void> {
    await this.runDocker(['kill', '--signal', signal, pid])
    this.containers.delete(pid)
  }

  async dispose(): Promise<void> {
    const ids = [...this.containers]
    this.containers.clear()
    await Promise.all(ids.map((id) => this.runDocker(['kill', id]).catch(() => {})))
  }

  private runDocker(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve) => {
      const child = nodeSpawn(this.dockerBin, args)
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      child.on('close', (code) => resolve({ stdout, stderr, exitCode: code }))
      child.on('error', (err) => resolve({ stdout: '', stderr: err.message, exitCode: null }))
    })
  }
}
