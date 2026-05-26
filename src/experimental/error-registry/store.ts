import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { ErrorEntry } from './types.js'

/**
 * Store append-only en JSONL con índice in-memory.
 *
 * Cada línea del archivo es un `ErrorEntry` serializado. Para actualizar
 * una entry (cuando se aprueba una resolución o se incrementa successCount)
 * se appendea el snapshot completo y el load() se queda con la última
 * versión por `id`. Es ineficiente para escalas grandes pero ideal para
 * PoC: cero dependencias, atómico por línea, fácil de inspeccionar.
 *
 * Para producción hay que migrar a sqlite/pgvector.
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
          // Crear directorio si no existe (no escribir el archivo todavía).
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
          // La última versión por id gana (append-only + replay).
          byId.set(entry.id, entry)
          byFp.set(entry.fingerprint, entry)
        } catch {
          // Ignorar líneas corruptas. PoC.
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
