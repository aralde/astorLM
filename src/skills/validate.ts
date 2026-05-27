/**
 * Spec-level validation for skill metadata.
 *
 * Mirrors the rules published in the Agent Skills specification
 * (Anthropic / agentskills.io, May 2026) so that skills authored for
 * Claude Code, Codex, Gemini CLI, Cursor, Kiro, etc. are
 * byte-for-byte interoperable with astorlm — and vice versa.
 *
 * Rules currently enforced:
 *   - `name`: 1..64 chars, regex `^[a-z0-9][a-z0-9-]*$`, must not equal
 *     reserved identifiers (`anthropic`, `claude`).
 *   - `description`: 1..1024 chars, must not contain XML tags
 *     (anything matching `</?[a-zA-Z][^>]*>`).
 *
 * Validation is strict: any violation throws with a message that names
 * the field, the offending value, and the rule. Callers are expected
 * to catch and surface to the user (the file-system source already
 * does this with file paths so the user knows which SKILL.md to fix).
 */

const NAME_MAX = 64
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const RESERVED_NAMES = new Set(['anthropic', 'claude'])

const DESCRIPTION_MAX = 1024
// Loose-but-reliable: any '<word...>' or '</word...>' shape counts as XML.
const XML_TAG_RE = /<\/?[a-zA-Z][^>]*>/

export class SkillValidationError extends Error {
  constructor(
    public readonly field: 'name' | 'description',
    public readonly value: string,
    public readonly rule: string,
  ) {
    super(`Invalid skill ${field} ${JSON.stringify(value)}: ${rule}`)
    this.name = 'SkillValidationError'
  }
}

export function validateSkillName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new SkillValidationError('name', String(name), 'must be a non-empty string')
  }
  if (name.length > NAME_MAX) {
    throw new SkillValidationError(
      'name',
      name,
      `must be at most ${NAME_MAX} characters (got ${name.length})`,
    )
  }
  if (!NAME_RE.test(name)) {
    throw new SkillValidationError(
      'name',
      name,
      'must match /^[a-z0-9][a-z0-9-]*$/ (lowercase letters, digits and hyphens; no leading hyphen)',
    )
  }
  if (RESERVED_NAMES.has(name)) {
    throw new SkillValidationError(
      'name',
      name,
      `is a reserved identifier (${[...RESERVED_NAMES].join(', ')})`,
    )
  }
  return name
}

export function validateSkillDescription(description: unknown): string {
  if (typeof description !== 'string' || description.length === 0) {
    throw new SkillValidationError(
      'description',
      String(description),
      'must be a non-empty string',
    )
  }
  if (description.length > DESCRIPTION_MAX) {
    throw new SkillValidationError(
      'description',
      description.slice(0, 32) + '…',
      `must be at most ${DESCRIPTION_MAX} characters (got ${description.length})`,
    )
  }
  if (XML_TAG_RE.test(description)) {
    throw new SkillValidationError(
      'description',
      description,
      'must not contain XML tags (e.g. <foo>)',
    )
  }
  return description
}

/**
 * Convenience wrapper that runs both validators in one call. Returns
 * the cleaned name and description; if you need extra frontmatter
 * fields, capture them separately (they go into `Skill.metadata`).
 */
export function validateSkillSpec(input: {
  name: unknown
  description: unknown
}): { name: string; description: string } {
  return {
    name: validateSkillName(input.name),
    description: validateSkillDescription(input.description),
  }
}

/** Internal — exposed for tests. */
export const SKILL_VALIDATION_LIMITS = Object.freeze({
  nameMax: NAME_MAX,
  descriptionMax: DESCRIPTION_MAX,
  reservedNames: Object.freeze([...RESERVED_NAMES]),
})
