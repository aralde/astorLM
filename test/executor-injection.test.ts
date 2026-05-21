import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgentSession } from '../src/agent/session.js'
import { defineTool } from '../src/tools/define.js'
import { MockProvider } from './mock-provider.js'
import type { Executor, ExecResult, ProcessStatus, SpawnHandle } from '../src/executor/types.js'

class TracingExecutor implements Executor {
  readonly name = 'tracing'
  observed: string[] = []
  async exec(opts: { command: string; cwd: string }): Promise<ExecResult> {
    this.observed.push(`exec:${opts.command}`)
    return { stdout: 'ok', stderr: '', exitCode: 0, signal: null, truncated: false }
  }
  async spawn(): Promise<SpawnHandle> { return { pid: 'x' } }
  async getOutput(): Promise<ProcessStatus> {
    return { pid: 'x', running: false, exitCode: 0, signal: null, stdout: '', stderr: '' }
  }
  async kill(): Promise<void> {}
  async dispose(): Promise<void> {}
}

describe('Executor injection en ToolContext', () => {
  it('createAgentSession propaga executor al ToolContext que reciben las tools', async () => {
    const exec = new TracingExecutor()

    let capturedExecutorName: string | undefined
    const probe = defineTool({
      name: 'probe',
      description: 'observa ctx',
      schema: z.object({}),
      execute: async (_input, ctx) => {
        capturedExecutorName = ctx.executor.name
        await ctx.executor.exec({ command: 'true', cwd: ctx.cwd })
        return 'ok'
      },
    })

    const provider = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'probe', input: {} }] },
      { text: 'done' },
    ])

    const session = await createAgentSession({
      provider,
      tools: [probe],
      executor: exec,
    })
    await session.prompt('go')

    expect(capturedExecutorName).toBe('tracing')
    expect(exec.observed).toEqual(['exec:true'])
  })

  it('sin executor configurado el ctx recibe noop que tira con mensaje claro', async () => {
    let caughtMsg: string | undefined
    const probe = defineTool({
      name: 'probe',
      description: '',
      schema: z.object({}),
      execute: async (_input, ctx) => {
        try {
          await ctx.executor.exec({ command: 'x', cwd: ctx.cwd })
          return 'no debería llegar'
        } catch (err) {
          caughtMsg = (err as Error).message
          throw err
        }
      },
    })
    const provider = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'probe', input: {} }] },
      { text: 'done' },
    ])
    const session = await createAgentSession({ provider, tools: [probe] })
    await session.prompt('go')
    expect(caughtMsg).toMatch(/requiere un Executor/)
  })
})
