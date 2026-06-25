import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { tool } from '../src/tools/define.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { editTool, readTool, writeTool } from '../src/tools/index.js'
import { noopLogger } from '../src/types.js'
import { createNoopExecutor } from '../src/executor/types.js'

function makeCtx(cwd: string) {
  return {
    cwd,
    abortSignal: new AbortController().signal,
    logger: noopLogger,
    executor: createNoopExecutor(),
  }
}

describe('tool', () => {
  it('validates input with zod and generates inputSchema', async () => {
    const t = tool({
      name: 'echo',
      description: 'echo',
      schema: z.object({ text: z.string() }),
      execute: async ({ text }) => text.toUpperCase(),
    })
    expect(t.inputSchema['type']).toBe('object')
    expect(() => t.parseInput({ text: 123 })).toThrow()
    const out = await t.execute({ text: 'hello' }, makeCtx(process.cwd()))
    expect(out).toBe('HELLO')
  })
})

describe('ToolRegistry', () => {
  it('rejects duplicate names', () => {
    const reg = new ToolRegistry()
    const t = tool({
      name: 'x',
      description: '',
      schema: z.object({}),
      execute: async () => 'ok',
    })
    reg.register(t)
    expect(() => reg.register(t)).toThrow(/already registered/)
  })

  it('run() returns isError=true with an unknown tool', async () => {
    const reg = new ToolRegistry()
    const res = await reg.run('nonexistent', {}, makeCtx(process.cwd()))
    expect(res.isError).toBe(true)
  })

  it('captures execute exceptions as isError=true', async () => {
    const reg = new ToolRegistry()
    reg.register(
      tool({
        name: 'boom',
        description: '',
        schema: z.object({}),
        execute: async () => {
          throw new Error('exploded')
        },
      }),
    )
    const res = await reg.run('boom', {}, makeCtx(process.cwd()))
    expect(res.isError).toBe(true)
    expect(res.output).toContain('exploded')
  })
})

describe('built-in tools (read/write/edit)', () => {
  it('write + read + edit in tmpdir', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-'))
    const ctx = makeCtx(dir)

    await writeTool.execute({ path: 'a.txt', content: 'hello\nworld' }, ctx)
    const raw = await readFile(path.join(dir, 'a.txt'), 'utf8')
    expect(raw).toBe('hello\nworld')

    const readOut = await readTool.execute({ path: 'a.txt', offset: 1, limit: 100 }, ctx)
    expect(readOut).toContain('hello')
    expect(readOut).toContain('world')

    await editTool.execute(
      { path: 'a.txt', oldString: 'world', newString: 'pi', replaceAll: false },
      ctx,
    )
    const edited = await readFile(path.join(dir, 'a.txt'), 'utf8')
    expect(edited).toBe('hello\npi')
  })

  it('edit fails if oldString is not unique', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-'))
    await writeFile(path.join(dir, 'b.txt'), 'x\nx\n', 'utf8')
    await expect(
      editTool.execute(
        { path: 'b.txt', oldString: 'x', newString: 'y', replaceAll: false },
        makeCtx(dir),
      ),
    ).rejects.toThrow(/is not unique/)
  })

  it('read rejects paths outside the cwd', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-'))
    await expect(
      readTool.execute({ path: '../etc/passwd' }, makeCtx(dir)),
    ).rejects.toThrow(/outside the allowed cwd/)
  })
})
