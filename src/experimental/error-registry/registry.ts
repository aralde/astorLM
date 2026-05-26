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
   * Look up the registry for a similar error. Returns `null` when there
   * is no match (the caller is expected to register a new entry via
   * `ensureEntry()`). On match, returns the hit with the existing entry
   * and the ranked subset of approved resolutions.
   */
  query(input: QueryInput): Promise<RegistryHit | null>
  /**
   * Ensures an `ErrorEntry` exists for this error. If one already exists
   * (same fingerprint) it is returned; otherwise a new one is created.
   * Does not add resolutions — that is done via `recordResolution()`.
   */
  ensureEntry(input: QueryInput): Promise<ErrorEntry>
  /**
   * Attaches a `pending` resolution to an entry. The resolution will
   * not be suggested until a human approves it via `approveResolution()`.
   */
  recordResolution(input: RecordResolutionInput): Promise<Resolution>
  /**
   * Marks a resolution as approved. From this point on, future queries
   * matching the entry will receive this resolution as a hint.
   */
  approveResolution(resolutionId: string, approvedBy: string): Promise<void>
  /** Marks a resolution as rejected. */
  rejectResolution(resolutionId: string, reason: string): Promise<void>
  /**
   * Records that an approved resolution was reused successfully.
   * Increments successCount → improves ranking in future queries.
   */
  noteSuccessfulReuse(resolutionId: string): Promise<void>
  /** Flat list of pending resolutions for the approval UI. */
  listPending(): Array<{ entry: ErrorEntry; resolution: Resolution }>
  /** Returns all entries (debug / inspection). */
  listEntries(): ErrorEntry[]
  /** Initializes the store (load from disk). Must be called before use. */
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
      // Ranking: successCount desc, then attemptCount desc (more data =
      // more confidence), then most recent first (recency tie-break).
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

  // Cache fingerprint -> embedding so we do not re-embed identical
  // queries within a single run.
  const embeddingCache = new Map<string, number[]>()

  const embedSafe = async (text: string, fp: string): Promise<number[] | null> => {
    if (!deps.embedder) return null
    if (embeddingCache.has(fp)) return embeddingCache.get(fp)!
    try {
      const vec = await deps.embedder.embed(text)
      embeddingCache.set(fp, vec)
      return vec
    } catch {
      // If the endpoint is down, silently degrade to fuzzy matching.
      return null
    }
  }

  const scoreEntry = (
    queryVec: number[] | null,
    queryNorm: string,
    queryTokens: Set<string>,
    entry: ErrorEntry,
  ): number => {
    // Embeddings take priority when both sides have them.
    if (queryVec && entry.embedding) {
      return cosineSimilarity(queryVec, entry.embedding)
    }
    // Fallback: Jaccard over normalized tokens.
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

      // Fast path: exact fingerprint match.
      const exact = store.getByFingerprint(fp)
      if (exact) {
        return {
          entry: exact,
          score: 1,
          approvedResolutions: rankApproved(exact.resolutions),
        }
      }

      // Slow path: rank by similarity over every entry of the same tool.
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
      if (!entry) throw new Error(`ErrorEntry not found: ${input.entryId}`)
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
      if (!found) throw new Error(`Resolution not found: ${resolutionId}`)
      found.resolution.approvalStatus = 'approved'
      found.resolution.approvedBy = approvedBy
      found.resolution.approvedAt = deps.now().toISOString()
      found.entry.updatedAt = deps.now().toISOString()
      await store.upsert(found.entry)
    },

    async rejectResolution(resolutionId, reason) {
      const found = findResolutionInEntries(store.list(), resolutionId)
      if (!found) throw new Error(`Resolution not found: ${resolutionId}`)
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
