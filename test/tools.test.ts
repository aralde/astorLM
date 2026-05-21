import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineTool } from '../src/tools/define.js'
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

describe('defineTool', () => {
  it('valida input con zod y genera inputSchema', async () => {
    const tool = defineTool({
      name: 'echo',
      description: 'echo',
      schema: z.object({ text: z.string() }),
      execute: async ({ text }) => text.toUpperCase(),
    })
    expect(tool.inputSchema['type']).toBe('object')
    expect(() => tool.parseInput({ text: 123 })).toThrow()
    const out = await tool.execute({ text: 'hola' }, makeCtx(process.cwd()))
    expect(out).toBe('HOLA')
  })
})

describe('ToolRegistry', () => {
  it('rechaza nombres duplicados', () => {
    const reg = new ToolRegistry()
    const t = defineTool({
      name: 'x',
      description: '',
      schema: z.object({}),
      execute: async () => 'ok',
    })
    reg.register(t)
    expect(() => reg.register(t)).toThrow(/ya registrada/)
  })

  it('run() devuelve isError=true con tool desconocida', async () => {
    const reg = new ToolRegistry()
    const res = await reg.run('inexistente', {}, makeCtx(process.cwd()))
    expect(res.isError).toBe(true)
  })

  it('captura excepciones de execute como isError=true', async () => {
    const reg = new ToolRegistry()
    reg.register(
      defineTool({
        name: 'boom',
        description: '',
        schema: z.object({}),
        execute: async () => {
          throw new Error('explotó')
        },
      }),
    )
    const res = await reg.run('boom', {}, makeCtx(process.cwd()))
    expect(res.isError).toBe(true)
    expect(res.output).toContain('explotó')
  })
})

describe('built-in tools (read/write/edit)', () => {
  it('write + read + edit en tmpdir', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-'))
    const ctx = makeCtx(dir)

    await writeTool.execute({ path: 'a.txt', content: 'hola\nmundo' }, ctx)
    const raw = await readFile(path.join(dir, 'a.txt'), 'utf8')
    expect(raw).toBe('hola\nmundo')

    const readOut = await readTool.execute({ path: 'a.txt', offset: 1, limit: 100 }, ctx)
    expect(readOut).toContain('hola')
    expect(readOut).toContain('mundo')

    await editTool.execute(
      { path: 'a.txt', oldString: 'mundo', newString: 'pi', replaceAll: false },
      ctx,
    )
    const edited = await readFile(path.join(dir, 'a.txt'), 'utf8')
    expect(edited).toBe('hola\npi')
  })

  it('edit falla si oldString no es único', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-'))
    await writeFile(path.join(dir, 'b.txt'), 'x\nx\n', 'utf8')
    await expect(
      editTool.execute(
        { path: 'b.txt', oldString: 'x', newString: 'y', replaceAll: false },
        makeCtx(dir),
      ),
    ).rejects.toThrow(/no es único/)
  })

  it('read rechaza paths fuera del cwd', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-'))
    await expect(
      readTool.execute({ path: '../etc/passwd' }, makeCtx(dir)),
    ).rejects.toThrow(/fuera del cwd/)
  })
})
