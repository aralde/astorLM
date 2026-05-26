import { randomUUID } from 'node:crypto'
import type {
  CreateErrorRegistryOptions,
  ErrorEntry,
  QueryInput,
  RecordResolutionInput,
  RegistryHit,
  Resolution,
} from './types.js'
import { createInMemoryStore, createFileStore, type ErrorStore } from './store.js'
import { fingerprintError, jaccard, normalizeError, tokenize } from './fingerprint.js'
import { createOpenAIEmbeddingClient, cosineSimilarity, type EmbeddingClient } from './embed.js'

export interface ErrorRegistry {
  /**
   * Consultar el registro buscando un error parecido. Si no hay match,
   * devuelve `null` (el caller debe registrar la entry vía `record()`).
   * Si hay match, devuelve el hit con la entry existente y las
   * resoluciones aprobadas (subset ranked).
   */
  query(input: QueryInput): Promise<RegistryHit | null>
  /**
   * Asegura que existe una `ErrorEntry` para este error. Si ya existe
   * (mismo fingerprint), devuelve la existente. Si no, la crea.
   * No agrega resoluciones — eso se hace en `recordResolution()`.
   */
  ensureEntry(input: QueryInput): Promise<ErrorEntry>
  /**
   * Agrega una resolución `pending` a una entry. La resolución no será
   * sugerida hasta que un humano la apruebe con `approveResolution()`.
   */
  recordResolution(input: RecordResolutionInput): Promise<Resolution>
  /**
   * Marca una resolución como aprobada. A partir de acá, futuras
   * consultas que matcheen la entry van a recibir esta resolución
   * como sugerencia.
   */
  approveResolution(resolutionId: string, approvedBy: string): Promise<void>
  /** Marca una resolución como rechazada. */
  rejectResolution(resolutionId: string, reason: string): Promise<void>
  /**
   * Registra que una resolución aprobada fue reutilizada con éxito.
   * Incrementa successCount → mejora el ranking en consultas futuras.
   */
  noteSuccessfulReuse(resolutionId: string): Promise<void>
  /** Listado plano de pendings para UI de aprobación. */
  listPending(): Array<{ entry: ErrorEntry; resolution: Resolution }>
  /** Devuelve todas las entries (debug / inspección). */
  listEntries(): ErrorEntry[]
  /** Inicializa el store (load desde disco). Debe llamarse antes de usar. */
  init(): Promise<void>
}

interface RegistryDeps {
  store: ErrorStore
  embedder: EmbeddingClient | null
  hitThreshold: number
  tags: string[]
  now: () => Date
}

function findResolutionInEntries(
  entries: ErrorEntry[],
  resolutionId: string,
): { entry: ErrorEntry; resolution: Resolution } | null {
  for (const entry of entries) {
    const res = entry.resolutions.find((r) => r.id === resolutionId)
    if (res) return { entry, resolution: res }
  }
  return null
}

function rankApproved(resolutions: Resolution[]): Resolution[] {
  return resolutions
    .filter((r) => r.approvalStatus === 'approved')
    .sort((a, b) => {
      // Ranking: successCount desc, luego attemptCount desc (más datos = más
      // confianza), luego más reciente primero (recency tie-break).
      if (b.successCount !== a.successCount) return b.successCount - a.successCount
      if (b.attemptCount !== a.attemptCount) return b.attemptCount - a.attemptCount
      return (b.approvedAt ?? '').localeCompare(a.approvedAt ?? '')
    })
}

