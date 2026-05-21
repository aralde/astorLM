/**
 * Abstracción del backend que ejecuta comandos shell por cuenta del agente.
 *
 * El bashTool (y sus derivados `bash_spawn`, `bash_get_output`, `bash_kill`)
 * no habla con `child_process` directo; le pide al `Executor` que corra el
 * comando. Eso permite swappear el backend de ejecución (local, container,
 * remoto) sin tocar las tools ni el agent loop.
 *
 * Estas interfaces viven en `core` (no importan nada de Node) para que el
 * SDK pueda usarse desde runtimes alternativos. Los implementadores
 * concretos (LocalExecutor, DockerExecutor) viven en `node.ts`.
 */

export interface ExecResult {
  stdout: string
  stderr: string
  /** Exit code numérico; `null` si el proceso fue matado por señal antes de exitear. */
  exitCode: number | null
  /** Nombre de la señal que terminó el proceso, si aplica. */
  signal: string | null
  /** True si el output fue truncado por superar `maxOutputBytes`. */
  truncated: boolean
}

export interface SpawnHandle {
  /** Identificador opaco asignado por el executor — número de PID o container id. */
  pid: string
}

export interface ProcessStatus {
  pid: string
  running: boolean
  exitCode: number | null
  signal: string | null
  /** Output stdout acumulado desde la última lectura. El buffer se vacía al consultar. */
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
  /** Default 200 KB por stream antes de descartar lo viejo. */
  maxBufferBytes?: number
  abortSignal?: AbortSignal
}

export interface Executor {
  /** Identificador legible — útil para logging y para que las tools sepan dónde corren. */
  readonly name: string

  /** Ejecuta un comando y bloquea hasta que termina o vence el timeout. */
  exec(opts: ExecOptions): Promise<ExecResult>

  /** Arranca un proceso en background. Resuelve apenas spawnea, no espera al exit. */
  spawn(opts: SpawnOptions): Promise<SpawnHandle>

  /** Lee el estado del proceso y drena el buffer de output acumulado. */
  getOutput(pid: string): Promise<ProcessStatus>

  /** Mata el proceso. No-op si ya terminó o si el pid no existe. */
  kill(pid: string, signal?: string): Promise<void>

  /** Cierra todos los procesos pendientes y libera recursos. */
  dispose(): Promise<void>
}

/**
 * Executor "vacío" que rechaza toda operación con un error claro. Es el default
 * en `createAgentSession` (core) para que el SDK no requiera Node: si vas a usar
 * el bashTool, configurá un executor real (LocalExecutor en Node, o uno custom).
 */
export function createNoopExecutor(): Executor {
  const fail = (op: string): never => {
    throw new Error(
      `Operación "${op}" requiere un Executor configurado. ` +
        `Pasá { executor } a createAgentSession() — por ejemplo, new LocalExecutor() de astorlm/node.`,
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
