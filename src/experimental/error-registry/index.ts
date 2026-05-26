/**
 * Módulo experimental `error-registry`.
 *
 * ⚠️ API volátil. La firma de cualquiera de estas funciones puede cambiar
 * entre releases menores. Estable: las primitivas conceptuales (query /
 * ensureEntry / recordResolution / approve / hooks).
 *
 * Diseño: ver propuesta en .docs (PoC de federated error registry).
 */
export { createErrorRegistry } from './registry.js'
export type { ErrorRegistry } from './registry.js'
export { errorRegistryHooks } from './attach.js'
export type { AttachErrorRegistryOptions } from './attach.js'
export { normalizeError, fingerprintError, tokenize, jaccard } from './fingerprint.js'
export { cosineSimilarity } from './embed.js'
export type {
  ApprovalStatus,
  ErrorContext,
  ErrorEntry,
  CreateErrorRegistryOptions,
  QueryInput,
  RecordResolutionInput,
  RegistryHit,
  Resolution,
  ToolCallSummary,
} from './types.js'
