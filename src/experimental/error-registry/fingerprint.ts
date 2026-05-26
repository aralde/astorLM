import { createHash } from 'node:crypto'

/**
 * Normalizes an error message by stripping volatile data that would
 * prevent matching two occurrences of the "same" error across different
 * contexts. The goal is not perfection — it is to reduce variance
 * enough for the embedder (or the fuzzy matcher) to see comparable text.
 *
 * Patterns handled, in order:
 *  - UUIDs → <UUID>            (first, because they contain hex digit
 *                               substrings that would fool later matchers)
 *  - ARNs  → <ARN>             (more specific than bare account IDs)
 *  - AWS account IDs (12 digits) → <ACCOUNT>
 *  - ISO 8601 timestamps → <TS>
 *  - Epoch (10 or 13 digits) → <TS>
 *  - IPv4 / IPv6 → <IP>
 *  - Memory addresses 0x...   → <ADDR>
 *  - Windows + POSIX absolute paths → <PATH>/basename
 *  - "file.ts:123:45" in stack frames → "file.ts" (line/col dropped)
 *  - Lowercase + whitespace collapse.
 */
export function normalizeError(raw: string): string {
  let s = raw
  // UUIDs FIRST — they contain 12-hex-digit sub-substrings that would
  // otherwise be misidentified as account IDs if we ran that pass first.
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>')
  // ARNs (more specific than bare account IDs)
  s = s.replace(/arn:[a-z0-9-]+:[a-z0-9-]*:[a-z0-9-]*:\d{12}:[^\s"']+/gi, '<ARN>')
  // AWS account IDs (12 isolated digits)
  s = s.replace(/\b\d{12}\b/g, '<ACCOUNT>')
  // ISO timestamps
  s = s.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<TS>')
  // Epoch (10 or 13 digits)
  s = s.replace(/\b\d{13}\b/g, '<TS>')
  s = s.replace(/\b\d{10}\b/g, '<TS>')
  // IPv4
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<IP>')
  // IPv6 (simple heuristic — at least two colons and hex digits)
  s = s.replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, '<IP>')
  // Memory addresses
  s = s.replace(/\b0x[0-9a-f]+\b/gi, '<ADDR>')
  // Windows paths: C:\foo\bar or C:/foo/bar
  s = s.replace(/[a-zA-Z]:[\\/](?:[^\s"']+[\\/])*[^\s"':]+/g, (m) => {
    // Keep the basename, drop the directory.
    const base = m.split(/[\\/]/).pop() ?? ''
    return base ? `<PATH>/${base}` : '<PATH>'
  })
  // POSIX absolute paths: /foo/bar/baz
  s = s.replace(/(?:^|\s)\/(?:[^\s"'/:]+\/)+[^\s"':]+/g, (m) => {
    const leading = m.startsWith(' ') ? ' ' : ''
    const base = m.trim().split('/').pop() ?? ''
    return base ? `${leading}<PATH>/${base}` : `${leading}<PATH>`
  })
  // Strip ":line:col" from stack frames.
  s = s.replace(/(\.[a-z0-9]{1,5}):\d+(?::\d+)?/gi, '$1')
  // Lowercase + whitespace collapse.
  s = s.toLowerCase().replace(/\s+/g, ' ').trim()
  return s
}

/**
 * Deterministic fingerprint = sha256(normalizedError + '|' + toolName).slice(0,16).
 * Used for O(1) dedupe without needing embeddings.
 */
export function fingerprintError(normalizedError: string, toolName: string): string {
  return createHash('sha256').update(`${normalizedError}|${toolName}`).digest('hex').slice(0, 16)
}

/**
 * Lightweight tokenization for the fuzzy matcher (fallback without
 * embeddings). Drops common stopwords and splits on non-word chars.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'this', 'that',
  'it', 'its', 'i', 'you', 'we', 'he', 'she', 'they', 'them', 'their',
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'pero',
  'es', 'son', 'era', 'fueron', 'en', 'de', 'del', 'al', 'por', 'para',
])

export function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_<>]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
  return new Set(tokens)
}

/** Jaccard similarity over token sets. Returns [0..1]. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}
