/**
 * Public types of the experimental `error-registry` module.
 *
 * ⚠️ Experimental API — subject to change without warning. Lives under
 * `astorlm/experimental/error-registry` so the import path itself
 * signals that this is not stable.
 *
 * Idea: let multiple agent sessions share a federated registry of
 * errors and human-approved resolutions. When an agent hits an error
 * someone else has already solved, it receives the fix as a hint and
 * applies it directly instead of fighting through it again.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface ErrorContext {
  /** Absolute cwd where the error occurred. The caller may anonymize it. */
  cwd: string
  /** 'win32' | 'linux' | 'darwin' */
  osPlatform: string
  /** e.g. 'v20.18.0' */
  nodeVersion: string
  /** Free-form project tags: ['terraform', 'aws', 'eu-west-3'] */
  tags: string[]
}

export interface ToolCallSummary {
  name: string
  input: unknown
}

export interface Resolution {
  id: string
  approvalStatus: ApprovalStatus
  /** Agent's explanation of what it did (last assistant_message text). */
  description: string
  /** Concrete steps: tool calls the agent issued between the error and the fix. */
  toolCalls: ToolCallSummary[]
  /** How many times this resolution was attempted (approved or not). */
  attemptCount: number
  /** How many times, once approved, it was reused successfully. */
  successCount: number
  approvedBy?: string
  approvedAt?: string
  rejectedReason?: string
  createdAt: string
}

export interface ErrorEntry {
  id: string
  /** Deterministic hash of `normalizedError + toolName`. Enables O(1) dedupe. */
  fingerprint: string
  /** Embedding vector of the normalizedError. `null` when no embedder is configured. */
  embedding: number[] | null
  /** Original text truncated to 4 KB. */
  rawError: string
  /** Text with paths/UUIDs/IPs/timestamps/etc. stripped. The embedding is computed over this. */
  normalizedError: string
  toolName: string
  context: ErrorContext
  resolutions: Resolution[]
  createdAt: string
  updatedAt: string
}

export interface RegistryHit {
  entry: ErrorEntry
  /** Cosine similarity [0..1] if embeddings were used; Jaccard ratio [0..1] in fallback mode. */
  score: number
  /** Subset of `entry.resolutions` with approvalStatus === 'approved', ranked by empirical success. */
  approvedResolutions: Resolution[]
}

export interface CreateErrorRegistryOptions {
  /**
   * Absolute path of the persistent JSONL store. If omitted, the
   * registry lives only in memory (useful for tests).
   */
  storePath?: string
  /**
   * OpenAI-compatible embedder configuration. If omitted, the registry
   * falls back to fuzzy matching (Jaccard over tokens) — less powerful
   * but good enough for a PoC.
   */
  embeddings?: {
    baseURL: string
    model: string
    apiKey?: string
  }
  /**
   * Minimum score to count as a relevant hit. Defaults to 0.82 for
   * embeddings (cosine) and 0.6 for the fuzzy fallback.
   */
  hitThreshold?: number
  /**
   * Tags automatically appended to every `ErrorEntry` recorded by
   * sessions backed by this instance. Per project: ['devops', 'terraform'].
   */
  tags?: string[]
  /**
   * Clock override for deterministic tests.
   */
  now?: () => Date
}

export interface QueryInput {
  rawError: string
  toolName: string
  context: ErrorContext
}

export interface RecordResolutionInput {
  /** Entry the resolution is attached to (returned by query() or ensureEntry()). */
  entryId: string
  description: string
  toolCalls: ToolCallSummary[]
}
