import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent/session.js'
import { createInMemorySkillSource } from '../src/skills/inMemorySource.js'
import { renderSkillsBlock } from '../src/skills/promptBlock.js'
import { createFileSystemSkillSource } from '../src/core.js'
import { MockProvider } from './mock-provider.js'
import type { SkillMetadata } from '../src/skills/types.js'

async function writeSkill(dir: string, folder: string, name: string, description: string) {
  await mkdir(path.join(dir, folder), { recursive: true })
  await writeFile(
    path.join(dir, folder, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# body\nstep 1\n`,
    'utf8',
  )
}

describe("renderSkillsBlock — mode: 'filesystem'", () => {
  it('emits an <available-skills> block with paths and a read-tool instruction', () => {
    const skills: SkillMetadata[] = [
      {
        name: 'pptx',
        description: 'Build PowerPoint decks.',
        source: 'fs:demo',
        path: '/abs/path/to/skills/pptx/SKILL.md',
      },
      {
        name: 'sql-review',
        description: 'Review SQL migrations.',
        source: 'fs:demo',
        path: '/abs/path/to/skills/sql-review/SKILL.md',
      },
    ]
    const block = renderSkillsBlock(skills, 'filesystem')
    expect(block).toContain('<available-skills>')
    expect(block).toContain('the `read` tool')
    expect(block).toContain('`pptx`')
    expect(block).toContain('/abs/path/to/skills/pptx/SKILL.md')
    expect(block).toContain('`sql-review`')
    expect(block).toContain('/abs/path/to/skills/sql-review/SKILL.md')
    // No `load_skill` reference in this mode.
    expect(block).not.toContain('load_skill')
    // No bare YAML-ish `path:` label (it primes some models to leak
    // the literal `path:` prefix into their tool-call function names).
    expect(block).not.toMatch(/^\s*path:\s/m)
  })

  it('normalises Windows backslashes to forward slashes in the rendered block', () => {
    const skills: SkillMetadata[] = [
      {
        name: 'pptx',
        description: 'd',
        source: 's',
        path: 'C:\\Users\\ariel\\skills\\pptx\\SKILL.md',
      },
    ]
    const block = renderSkillsBlock(skills, 'filesystem')
    expect(block).toContain('C:/Users/ariel/skills/pptx/SKILL.md')
    expect(block).not.toContain('C:\\Users')
  })

  it('throws when any skill is missing a path', () => {
    const skills: SkillMetadata[] = [
      {
        name: 'pptx',
        description: 'Build PowerPoint decks.',
        source: 'fs:demo',
        path: '/abs/path/pptx/SKILL.md',
      },
      // No path — should trip the renderer
      { name: 'broken', description: 'd', source: 'mem' },
    ]
    expect(() => renderSkillsBlock(skills, 'filesystem')).toThrow(/"broken" is missing a path/)
  })

  it('returns empty string when no skills are provided', () => {
    expect(renderSkillsBlock([], 'filesystem')).toBe('')
  })
})

describe("session integration — mode: 'filesystem'", () => {
  let skillsDir: string

  beforeAll(async () => {
    skillsDir = await mkdtemp(path.join(tmpdir(), 'astorlm-fs-mode-'))
    await writeSkill(skillsDir, 'pptx', 'pptx', 'Build PowerPoint decks.')
    await writeSkill(skillsDir, 'sql-review', 'sql-review', 'Review SQL migrations.')
  })

  it('lists paths and does NOT register load_skill', async () => {
    const provider = new MockProvider([{ text: 'ok', stopReason: 'end_turn' }])
    const session = await createAgent({
      provider,
      skillSources: [createFileSystemSkillSource({ dir: skillsDir, name: 'fs' })],
      skillMode: 'filesystem',
    })

    expect(session.registry.has('load_skill')).toBe(false)

    await session.run('Hello')

    const sentSystem = provider.calls[0]!.systemPrompt
    expect(sentSystem).toContain('<available-skills>')
    expect(sentSystem).toContain('the `read` tool')
    expect(sentSystem).toContain('`pptx`')
    // The skill listing must reference the SKILL.md absolute path.
    expect(sentSystem).toMatch(/pptx\/SKILL\.md/)
    // Bodies must NOT be inlined in this mode.
    expect(sentSystem).not.toContain('# body')
    expect(sentSystem).not.toContain('step 1')
  })

  it('throws when any source provides a pathless skill', async () => {
    const provider = new MockProvider([])
    const fsSource = createFileSystemSkillSource({ dir: skillsDir, name: 'fs' })
    const memSource = createInMemorySkillSource({
      name: 'mem',
      skills: [{ name: 'no-path-here', description: 'no path on me', body: 'b' }],
    })

    await expect(
      createAgent({
        provider,
        skillSources: [fsSource, memSource],
        skillMode: 'filesystem',
      }),
    ).rejects.toThrow(/filesystem.*requires every skill to expose a filesystem path/)
  })
})
