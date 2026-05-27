import { describe, expect, it } from 'vitest'
import { SkillRegistry } from '../src/skills/registry.js'
import { createInMemorySkillSource } from '../src/skills/inMemorySource.js'
import type { SkillSource } from '../src/skills/types.js'

const fixture = (name: string, description: string, body: string) => ({
  name,
  description,
  body,
})

describe('SkillRegistry', () => {
  it('aggregates metadata from multiple sources in registration order', async () => {
    const a = createInMemorySkillSource({
      name: 'src-a',
      skills: [fixture('one', 'first skill', '# one')],
    })
    const b = createInMemorySkillSource({
      name: 'src-b',
      skills: [fixture('two', 'second skill', '# two')],
    })

    const reg = new SkillRegistry([a, b])
    await reg.init()

    expect(reg.size).toBe(2)
    expect(reg.list().map((s) => s.name)).toEqual(['one', 'two'])
    expect(reg.list().map((s) => s.source)).toEqual(['src-a', 'src-b'])
  })

  it('throws on name conflict across sources at init()', async () => {
    const a = createInMemorySkillSource({
      name: 'src-a',
      skills: [fixture('dup', 'from a', 'body a')],
    })
    const b = createInMemorySkillSource({
      name: 'src-b',
      skills: [fixture('dup', 'from b', 'body b')],
    })

    const reg = new SkillRegistry([a, b])
    await expect(reg.init()).rejects.toThrow(/Skill name conflict.*"dup".*"src-a".*"src-b"/)
  })

  it('refuses use before init()', () => {
    const reg = new SkillRegistry([])
    expect(() => reg.list()).toThrow(/init\(\) before use/)
    expect(() => reg.size).toThrow(/init\(\) before use/)
    expect(() => reg.has('x')).toThrow(/init\(\) before use/)
  })

  it('init() is idempotent', async () => {
    const a = createInMemorySkillSource({
      name: 'src-a',
      skills: [fixture('one', '1', 'b')],
    })
    const reg = new SkillRegistry([a])
    await reg.init()
    await reg.init() // should not throw or re-enumerate
    expect(reg.size).toBe(1)
  })

  it('load() returns the body and caches subsequent calls', async () => {
    let listCalls = 0
    let loadCalls = 0
    const src: SkillSource = {
      name: 'spy',
      async list() {
        listCalls++
        return [{ name: 'cached', description: 'd', source: 'spy' }]
      },
      async load(name) {
        loadCalls++
        if (name !== 'cached') return null
        return { name, description: 'd', source: 'spy', body: 'BODY' }
      },
    }

    const reg = new SkillRegistry([src])
    await reg.init()

    const first = await reg.load('cached')
    const second = await reg.load('cached')
    expect(first?.body).toBe('BODY')
    expect(second).toBe(first) // same instance from cache
    expect(loadCalls).toBe(1)
    expect(listCalls).toBe(1)
  })

  it('load() returns null for unknown skill', async () => {
    const a = createInMemorySkillSource({
      name: 'src-a',
      skills: [fixture('exists', 'd', 'b')],
    })
    const reg = new SkillRegistry([a])
    await reg.init()
    expect(await reg.load('ghost')).toBeNull()
  })

  it('loadAll() materialises every skill in list() order', async () => {
    const a = createInMemorySkillSource({
      name: 'src-a',
      skills: [fixture('one', '1', 'body-one'), fixture('two', '2', 'body-two')],
    })
    const reg = new SkillRegistry([a])
    await reg.init()

    const all = await reg.loadAll()
    expect(all.map((s) => s.name)).toEqual(['one', 'two'])
    expect(all.map((s) => s.body)).toEqual(['body-one', 'body-two'])
  })

  it('overrides metadata.source with the actual source name (defensive)', async () => {
    // Source whose list() reports a wrong `source` field.
    const liar: SkillSource = {
      name: 'truth',
      async list() {
        return [{ name: 'one', description: 'd', source: 'LIES' }]
      },
      async load() {
        return { name: 'one', description: 'd', source: 'LIES', body: 'b' }
      },
    }

    const reg = new SkillRegistry([liar])
    await reg.init()
    expect(reg.list()[0].source).toBe('truth')

    const loaded = await reg.load('one')
    expect(loaded?.source).toBe('truth')
  })
})
