/**
 * Public barrel for the skills subsystem.
 *
 * Stable API. Anything exported from here is re-exported from
 * `astorlm` (the main entry point) and considered part of the SDK
 * surface. Internal helpers stay unexported on purpose.
 */

export type { Skill, SkillMetadata, SkillSource, SkillMode } from './types.js'
export { SkillRegistry } from './registry.js'
export { createInMemorySkillSource } from './inMemorySource.js'
export type { InMemorySkillSourceOptions } from './inMemorySource.js'
export { parseSkillFrontmatter } from './parseFrontmatter.js'
export type { ParsedFrontmatter } from './parseFrontmatter.js'
export { renderSkillsBlock } from './promptBlock.js'
export { createLoadSkillTool } from './loadTool.js'
export {
  validateSkillName,
  validateSkillDescription,
  validateSkillSpec,
  SkillValidationError,
  SKILL_VALIDATION_LIMITS,
} from './validate.js'
export { parseAllowedTools, restrictToolsHook } from './toolPolicy.js'
export type { RestrictToolsOptions } from './toolPolicy.js'
