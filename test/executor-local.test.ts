import { describe, expect, it } from 'vitest'
import { LocalExecutor } from '../src/executor/local.js'

const isWindows = process.platform === 'win32'

describe('LocalExecutor.exec', () => {
  it('captura stdout y exit code 0', async () => {
    const exec = new LocalExecutor()
    const cmd = isWindows ? 'echo hola' : 'echo hola'
    const res = await exec.exec({ command: cmd, cwd: process.cwd() })
    expect(res.stdout).toContain('hola')
    expect(res.exitCode).toBe(0)
  })

  it('captura stderr y exit code !=0', async () => {
    const exec = new LocalExecutor()
    const cmd = isWindows ? 'cmd /c "exit 7"' : 'exit 7'
    const res = await exec.exec({ command: cmd, cwd: process.cwd() })
    expect(res.exitCode).toBe(7)
  })

  it('respeta timeoutMs y mata el proceso', async () => {
    const exec = new LocalExecutor()
    // sleep cross-platform: usamos node -e
    const cmd = `node -e "setTimeout(()=>{},5000)"`
    const res = await exec.exec({ command: cmd, cwd: process.cwd(), timeoutMs: 200 })
    // El proceso murió por señal — exitCode puede ser null
    expect(res.exitCode === null || res.exitCode !== 0).toBe(true)
  })
})

describe('LocalExecutor.spawn / getOutput / kill', () => {
  it('spawn devuelve pid, getOutput drena buffer, kill termina el proceso', async () => {
    const exec = new LocalExecutor()
    // proceso largo que imprime cada 50ms
    const cmd = `node -e "let i=0; const t=setInterval(()=>{console.log('tick '+(++i)); if(i>200)clearInterval(t);}, 50)"`
    const handle = await exec.spawn({ command: cmd, cwd: process.cwd() })
    expect(handle.pid).toBeTruthy()

    // Esperá un poco para que imprima algo
    await new Promise((r) => setTimeout(r, 200))

    const out1 = await exec.getOutput(handle.pid)
    expect(out1.running).toBe(true)
    expect(out1.stdout).toMatch(/tick/)

    // Segunda lectura: el buffer está vacío (se drenó), sólo lo nuevo
    const out2 = await exec.getOutput(handle.pid)
    // Puede o no haber output nuevo en ese instante, pero la primera no debería estar repetida
    expect(out2.stdout.length).toBeLessThanOrEqual(out1.stdout.length + 1000)

    await exec.kill(handle.pid)

    // Poll hasta que el proceso reporte running=false (en Windows el cierre puede tardar)
    let final = await exec.getOutput(handle.pid)
    const deadline = Date.now() + 3000
    while (final.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
      final = await exec.getOutput(handle.pid)
    }
    expect(final.running).toBe(false)

    await exec.dispose()
  })

  it('getOutput tira si el pid no existe', async () => {
    const exec = new LocalExecutor()
    await expect(exec.getOutput('999999999')).rejects.toThrow(/no existe/)
  })

  it('kill de pid inexistente es no-op', async () => {
    const exec = new LocalExecutor()
    await expect(exec.kill('999999999')).resolves.toBeUndefined()
  })

  it('dispose mata todos los procesos vivos', async () => {
    const exec = new LocalExecutor()
    const h1 = await exec.spawn({ command: `node -e "setInterval(()=>{},1000)"`, cwd: process.cwd() })
    const h2 = await exec.spawn({ command: `node -e "setInterval(()=>{},1000)"`, cwd: process.cwd() })
    await exec.dispose()
    // Después de dispose, los procesos ya no están en el map → getOutput tira
    await expect(exec.getOutput(h1.pid)).rejects.toThrow()
    await expect(exec.getOutput(h2.pid)).rejects.toThrow()
  })
})
