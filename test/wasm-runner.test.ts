import { describe, it, expect } from 'vitest'
import { QuickJsCodeRunner, createCodeRunnerTool } from '../src/experimental/wasm-runner/index.js'
import type { ToolContext } from '../src/types.js'

const runner = new QuickJsCodeRunner()

function toolContext(signal?: AbortSignal): ToolContext {
  return {
    cwd: process.cwd(),
    abortSignal: signal ?? new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    // The code runner tool never touches the executor.
    executor: undefined as never,
  }
}

describe('QuickJsCodeRunner', () => {
  it('returns the value of the last expression', async () => {
    const result = await runner.run({ code: '40 + 2' })
    expect(result.ok).toBe(true)
    expect(result.value).toBe('42')
    expect(result.timedOut).toBe(false)
    expect(result.outOfMemory).toBe(false)
  })

  it('captures console.log into stdout', async () => {
    const result = await runner.run({ code: 'console.log("hello", { a: 1 }); 7' })
    expect(result.ok).toBe(true)
    expect(result.stdout).toContain('hello')
    expect(result.stdout).toContain('{"a":1}')
    expect(result.value).toBe('7')
  })

  it('routes console.error/warn to stderr', async () => {
    const result = await runner.run({ code: 'console.error("boom"); console.warn("careful")' })
    expect(result.stderr).toContain('boom')
    expect(result.stderr).toContain('careful')
    expect(result.stdout).toBe('')
  })

  it('reports a guest-thrown error without crashing the host', async () => {
    const result = await runner.run({ code: 'throw new Error("kaboom")' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('kaboom')
  })

  it('enforces the wall-clock deadline on an infinite loop', async () => {
    const result = await runner.run({ code: 'while (true) {}', timeoutMs: 200 })
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(result.error).toMatch(/timed out/i)
  })

  it('enforces the memory limit', async () => {
    const code = 'const a = []; for (let i = 0; i < 1e9; i++) { a.push(new Array(1000).fill(i)) }'
    const result = await runner.run({ code, memoryLimitBytes: 2 * 1024 * 1024, timeoutMs: 5_000 })
    expect(result.ok).toBe(false)
    // Either an explicit OOM or the engine bails — both are acceptable failure modes.
    expect(result.outOfMemory || result.timedOut || !!result.error).toBe(true)
  })

  it('denies host capabilities by default', async () => {
    for (const probe of ['typeof require', 'typeof process', 'typeof fetch', 'typeof globalThis.import']) {
      const result = await runner.run({ code: probe })
      expect(result.value).toBe('undefined')
    }
  })

  it('injects JSON-serializable globals read-only', async () => {
    const result = await runner.run({
      code: 'input.x + input.y',
      globals: { input: { x: 10, y: 5 } },
    })
    expect(result.value).toBe('15')
  })

  it('aborts when the signal fires', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runner.run({ code: 'while (true) {}', abortSignal: controller.signal, timeoutMs: 5_000 })
    expect(result.ok).toBe(false)
  })
})

describe('createCodeRunnerTool', () => {
  it('exposes a run_code tool that formats output for the model', async () => {
    const tool = createCodeRunnerTool({ runner })
    expect(tool.name).toBe('run_code')
    const out = await tool.execute({ code: 'console.log("hi"); 21 * 2' }, toolContext())
    expect(out).toContain('hi')
    expect(out).toContain('[result] 42')
  })

  it('surfaces guest errors through the tool result', async () => {
    const tool = createCodeRunnerTool({ runner })
    const out = await tool.execute({ code: 'throw new Error("nope")', }, toolContext())
    expect(out).toContain('[error]')
    expect(out).toContain('nope')
  })
})
