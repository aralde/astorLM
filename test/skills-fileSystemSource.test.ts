import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createFileSystemSkillSource } from '../src/core.js'

async function writeSkill(
  dir: string,
  folder: string,
  meta: Record<string, string> | null,
  body: string,
) {
  await mkdir(path.join(dir, folder), { recursive: true })
  let content = ''
  if (meta) {
    content += '---\n'
    for (const [k, v] of Object.entries(meta)) {
      content += `${k}: ${v}\n`
    }
    content += '---\n'
  }
  content += body
  await writeFile(path.join(dir, folder, 'SKILL.md'), content, 'utf8')
}

describe('createFileSystemSkillSource', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'astorlm-skills-'))

    await writeSkill(
      root,
      'pptx',
      { name: 'pptx', description: 'Build PowerPoint decks.' },
      '# pptx body\nUse pptx-genjs.',
    )
    await writeSkill(
      root,
      'refactor',
      { name: 'refactor', description: 'Refactor TypeScript files.' },
      '# refactor body',
    )
  })

  it('uses the directory basename as the default source name (with fs: prefix)', () => {
    const src = createFileSystemSkillSource({ dir: root })
    expect(src.name.startsWith('fs:')).toBe(true)
  })

  it('lists every skill, alphabetical by folder', async () => {
    const src = createFileSystemSkillSource({ dir: root, name: 'test' })
    const list = await src.list()
    expect(list.map((s) => s.name)).toEqual(['pptx', 'refactor'])
    expect(list.every((s) => s.source === 'test')).toBe(true)
  })

  it('loads bodies on demand', async () => {
    const src = createFileSystemSkillSource({ dir: root, name: 'test' })
    const skill = await src.load('pptx')
    expect(skill).not.toBeNull()
    expect(skill!.body).toMatch(/# pptx body/)
    expect(skill!.description).toBe('Build PowerPoint decks.')
  })

  it('returns null for a non-existent skill', async () => {
    const src = createFileSystemSkillSource({ dir: root, name: 'test' })
    expect(await src.load('ghost')).toBeNull()
  })

  it('skips hidden directories', async () => {
    const hiddenRoot = await mkdtemp(path.join(tmpdir(), 'astorlm-skills-hidden-'))
    await writeSkill(
      hiddenRoot,
      '.cache',
      { name: '.cache', description: 'd' },
      '',
    )
    await writeSkill(
      hiddenRoot,
      'visible',
      { name: 'visible', description: 'd' },
      'body',
    )
    const src = createFileSystemSkillSource({ dir: hiddenRoot, name: 'h' })
    const list = await src.list()
    expect(list.map((s) => s.name)).toEqual(['visible'])
  })

  it('returns an empty list when the directory does not exist', async () => {
    const src = createFileSystemSkillSource({
      dir: path.join(root, 'does-not-exist'),
      name: 'g',
    })
    expect(await src.list()).toEqual([])
  })

  it('throws an actionable error when frontmatter is missing', async () => {
    const bad = await mkdtemp(path.join(tmpdir(), 'astorlm-skills-bad-'))
    await writeSkill(bad, 'broken', null, 'no frontmatter at all')
    const src = createFileSystemSkillSource({ dir: bad, name: 'bad' })
    await expect(src.list()).rejects.toThrow(/missing the YAML frontmatter/)
  })

  it('throws when frontmatter omits the name field', async () => {
    const bad = await mkdtemp(path.join(tmpdir(), 'astorlm-skills-noname-'))
    await writeSkill(bad, 'broken', { description: 'd' }, 'body')
    const src = createFileSystemSkillSource({ dir: bad, name: 'bad' })
    await expect(src.list()).rejects.toThrow(/missing the required "name" field/)
  })

  it('throws when frontmatter omits the description field', async () => {
    const bad = await mkdtemp(path.join(tmpdir(), 'astorlm-skills-nodesc-'))
    await writeSkill(bad, 'broken', { name: 'broken' }, 'body')
    const src = createFileSystemSkillSource({ dir: bad, name: 'bad' })
    await expect(src.list()).rejects.toThrow(/missing the required "description" field/)
  })

  it('throws when frontmatter name does not match the folder name', async () => {
    const bad = await mkdtemp(path.join(tmpdir(), 'astorlm-skills-drift-'))
    await writeSkill(
      bad,
      'foo',
      { name: 'bar', description: 'd' },
      'body',
    )
    const src = createFileSystemSkillSource({ dir: bad, name: 'bad' })
    await expect(src.list()).rejects.toThrow(/declares name "bar".*folder "foo"/)
  })

  it('exposes the absolute path of each SKILL.md', async () => {
    const src = createFileSystemSkillSource({ dir: root, name: 'test' })
    const list = await src.list()
    for (const s of list) {
      expect(s.path).toBeDefined()
      expect(path.isAbsolute(s.path!)).toBe(true)
      expect(s.path!.endsWith('SKILL.md')).toBe(true)
    }
    const loaded = await src.load('pptx')
    expect(loaded?.path).toBeDefined()
    expect(loaded!.path!.endsWith(path.join('pptx', 'SKILL.md'))).toBe(true)
  })

  it('captures extra frontmatter fields into metadata', async () => {
    const extra = await mkdtemp(path.join(tmpdir(), 'astorlm-skills-extra-'))
    await writeSkill(
      extra,
      'mything',
      {
        name: 'mything',
        description: 'something',
        version: '2.0.0',
        tags: 'foo,bar',
        license: 'MIT',
      },
      '# body',
    )
    const src = createFileSystemSkillSource({ dir: extra, name: 'x' })
    const list = await src.list()
    expect(list[0]?.metadata).toEqual({
      version: '2.0.0',
      tags: 'foo,bar',
      license: 'MIT',
    })
    const loaded = await src.load('mything')
    expect(loaded?.metadata).toEqual({
      version: '2.0.0',
      tags: 'foo,bar',
      license: 'MIT',
    })
  })

  it('omits metadata when frontmatter has only name/description', async () => {
    const minimal = await mkdtemp(path.join(tmpdir(), 'astorlm-skills-minimal-'))
    await writeSkill(
      minimal,
      'only-required',
      { name: 'only-required', description: 'd' },
      'body',
    )
    const src = createFileSystemSkillSource({ dir: minimal, name: 'x' })
    const list = await src.list()
    expect(list[0]?.metadata).toBeUndefined()
  })

  it('throws on spec-violating names with the file path in the message', async () => {
    const bad = await mkdtemp(path.join(tmpdir(), 'astorlm-skills-badname-'))
    await writeSkill(bad, 'BAD_NAME', { name: 'BAD_NAME', description: 'd' }, 'body')
    const src = createFileSystemSkillSource({ dir: bad, name: 'x' })
    await expect(src.list()).rejects.toThrow(
      new RegExp(`Skill at .+BAD_NAME.+SKILL\\.md.+invalid name`),
    )
  })

  it('throws on spec-violating descriptions (XML in description)', async () => {
    const bad = await mkdtemp(path.join(tmpdir(), 'astorlm-skills-baddesc-'))
    await writeSkill(
      bad,
      'okname',
      { name: 'okname', description: 'See <foo> for details' },
      'body',
    )
    const src = createFileSystemSkillSource({ dir: bad, name: 'x' })
    await expect(src.list()).rejects.toThrow(/invalid description.*XML tags/)
  })
})
