import { describe, expect, it } from 'vitest'
import { parseSkillFrontmatter } from '../src/skills/parseFrontmatter.js'

describe('parseSkillFrontmatter', () => {
  it('parses a well-formed frontmatter block', () => {
    const src = [
      '---',
      'name: pptx',
      'description: Build PowerPoint decks from prompts.',
      '---',
      '',
      '# Body title',
      'Some markdown content.',
      '',
    ].join('\n')

    const { meta, body, hasFrontmatter } = parseSkillFrontmatter(src)
    expect(hasFrontmatter).toBe(true)
    expect(meta).toEqual({
      name: 'pptx',
      description: 'Build PowerPoint decks from prompts.',
    })
    expect(body.trim()).toBe('# Body title\nSome markdown content.')
  })

  it('reports hasFrontmatter=false and returns the whole content as body when missing', () => {
    const src = '# Just a body\nNo frontmatter here.'
    const { meta, body, hasFrontmatter } = parseSkillFrontmatter(src)
    expect(hasFrontmatter).toBe(false)
    expect(meta).toEqual({})
    expect(body).toBe(src)
  })

  it('strips matching surrounding quotes around values', () => {
    const src = [
      '---',
      'name: "foo"',
      "description: 'has: a colon inside'",
      '---',
      'body',
    ].join('\n')

    const { meta } = parseSkillFrontmatter(src)
    expect(meta.name).toBe('foo')
    expect(meta.description).toBe('has: a colon inside')
  })

  it('keeps mismatched quotes verbatim', () => {
    const src = ['---', `name: "no-close`, '---', 'body'].join('\n')
    const { meta } = parseSkillFrontmatter(src)
    expect(meta.name).toBe('"no-close')
  })

  it('ignores comments and blank lines inside the frontmatter', () => {
    const src = [
      '---',
      '# leading comment',
      '',
      'name: x',
      '# trailing comment',
      'description: y',
      '---',
      'body',
    ].join('\n')

    const { meta } = parseSkillFrontmatter(src)
    expect(meta).toEqual({ name: 'x', description: 'y' })
  })

  it('handles CRLF line endings', () => {
    const src = '---\r\nname: x\r\ndescription: y\r\n---\r\nhello'
    const { meta, body } = parseSkillFrontmatter(src)
    expect(meta).toEqual({ name: 'x', description: 'y' })
    expect(body).toBe('hello')
  })

  it('skips lines that lack a colon separator', () => {
    const src = ['---', 'name: x', 'this-line-has-no-colon', 'description: y', '---', ''].join(
      '\n',
    )
    const { meta } = parseSkillFrontmatter(src)
    expect(meta).toEqual({ name: 'x', description: 'y' })
  })
})
