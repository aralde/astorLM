export interface PromptModule {
  /** Unique identifier for the module. */
  id: string
  /** Human-readable name of the module. */
  name?: string
  /** The prompt text content. */
  content: string
  /** The category this module belongs to (e.g. 'identity', 'policy', 'constraint', 'format', 'context'). */
  category: 'identity' | 'policy' | 'constraint' | 'format' | 'context' | string
  /** Priority score. Higher priority overrides lower priority on exact duplicate items or modules. Defaults to 0. */
  priority?: number
}

export interface PromptCompilerOptions {
  /** The collection of prompt modules to compile. */
  modules: PromptModule[]
  /**
   * The order in which categories should be arranged in the final system prompt.
   * Helps structure the prompt strategically (e.g., identity at top, critical safety policies at bottom).
   * Defaults to ['identity', 'context', 'constraint', 'policy', 'format'].
   */
  layout?: string[]
  /** Remove identical duplicate sentences across modules. Defaults to true. */
  deduplicate?: boolean
  /** Perform static analysis to detect potential contradictions or high redundancies. Defaults to true. */
  detectConflicts?: boolean
}

export interface PromptCompilerConflict {
  /** The type of conflict detected. */
  type: 'contradiction' | 'redundancy'
  /** Severity level of the conflict. */
  severity: 'high' | 'medium' | 'low'
  /** Description of the issue found. */
  description: string
  /** IDs of the modules involved in this conflict. */
  moduleIds: string[]
}

export interface PromptCompilerReport {
  /** List of detected conflicts or warnings. */
  conflicts: PromptCompilerConflict[]
  /** List of IDs of the modules successfully compiled. */
  modulesCompiled: string[]
  /** Approximate number of tokens in the compiled system prompt. */
  tokenEstimate?: number
}
