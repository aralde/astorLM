import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLayeredSkillSource } from '../src/skills-node/layeredSource.js'
import { SkillRegistry } from '../src/skills/registry.js'

async function writeSkill(dir: string, name: string, description: string, body = 'body') {
  const folder = path.join(dir, name)
  await mkdir(folder, { recursive: true })
  await writeFile(
    path.join(folder, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    'utf8',
  )
}

describe('createLayeredSkillSource', () => {
  it('lets a higher-precedence layer override a same-named skill and fires onOverride', async () => {
    const userDir = await mkdtemp(path.join(tmpdir(), 'astor-user-'))
    const projectDir = await mkdtemp(path.join(tmpdir(), 'astor-proj-'))

    await writeSkill(userDir, 'review', 'user-level review', 'USER BODY')
    await writeSkill(projectDir, 'review', 'project-level review', 'PROJECT BODY')
    await writeSkill(userDir, 'lonely', 'only in user layer')

    const overrides: Array<{ name: string; winner: string; loser: string }> = []
    const source = createLayeredSkillSource({
      layers: [userDir, projectDir], // project (later) wins
      onOverride: (info) => overrides.push(info),
    })

    const metas = await source.list()
    const review = metas.find((m) => m.name === 'review')!
    expect(review.description).toBe('project-level review')
    expect(metas.map((m) => m.name).sort()).toEqual(['lonely', 'review'])

    // The winning body comes from the project layer.
    const loaded = await source.load('review')
    expect(loaded?.body.trim()).toBe('PROJECT BODY')
    expect(loaded?.source).toBe('layered')

    expect(overrides).toHaveLength(1)
    expect(overrides[0]!.name).toBe('review')
  })

  it('presents as a single source so the registry never throws on the overridden name', async () => {
    const userDir = await mkdtemp(path.join(tmpdir(), 'astor-user-'))
    const projectDir = await mkdtemp(path.join(tmpdir(), 'astor-proj-'))
    await writeSkill(userDir, 'dup', 'a')
    await writeSkill(projectDir, 'dup', 'b')

    const registry = new SkillRegistry([
      createLayeredSkillSource({ layers: [userDir, projectDir] }),
    ])
    await expect(registry.init()).resolves.toBeUndefined()
    expect(registry.size).toBe(1)
    expect(registry.list()[0]!.description).toBe('b')
  })
})