export function createErrorRegistry(opts: CreateErrorRegistryOptions = {}): ErrorRegistry {
  const store: ErrorStore = opts.storePath
    ? createFileStore(opts.storePath)
    : createInMemoryStore()

  const embedder: EmbeddingClient | null = opts.embeddings
    ? createOpenAIEmbeddingClient(opts.embeddings)
    : null

  const defaultThreshold = embedder ? 0.82 : 0.6
  const deps: RegistryDeps = {
    store,
    embedder,
    hitThreshold: opts.hitThreshold ?? defaultThreshold,
    tags: opts.tags ?? [],
    now: opts.now ?? (() => new Date()),
  }

  // Cache de fingerprint -> embedding para evitar re-embedear queries idénticas
  // dentro de una misma corrida.
  const embeddingCache = new Map<string, number[]>()

  const embedSafe = async (text: string, fp: string): Promise<number[] | null> => {
    if (!deps.embedder) return null
    if (embeddingCache.has(fp)) return embeddingCache.get(fp)!
    try {
      const vec = await deps.embedder.embed(text)
      embeddingCache.set(fp, vec)
      return vec
    } catch {
      // Si el endpoint cae, degradamos a fuzzy silenciosamente.
      return null
    }
  }

  const scoreEntry = (
    queryVec: number[] | null,
    queryNorm: string,
    queryTokens: Set<string>,
    entry: ErrorEntry,
  ): number => {
    // Embeddings tienen prioridad si ambos lados los tienen.
    if (queryVec && entry.embedding) {
      return cosineSimilarity(queryVec, entry.embedding)
    }
    // Fallback: Jaccard sobre tokens normalizados.
    const entryTokens = tokenize(entry.normalizedError)
    return jaccard(queryTokens, entryTokens)
  }

  return {
    async init() {
      await store.load()
    },

    async query(input) {
      const normalized = normalizeError(input.rawError)
      const fp = fingerprintError(normalized, input.toolName)

      // Fast path: match exacto por fingerprint.
      const exact = store.getByFingerprint(fp)
      if (exact) {
        return {
          entry: exact,
          score: 1,
          approvedResolutions: rankApproved(exact.resolutions),
        }
      }

      // Slow path: ranking por similitud sobre todas las entries del mismo tool.
      const all = store.list().filter((e) => e.toolName === input.toolName)
      if (all.length === 0) return null

      const queryVec = await embedSafe(normalized, fp)
      const queryTokens = tokenize(normalized)

      let best: { entry: ErrorEntry; score: number } | null = null
      for (const entry of all) {
        const score = scoreEntry(queryVec, normalized, queryTokens, entry)
        if (!best || score > best.score) best = { entry, score }
      }

      if (!best || best.score < deps.hitThreshold) return null

      return {
        entry: best.entry,
        score: best.score,
        approvedResolutions: rankApproved(best.entry.resolutions),
      }
    },

    async ensureEntry(input) {
      const normalized = normalizeError(input.rawError)
      const fp = fingerprintError(normalized, input.toolName)
      const existing = store.getByFingerprint(fp)
      if (existing) return existing

      const embedding = await embedSafe(normalized, fp)
      const nowIso = deps.now().toISOString()
      const entry: ErrorEntry = {
        id: randomUUID(),
        fingerprint: fp,
        embedding,
        rawError: input.rawError.slice(0, 4096),
        normalizedError: normalized,
        toolName: input.toolName,
        context: {
          ...input.context,
          tags: [...new Set([...input.context.tags, ...deps.tags])],
        },
        resolutions: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      }
      await store.upsert(entry)
      return entry
    },

    async recordResolution(input) {
      const entry = store.getById(input.entryId)
      if (!entry) throw new Error(`ErrorEntry no encontrada: ${input.entryId}`)
      const resolution: Resolution = {
        id: randomUUID(),
        approvalStatus: 'pending',
        description: input.description,
        toolCalls: input.toolCalls,
        attemptCount: 1,
        successCount: 0,
        createdAt: deps.now().toISOString(),
      }
      entry.resolutions.push(resolution)
      entry.updatedAt = deps.now().toISOString()
      await store.upsert(entry)
      return resolution
    },

    async approveResolution(resolutionId, approvedBy) {
      const found = findResolutionInEntries(store.list(), resolutionId)
      if (!found) throw new Error(`Resolution no encontrada: ${resolutionId}`)
      found.resolution.approvalStatus = 'approved'
      found.resolution.approvedBy = approvedBy
      found.resolution.approvedAt = deps.now().toISOString()
      found.entry.updatedAt = deps.now().toISOString()
      await store.upsert(found.entry)
    },

    async rejectResolution(resolutionId, reason) {
      const found = findResolutionInEntries(store.list(), resolutionId)
      if (!found) throw new Error(`Resolution no encontrada: ${resolutionId}`)
      found.resolution.approvalStatus = 'rejected'
      found.resolution.rejectedReason = reason
      found.entry.updatedAt = deps.now().toISOString()
      await store.upsert(found.entry)
    },

    async noteSuccessfulReuse(resolutionId) {
      const found = findResolutionInEntries(store.list(), resolutionId)
      if (!found) return
      if (found.resolution.approvalStatus !== 'approved') return
      found.resolution.successCount += 1
      found.resolution.attemptCount += 1
      found.entry.updatedAt = deps.now().toISOString()
      await store.upsert(found.entry)
    },

    listPending() {
      const out: Array<{ entry: ErrorEntry; resolution: Resolution }> = []
      for (const entry of store.list()) {
        for (const r of entry.resolutions) {
          if (r.approvalStatus === 'pending') out.push({ entry, resolution: r })
        }
      }
      return out
    },

    listEntries() {
      return store.list()
    },
  }
}
