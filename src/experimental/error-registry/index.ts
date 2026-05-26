/**
 * Experimental `error-registry` module.
 *
 * ⚠️ Volatile API. The signature of any of these functions may change
 * between minor releases. What is stable: the conceptual primitives
 * (query / ensureEntry / recordResolution / approve / hooks).
 *
 * Design notes: see the federated-error-registry PoC proposal under
 * .docs/.
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
