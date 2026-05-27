import { describe, expect, it } from 'vitest'
import {
  SkillValidationError,
  validateSkillDescription,
  validateSkillName,
  validateSkillSpec,
  SKILL_VALIDATION_LIMITS,
} from '../src/skills/validate.js'

describe('validateSkillName', () => {
  it('accepts spec-conformant names', () => {
    expect(validateSkillName('pptx')).toBe('pptx')
    expect(validateSkillName('pptx-deck')).toBe('pptx-deck')
    expect(validateSkillName('a1-b2-c3')).toBe('a1-b2-c3')
    expect(validateSkillName('x')).toBe('x')
  })

  it('rejects empty / non-string', () => {
    expect(() => validateSkillName('')).toThrow(SkillValidationError)
    expect(() => validateSkillName(undefined)).toThrow(/non-empty string/)
    expect(() => validateSkillName(null)).toThrow(/non-empty string/)
    expect(() => validateSkillName(42)).toThrow(/non-empty string/)
  })

  it('rejects names that exceed the max length', () => {
    const tooLong = 'a'.repeat(SKILL_VALIDATION_LIMITS.nameMax + 1)
    expect(() => validateSkillName(tooLong)).toThrow(
      new RegExp(`at most ${SKILL_VALIDATION_LIMITS.nameMax}`),
    )
  })

  it('accepts the boundary length', () => {
    const ok = 'a'.repeat(SKILL_VALIDATION_LIMITS.nameMax)
    expect(validateSkillName(ok)).toBe(ok)
  })

  it('rejects uppercase, underscores, spaces, and other charset violations', () => {
    expect(() => validateSkillName('PPTX')).toThrow(/lowercase/)
    expect(() => validateSkillName('pptx_deck')).toThrow(/lowercase/)
    expect(() => validateSkillName('pptx deck')).toThrow(/lowercase/)
    expect(() => validateSkillName('pptx.deck')).toThrow(/lowercase/)
    expect(() => validateSkillName('pptx!')).toThrow(/lowercase/)
  })

  it('rejects names with a leading hyphen', () => {
    expect(() => validateSkillName('-pptx')).toThrow(/no leading hyphen/)
  })

  it('rejects reserved identifiers', () => {
    expect(() => validateSkillName('anthropic')).toThrow(/reserved/)
    expect(() => validateSkillName('claude')).toThrow(/reserved/)
  })

  it('attaches field and rule on the error', () => {
    try {
      validateSkillName('PPTX')
    } catch (err) {
      expect(err).toBeInstanceOf(SkillValidationError)
      expect((err as SkillValidationError).field).toBe('name')
      expect((err as SkillValidationError).value).toBe('PPTX')
    }
  })
})

describe('validateSkillDescription', () => {
  it('accepts spec-conformant descriptions', () => {
    const ok = 'Build a PowerPoint deck when the user asks for slides.'
    expect(validateSkillDescription(ok)).toBe(ok)
  })

  it('rejects empty / non-string', () => {
    expect(() => validateSkillDescription('')).toThrow(/non-empty string/)
    expect(() => validateSkillDescription(undefined)).toThrow(/non-empty string/)
  })

  it('rejects descriptions over the max length', () => {
    const tooLong = 'x'.repeat(SKILL_VALIDATION_LIMITS.descriptionMax + 1)
    expect(() => validateSkillDescription(tooLong)).toThrow(
      new RegExp(`at most ${SKILL_VALIDATION_LIMITS.descriptionMax}`),
    )
  })

  it('rejects descriptions containing XML tags', () => {
    expect(() => validateSkillDescription('Build a deck <foo>')).toThrow(/XML tags/)
    expect(() => validateSkillDescription('See </p> for context')).toThrow(/XML tags/)
    expect(() => validateSkillDescription('<a href="x">deck</a>')).toThrow(/XML tags/)
  })

  it('allows punctuation, parentheses, dashes, code-fences', () => {
    expect(validateSkillDescription('Use the `read` tool — first.')).toMatch(/Use the/)
    expect(validateSkillDescription('Steps: (1) read, (2) edit.')).toMatch(/Steps/)
  })

  it("does not flag a single '<' or '>' without a tag shape", () => {
    expect(validateSkillDescription('5 < 6 and 6 > 5')).toMatch(/5/)
  })
})

describe('validateSkillSpec', () => {
  it('returns both fields after validating each', () => {
    const out = validateSkillSpec({ name: 'pptx', description: 'Build a deck.' })
    expect(out).toEqual({ name: 'pptx', description: 'Build a deck.' })
  })

  it('throws on the first invalid field', () => {
    expect(() => validateSkillSpec({ name: 'PPTX', description: 'ok' })).toThrow(/name/)
  })
})
