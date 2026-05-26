/**
 * Tipos públicos del módulo experimental `error-registry`.
 *
 * ⚠️ API experimental — sujeta a cambios sin warning. Vivís en
 * `experimental.*` para que sepas que esto no es estable.
 *
 * La idea: que múltiples sesiones del agente compartan un registro
 * federado de errores y resoluciones aprobadas por humanos. Cuando
 * el agente choca con un error que alguien ya resolvió, recibe el
 * hint y aplica la solución directamente.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface ErrorContext {
  /** cwd absoluto donde ocurrió el error. Anonimizable por el caller. */
  cwd: string
  /** 'win32' | 'linux' | 'darwin' */
  osPlatform: string
  /** ej. 'v20.18.0' */
  nodeVersion: string
  /** etiquetas arbitrarias del proyecto: ['terraform', 'aws', 'eu-west-3'] */
  tags: string[]
}

export interface ToolCallSummary {
  name: string
  input: unknown
}

export interface Resolution {
  id: string
  approvalStatus: ApprovalStatus
  /** Texto del agente explicando qué hizo (último assistant_message). */
  description: string
  /** Pasos concretos: las tools que el agente invocó entre el error y la resolución. */
  toolCalls: ToolCallSummary[]
  /** Cuántas veces se intentó esta resolución (aprobada o no). */
  attemptCount: number
  /** Cuántas veces, una vez aprobada, fue reutilizada con éxito. */
  successCount: number
  approvedBy?: string
  approvedAt?: string
  rejectedReason?: string
  createdAt: string
}

export interface ErrorEntry {
  id: string
  /** Hash determinístico de `normalizedError + toolName`. Permite dedupe O(1). */
  fingerprint: string
  /** Vector de embedding del normalizedError. `null` si no hay embedder. */
  embedding: number[] | null
  /** Texto original truncado a 4 KB. */
  rawError: string
  /** Texto sin paths/UUIDs/IPs/timestamps/etc. Sobre esto se calcula el embedding. */
  normalizedError: string
  toolName: string
  context: ErrorContext
  resolutions: Resolution[]
  createdAt: string
  updatedAt: string
}

export interface RegistryHit {
  entry: ErrorEntry
  /** Similitud coseno [0..1] si hubo embedding; ratio de Jaccard [0..1] en fallback. */
  score: number
  /** Subset de `entry.resolutions` que tienen approvalStatus === 'approved', ordenadas por éxito. */
  approvedResolutions: Resolution[]
}

export interface CreateErrorRegistryOptions {
  /**
   * Path absoluto al JSONL persistente. Si no se pasa, el registry vive
   * sólo en memoria (útil para tests).
   */
  storePath?: string
  /**
   * Configuración del embedder OpenAI-compat. Si no se pasa, el registry
   * cae a matching fuzzy (Jaccard sobre tokens) — menos potente pero
   * funcional para PoC.
   */
  embeddings?: {
    baseURL: string
    model: string
    apiKey?: string
  }
  /**
   * Score mínimo para considerar un hit relevante. Default 0.82 para
   * embeddings (coseno) y 0.6 para fallback fuzzy.
   */
  hitThreshold?: number
  /**
   * Etiquetas que se anexan automáticamente a cada `ErrorEntry` registrado
   * desde sesiones de esta instancia. Por proyecto: ['devops', 'terraform'].
   */
  tags?: string[]
  /**
   * Override del clock para tests determinísticos.
   */
  now?: () => Date
}

export interface QueryInput {
  rawError: string
  toolName: string
  context: ErrorContext
}

export interface RecordResolutionInput {
  /** entry al que se ata la resolución (devuelto por query() o por record()). */
  entryId: string
  description: string
  toolCalls: ToolCallSummary[]
}
