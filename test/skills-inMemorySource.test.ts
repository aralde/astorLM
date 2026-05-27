import { describe, expect, it } from 'vitest'
import { createInMemorySkillSource } from '../src/skills/inMemorySource.js'

describe('createInMemorySkillSource', () => {
  it('defaults source name to "in-memory"', async () => {
    const src = createInMemorySkillSource({
      skills: [{ name: 'foo', description: 'd', body: 'b' }],
    })
    expect(src.name).toBe('in-memory')
    const meta = await src.list()
    expect(meta[0].source).toBe('in-memory')
  })

  it('honors a custom name and propagates it into metadata', async () => {
    const src = createInMemorySkillSource({
      name: 'my-bundle',
      skills: [{ name: 'foo', description: 'd', body: 'b' }],
    })
    const meta = await src.list()
    expect(meta[0].source).toBe('my-bundle')
  })

  it('list() and load() round-trip', async () => {
    const src = createInMemorySkillSource({
      skills: [
        { name: 'foo', description: 'a foo', body: 'foo body' },
        { name: 'bar', description: 'a bar', body: 'bar body' },
      ],
    })

    const list = await src.list()
    expect(list.map((s) => s.name).sort()).toEqual(['bar', 'foo'])

    const loaded = await src.load('foo')
    expect(loaded?.body).toBe('foo body')
    expect(loaded?.description).toBe('a foo')
  })

  it('load() returns null when the skill does not exist', async () => {
    const src = createInMemorySkillSource({
      skills: [{ name: 'foo', description: 'd', body: 'b' }],
    })
    expect(await src.load('ghost')).toBeNull()
  })

  it('throws on intra-source duplicate names at construction time', () => {
    expect(() =>
      createInMemorySkillSource({
        skills: [
          { name: 'dup', description: 'd1', body: 'b1' },
          { name: 'dup', description: 'd2', body: 'b2' },
        ],
      }),
    ).toThrow(/duplicate skill name "dup"/)
  })

  it('rejects spec-violating names with a contextual error', () => {
    expect(() =>
      createInMemorySkillSource({
        name: 'demo',
        skills: [{ name: 'BAD_NAME', description: 'd', body: 'b' }],
      }),
    ).toThrow(/source "demo".*lowercase/)
  })

  it('propagates extra metadata when provided', async () => {
    const src = createInMemorySkillSource({
      skills: [
        {
          name: 'foo',
          description: 'd',
          body: 'b',
          metadata: { version: '1.2.3', tags: 'sql,review' },
        },
      ],
    })
    const list = await src.list()
    expect(list[0]?.metadata).toEqual({ version: '1.2.3', tags: 'sql,review' })
    const loaded = await src.load('foo')
    expect(loaded?.metadata).toEqual({ version: '1.2.3', tags: 'sql,review' })
  })

  it('omits metadata when none was provided', async () => {
    const src = createInMemorySkillSource({
      skills: [{ name: 'foo', description: 'd', body: 'b' }],
    })
    const list = await src.list()
    expect(list[0]?.metadata).toBeUndefined()
  })

  it('does not expose a filesystem path', async () => {
    const src = createInMemorySkillSource({
      skills: [{ name: 'foo', description: 'd', body: 'b' }],
    })
    const list = await src.list()
    expect(list[0]?.path).toBeUndefined()
    const loaded = await src.load('foo')
    expect(loaded?.path).toBeUndefined()
  })
})
