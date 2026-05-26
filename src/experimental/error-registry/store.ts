import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { ErrorEntry } from './types.js'

/**
 * Append-only JSONL store with an in-memory index.
 *
 * Every line in the file is a serialized `ErrorEntry`. To update an
 * entry (when a resolution is approved or successCount changes) the
 * full snapshot is appended and `load()` keeps the latest version per
 * `id`. Inefficient at large scale, but ideal for a PoC: zero deps,
 * per-line atomicity, easy to inspect.
 *
 * For production, migrate to sqlite/pgvector.
 */
export interface ErrorStore {
  load(): Promise<void>
  list(): ErrorEntry[]
  getById(id: string): ErrorEntry | null
  getByFingerprint(fp: string): ErrorEntry | null
  upsert(entry: ErrorEntry): Promise<void>
}

export function createInMemoryStore(): ErrorStore {
  const byId = new Map<string, ErrorEntry>()
  const byFp = new Map<string, ErrorEntry>()
  return {
    async load() {
      /* noop */
    },
    list: () => [...byId.values()],
    getById: (id) => byId.get(id) ?? null,
    getByFingerprint: (fp) => byFp.get(fp) ?? null,
    async upsert(entry) {
      byId.set(entry.id, entry)
      byFp.set(entry.fingerprint, entry)
    },
  }
}

export function createFileStore(storePath: string): ErrorStore {
  const byId = new Map<string, ErrorEntry>()
  const byFp = new Map<string, ErrorEntry>()

  return {
    async load() {
      let content: string
      try {
        content = await fs.readFile(storePath, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // Ensure directory exists (do not write the file yet).
          await fs.mkdir(dirname(storePath), { recursive: true }).catch(() => {})
          return
        }
        throw err
      }
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const entry = JSON.parse(trimmed) as ErrorEntry
          // Last version per id wins (append-only + replay).
          byId.set(entry.id, entry)
          byFp.set(entry.fingerprint, entry)
        } catch {
          // Ignore corrupted lines. PoC.
        }
      }
    },
    list: () => [...byId.values()],
    getById: (id) => byId.get(id) ?? null,
    getByFingerprint: (fp) => byFp.get(fp) ?? null,
    async upsert(entry) {
      byId.set(entry.id, entry)
      byFp.set(entry.fingerprint, entry)
      await fs.mkdir(dirname(storePath), { recursive: true }).catch(() => {})
      await fs.appendFile(storePath, JSON.stringify(entry) + '\n', 'utf8')
    },
  }
}
