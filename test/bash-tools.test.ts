import { describe, expect, it } from 'vitest'
import { bashTool } from '../src/tools/builtin/bash.js'
import { bashSpawnTool } from '../src/tools/builtin/bashSpawn.js'
import { bashGetOutputTool } from '../src/tools/builtin/bashGetOutput.js'
import { bashKillTool } from '../src/tools/builtin/bashKill.js'
import { noopLogger } from '../src/types.js'
import type { Executor, ExecResult, ProcessStatus, SpawnHandle } from '../src/executor/types.js'

class MockExecutor implements Executor {
  readonly name = 'mock'
  execCalls: Array<{ command: string; cwd: string }> = []
  spawnCalls: Array<{ command: string }> = []
  killCalls: Array<{ pid: string; signal?: string }> = []
  outputs = new Map<string, ProcessStatus>()
  execResult: ExecResult = {
    stdout: 'hello\n',
    stderr: '',
    exitCode: 0,
    signal: null,
    truncated: false,
  }
  nextPid = 'mock-1'

  async exec(opts: { command: string; cwd: string }): Promise<ExecResult> {
    this.execCalls.push({ command: opts.command, cwd: opts.cwd })
    return this.execResult
  }
  async spawn(opts: { command: string }): Promise<SpawnHandle> {
    this.spawnCalls.push({ command: opts.command })
    const pid = this.nextPid
    this.outputs.set(pid, {
      pid,
      running: true,
      exitCode: null,
      signal: null,
      stdout: 'server up\n',
      stderr: '',
    })
    return { pid }
  }
  async getOutput(pid: string): Promise<ProcessStatus> {
    const status = this.outputs.get(pid)
    if (!status) throw new Error(`does not exist ${pid}`)
    const snap = { ...status }
    status.stdout = ''
    status.stderr = ''
    return snap
  }
  async kill(pid: string, signal?: string): Promise<void> {
    this.killCalls.push({ pid, signal })
    const s = this.outputs.get(pid)
    if (s) { s.running = false; s.exitCode = 0 }
  }
  async dispose(): Promise<void> {}
}

function ctx(executor: Executor) {
  return { cwd: '/tmp', abortSignal: new AbortController().signal, logger: noopLogger, executor }
}

describe('bashTool', () => {
  it('delegates to executor.exec and appends [exit code: N]', async () => {
    const m = new MockExecutor()
    const out = await bashTool.execute({ command: 'echo hello' }, ctx(m))
    expect(m.execCalls).toHaveLength(1)
    expect(m.execCalls[0]?.command).toBe('echo hello')
    expect(out).toContain('hello')
    expect(out).toContain('[exit code: 0]')
  })

  it('reports truncation when the executor marks it', async () => {
    const m = new MockExecutor()
    m.execResult = { stdout: 'X'.repeat(10), stderr: '', exitCode: 0, signal: null, truncated: true }
    const out = await bashTool.execute({ command: 'cat big' }, ctx(m))
    expect(out).toContain('[output truncated]')
    expect(out).toContain('[exit code: 0]')
  })

  it('reports signal when exitCode is null', async () => {
    const m = new MockExecutor()
    m.execResult = { stdout: '', stderr: '', exitCode: null, signal: 'SIGTERM', truncated: false }
    const out = await bashTool.execute({ command: 'sleep 100' }, ctx(m))
    expect(out).toContain('signal SIGTERM')
  })
})

describe('bash_spawn / bash_get_output / bash_kill', () => {
  it('full flow: spawn → get_output → kill', async () => {
    const m = new MockExecutor()
    const spawnOut = await bashSpawnTool.execute(
      { command: 'node server.js' },
      ctx(m),
    )
    expect(spawnOut).toMatch(/\[spawned pid=mock-1\]/)
    expect(m.spawnCalls[0]?.command).toBe('node server.js')

    const getOut = await bashGetOutputTool.execute({ pid: 'mock-1' }, ctx(m))
    expect(getOut).toContain('running=true')
    expect(getOut).toContain('server up')

    // Second read: the buffer was drained on the first one
    const getOut2 = await bashGetOutputTool.execute({ pid: 'mock-1' }, ctx(m))
    expect(getOut2).toContain('[no new output]')

    const killOut = await bashKillTool.execute({ pid: 'mock-1' }, ctx(m))
    expect(killOut).toContain('mock-1')
    expect(m.killCalls).toEqual([{ pid: 'mock-1', signal: undefined }])

    const finalOut = await bashGetOutputTool.execute({ pid: 'mock-1' }, ctx(m))
    expect(finalOut).toContain('running=false')
    expect(finalOut).toContain('exitCode=0')
  })

  it('bash_kill accepts a custom signal', async () => {
    const m = new MockExecutor()
    await bashSpawnTool.execute({ command: 'x' }, ctx(m))
    await bashKillTool.execute({ pid: 'mock-1', signal: 'SIGKILL' }, ctx(m))
    expect(m.killCalls).toEqual([{ pid: 'mock-1', signal: 'SIGKILL' }])
  })
})
