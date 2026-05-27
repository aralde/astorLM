/**
 * Minimal YAML-frontmatter parser tailored for SKILL.md files.
 *
 * We deliberately avoid pulling a YAML dependency: skill frontmatters
 * are small and shaped like `key: value` pairs. If a future skill needs
 * nested YAML, lists, or multiline strings, swap this for the `yaml`
 * package — keep the public signature stable.
 *
 * Supported:
 *   - `key: value` pairs (one per line)
 *   - Optional surrounding single or double quotes around the value
 *   - `# ...` comment lines (skipped)
 *   - Blank lines (skipped)
 *
 * Not supported (will be returned as raw strings without further parsing):
 *   - Multiline values, block scalars
 *   - Lists, nested objects
 *   - Anchors and references
 */

export interface ParsedFrontmatter {
  /** All keys declared in the frontmatter, as strings. */
  meta: Record<string, string>
  /** Markdown body (everything after the closing `---`). */
  body: string
  /** True when a frontmatter block was actually found and parsed. */
  hasFrontmatter: boolean
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export function parseSkillFrontmatter(content: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(content)
  if (!match) {
    return { meta: {}, body: content, hasFrontmatter: false }
  }

  const rawMeta = match[1] ?? ''
  const body = match[2] ?? ''
  const meta: Record<string, string> = {}

  for (const rawLine of rawMeta.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const colon = line.indexOf(':')
    if (colon === -1) continue

    const key = line.slice(0, colon).trim()
    if (key === '') continue

    let value = line.slice(colon + 1).trim()
    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    meta[key] = value
  }

  return { meta, body, hasFrontmatter: true }
}
