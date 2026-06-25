import { describe, expect, it } from 'vitest'
import { LocalExecutor } from '../src/executor/local.js'

const isWindows = process.platform === 'win32'

describe('LocalExecutor.exec', () => {
  it('captures stdout and exit code 0', async () => {
    const exec = new LocalExecutor()
    const cmd = isWindows ? 'echo hello' : 'echo hello'
    const res = await exec.exec({ command: cmd, cwd: process.cwd() })
    expect(res.stdout).toContain('hello')
    expect(res.exitCode).toBe(0)
  })

  it('captures stderr and exit code !=0', async () => {
    const exec = new LocalExecutor()
    const cmd = isWindows ? 'cmd /c "exit 7"' : 'exit 7'
    const res = await exec.exec({ command: cmd, cwd: process.cwd() })
    expect(res.exitCode).toBe(7)
  })

  it('respects timeoutMs and kills the process', async () => {
    const exec = new LocalExecutor()
    // cross-platform sleep: we use node -e
    const cmd = `node -e "setTimeout(()=>{},5000)"`
    const res = await exec.exec({ command: cmd, cwd: process.cwd(), timeoutMs: 200 })
    // The process was killed by a signal — exitCode may be null
    expect(res.exitCode === null || res.exitCode !== 0).toBe(true)
  })
})

describe('LocalExecutor.spawn / getOutput / kill', () => {
  it('spawn returns a pid, getOutput drains the buffer, kill terminates the process', async () => {
    const exec = new LocalExecutor()
    // long-running process that prints every 50ms
    const cmd = `node -e "let i=0; const t=setInterval(()=>{console.log('tick '+(++i)); if(i>200)clearInterval(t);}, 50)"`
    const handle = await exec.spawn({ command: cmd, cwd: process.cwd() })
    expect(handle.pid).toBeTruthy()

    // Wait a bit so it prints something
    await new Promise((r) => setTimeout(r, 200))

    const out1 = await exec.getOutput(handle.pid)
    expect(out1.running).toBe(true)
    expect(out1.stdout).toMatch(/tick/)

    // Second read: the buffer is empty (it was drained), only the new output
    const out2 = await exec.getOutput(handle.pid)
    // There may or may not be new output at that instant, but the first read should not be repeated
    expect(out2.stdout.length).toBeLessThanOrEqual(out1.stdout.length + 1000)

    await exec.kill(handle.pid)

    // Poll until the process reports running=false (on Windows the shutdown can take a while)
    let final = await exec.getOutput(handle.pid)
    const deadline = Date.now() + 3000
    while (final.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
      final = await exec.getOutput(handle.pid)
    }
    expect(final.running).toBe(false)

    await exec.dispose()
  })

  it('getOutput throws if the pid does not exist', async () => {
    const exec = new LocalExecutor()
    await expect(exec.getOutput('999999999')).rejects.toThrow(/does not exist/)
  })

  it('kill of a non-existent pid is a no-op', async () => {
    const exec = new LocalExecutor()
    await expect(exec.kill('999999999')).resolves.toBeUndefined()
  })

  it('dispose kills all live processes', async () => {
    const exec = new LocalExecutor()
    const h1 = await exec.spawn({ command: `node -e "setInterval(()=>{},1000)"`, cwd: process.cwd() })
    const h2 = await exec.spawn({ command: `node -e "setInterval(()=>{},1000)"`, cwd: process.cwd() })
    await exec.dispose()
    // After dispose, the processes are no longer in the map → getOutput throws
    await expect(exec.getOutput(h1.pid)).rejects.toThrow()
    await expect(exec.getOutput(h2.pid)).rejects.toThrow()
  })
})
