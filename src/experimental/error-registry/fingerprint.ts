import { createHash } from 'node:crypto'

/**
 * Normaliza un mensaje de error eliminando información volátil que
 * impediría matchear dos ocurrencias del "mismo" error en contextos
 * distintos. El objetivo no es perfección — es bajar la varianza lo
 * suficiente como para que el embedder (o el matcher fuzzy) vea texto
 * comparable.
 *
 * Patrones tratados, en orden:
 *  - Rutas absolutas (Windows + POSIX) → <PATH>
 *  - UUIDs canónicos → <UUID>
 *  - IPv4 e IPv6 → <IP>
 *  - Timestamps ISO 8601 → <TS>
 *  - Epoch (10-13 dígitos) → <TS>
 *  - AWS account IDs (12 dígitos) y ARNs → <ACCOUNT> / <ARN>
 *  - Direcciones de memoria 0x...  → <ADDR>
 *  - En stack frames "file.ts:123:45" → "file.ts" (sin línea/col)
 *  - Lowercase + collapse de whitespace.
 */
export function normalizeError(raw: string): string {
  let s = raw
  // UUIDs PRIMERO — contienen sub-substrings de 12 dígitos hex que
  // pueden engañar al matcher de account-id si vamos al revés.
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>')
  // ARNs (más específicos que account ids sueltos)
  s = s.replace(/arn:[a-z0-9-]+:[a-z0-9-]*:[a-z0-9-]*:\d{12}:[^\s"']+/gi, '<ARN>')
  // AWS account IDs (12 dígitos aislados)
  s = s.replace(/\b\d{12}\b/g, '<ACCOUNT>')
  // ISO timestamps
  s = s.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<TS>')
  // Epoch (10 o 13 dígitos)
  s = s.replace(/\b\d{13}\b/g, '<TS>')
  s = s.replace(/\b\d{10}\b/g, '<TS>')
  // IPv4
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<IP>')
  // IPv6 (heurística simple — al menos dos ":" y caracteres hex)
  s = s.replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, '<IP>')
  // Memory addresses
  s = s.replace(/\b0x[0-9a-f]+\b/gi, '<ADDR>')
  // Rutas Windows: C:\foo\bar o C:/foo/bar
  s = s.replace(/[a-zA-Z]:[\\/](?:[^\s"']+[\\/])*[^\s"':]+/g, (m) => {
    // Conservar el basename pero sin ruta
    const base = m.split(/[\\/]/).pop() ?? ''
    return base ? `<PATH>/${base}` : '<PATH>'
  })
  // Rutas POSIX absolutas: /foo/bar/baz
  s = s.replace(/(?:^|\s)\/(?:[^\s"'/:]+\/)+[^\s"':]+/g, (m) => {
    const leading = m.startsWith(' ') ? ' ' : ''
    const base = m.trim().split('/').pop() ?? ''
    return base ? `${leading}<PATH>/${base}` : `${leading}<PATH>`
  })
  // En stack frames remover ":line:col"
  s = s.replace(/(\.[a-z0-9]{1,5}):\d+(?::\d+)?/gi, '$1')
  // Lowercase + collapse de whitespace
  s = s.toLowerCase().replace(/\s+/g, ' ').trim()
  return s
}

/**
 * Fingerprint determinístico = sha256(normalizedError + '|' + toolName).slice(0,16).
 * Sirve para dedupe O(1) sin necesidad de embeddings.
 */
export function fingerprintError(normalizedError: string, toolName: string): string {
  return createHash('sha256').update(`${normalizedError}|${toolName}`).digest('hex').slice(0, 16)
}

/**
 * Tokenización liviana para el matcher fuzzy (fallback sin embeddings).
 * Quita stopwords obvias y splittea por non-word.
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

/** Jaccard sobre sets de tokens. Devuelve [0..1]. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}
