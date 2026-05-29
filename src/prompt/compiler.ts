import {
  PromptModule,
  PromptCompilerOptions,
  PromptCompilerReport,
  PromptCompilerConflict,
} from './types.js'

/**
 * Compiles a set of modular PromptModules into a single optimized system prompt string,
 * resolving priorities, deduplicating repetitive rules, and flagging potential conflicts.
 */
export function compilePrompts(opts: PromptCompilerOptions): {
  systemPrompt: string
  report: PromptCompilerReport
  print: () => string
} {
  const {
    modules,
    layout = ['identity', 'context', 'constraint', 'policy', 'format'],
    deduplicate = true,
    detectConflicts = true,
  } = opts

  const conflicts: PromptCompilerConflict[] = []
  const compiledModuleIds: string[] = []

  // 1. Resolve Priorities: Keep only the highest priority module for each unique ID.
  const moduleMap = new Map<string, PromptModule>()
  for (const mod of modules) {
    if (!mod.content || mod.content.trim() === '') {
      continue
    }
    const existing = moduleMap.get(mod.id)
    if (!existing || (mod.priority ?? 0) > (existing.priority ?? 0)) {
      moduleMap.set(mod.id, mod)
    }
  }

  const activeModules = Array.from(moduleMap.values())

  // 2. Group by Category
  const categoryMap = new Map<string, PromptModule[]>()
  for (const mod of activeModules) {
    const cat = mod.category.toLowerCase()
    if (!categoryMap.has(cat)) {
      categoryMap.set(cat, [])
    }
    categoryMap.get(cat)!.push(mod)
  }

  // 3. Sort Categories according to Layout
  const orderedCategories: string[] = []
  // First, add categories specified in the layout
  for (const cat of layout) {
    const lowerCat = cat.toLowerCase()
    if (categoryMap.has(lowerCat)) {
      orderedCategories.push(lowerCat)
    }
  }
  // Then, append any categories present in the modules but not in the layout
  for (const cat of categoryMap.keys()) {
    if (!orderedCategories.includes(cat)) {
      orderedCategories.push(cat)
    }
  }

  // 4. Compile content & Deduplicate lines if requested
  const finalBlocks: string[] = []
  const seenLinesNormalized = new Set<string>()

  for (const cat of orderedCategories) {
    const catModules = categoryMap.get(cat) || []
    const catBlocks: string[] = []

    for (const mod of catModules) {
      compiledModuleIds.push(mod.id)
      const lines = mod.content.split('\n')
      const processedLines: string[] = []

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') {
          processedLines.push('')
          continue
        }

        // Deduplication Logic
        if (deduplicate) {
          // Normalize the line: lowercase, trim, remove common bullet list markers (*, -, 1.)
          const normalized = trimmed
            .toLowerCase()
            .replace(/^[*-\d.]+\s+/, '') // remove bullet/numbering prefix
            .replace(/\s+/g, ' ')
            .trim()

          // Only deduplicate substantial rules/sentences (e.g. > 12 characters) to avoid removing headers, small list dividers, etc.
          if (normalized.length > 12) {
            if (seenLinesNormalized.has(normalized)) {
              // Flag a low-severity redundancy warning
              conflicts.push({
                type: 'redundancy',
                severity: 'low',
                description: `Redundant line omitted: "${trimmed.substring(0, 50)}${trimmed.length > 50 ? '...' : ''}"`,
                moduleIds: [mod.id],
              })
              continue
            }
            seenLinesNormalized.add(normalized)
          }
        }

        processedLines.push(line)
      }

      const modContent = processedLines.join('\n').trim()
      if (modContent) {
        catBlocks.push(modContent)
      }
    }

    if (catBlocks.length > 0) {
      // Wrap category contents nicely
      const catHeader = cat.toUpperCase()
      finalBlocks.push(`=== ${catHeader} ===\n${catBlocks.join('\n\n')}`)
    }
  }

  const systemPrompt = finalBlocks.join('\n\n').trim()

  // 5. Static Conflict Detection (Heuristics)
  if (detectConflicts) {
    // Run rule-based checks on the compiled prompt
    const lowercasePrompt = systemPrompt.toLowerCase()

    // Conflict Check 1: Concise vs Detailed/Verbose
    const hasConcise = /\b(concis[oa]|breve|cort[oa]|concise|brief|short)s?\b/.test(lowercasePrompt)
    const hasDetailed = /\b(detallad[oa]|explicativ[oa]|larg[oa]|detailed|verbose|explain|explanatory)s?\b/.test(lowercasePrompt)
    if (hasConcise && hasDetailed) {
      // Find which modules introduced these terms
      const conciseModules = activeModules.filter(m => /\b(concis[oa]|breve|cort[oa]|concise|brief|short)s?\b/i.test(m.content)).map(m => m.id)
      const detailedModules = activeModules.filter(m => /\b(detallad[oa]|explicativ[oa]|larg[oa]|detailed|verbose|explain|explanatory)s?\b/i.test(m.content)).map(m => m.id)
      
      conflicts.push({
        type: 'contradiction',
        severity: 'medium',
        description: 'Potential length/style conflict: instructions to be both concise and detailed were detected.',
        moduleIds: Array.from(new Set([...conciseModules, ...detailedModules])),
      })
    }

    // Conflict Check 2: Never Ask vs Always Ask / Ask when unsure
    const hasNeverAsk = /\b(nunca preguntes|no preguntes|never ask|don't ask|do not ask)\b/.test(lowercasePrompt)
    const hasAlwaysAsk = /\b(siempre pregunta|pregunta si|always ask|ask if|ask when|preguntar)\b/.test(lowercasePrompt)
    if (hasNeverAsk && hasAlwaysAsk) {
      const neverAskModules = activeModules.filter(m => /\b(nunca preguntes|no preguntes|never ask|don't ask|do not ask)\b/i.test(m.content)).map(m => m.id)
      const alwaysAskModules = activeModules.filter(m => /\b(siempre pregunta|pregunta si|always ask|ask if|ask when|preguntar)\b/i.test(m.content)).map(m => m.id)

      conflicts.push({
        type: 'contradiction',
        severity: 'high',
        description: 'Interaction contradiction: conflicting directives detected about whether the agent should ask the user or not.',
        moduleIds: Array.from(new Set([...neverAskModules, ...alwaysAskModules])),
      })
    }

    // Conflict Check 3: Read-only restrictions vs Write capabilities
    const hasReadOnly = /\b(solo lectura|read-only|read only|no escribas|do not write|never modify)\b/.test(lowercasePrompt)
    const hasWrite = /\b(escribir|modificar|modifica|write|edit|modify|update)\b/.test(lowercasePrompt)
    if (hasReadOnly && hasWrite) {
      // Only flag if read-only module has higher authority or distinct category conflict
      const readOnlyModules = activeModules.filter(m => /\b(solo lectura|read-only|read only|no escribas|do not write|never modify)\b/i.test(m.content)).map(m => m.id)
      const writeModules = activeModules.filter(m => /\b(escribir|modificar|modifica|write|edit|modify|update)\b/i.test(m.content)).map(m => m.id)

      conflicts.push({
        type: 'contradiction',
        severity: 'high',
        description: 'Permission/capability conflict: "read-only" directives coexist with write commands.',
        moduleIds: Array.from(new Set([...readOnlyModules, ...writeModules])),
      })
    }
  }

  // 6. Token Estimate (rough estimate: characters / 4)
  const tokenEstimate = Math.ceil(systemPrompt.length / 4)

  const report: PromptCompilerReport = {
    conflicts,
    modulesCompiled: compiledModuleIds,
    tokenEstimate,
  }

  return {
    systemPrompt,
    report,
    print() {
      return formatPromptReport(report, systemPrompt)
    },
  }
}

/**
 * Formats a PromptCompilerReport (and optionally the system prompt text)
 * into a structured, readable string for console printing.
 */
export function formatPromptReport(report: PromptCompilerReport, systemPrompt?: string): string {
  const sep = '─'.repeat(60)
  const parts: string[] = [
    `┌${sep}┐`,
    `│ 📋 REPORT: PROMPT COMPILER REPORT                           │`,
    `├${sep}┤`,
    `│ Modules compiled: ${report.modulesCompiled.join(', ').substring(0, 40).padEnd(41)} │`,
    `│ Token estimate:   ${String(report.tokenEstimate ?? 0).padEnd(41)} │`,
  ]

  if (report.conflicts.length > 0) {
    parts.push(`├${sep}┤`)
    parts.push('│ ⚠️  Detected conflicts / redundancies:                       │')
    for (const c of report.conflicts) {
      const line = `[${c.severity.toUpperCase()}] [${c.type.toUpperCase()}] ${c.description}`
      // Wrap lines beautifully in the box
      const chunks = line.match(/.{1,54}/g) || [line]
      for (let i = 0; i < chunks.length; i++) {
        const prefix = i === 0 ? '  - ' : '    '
        parts.push(`│ ${prefix}${chunks[i]!.trim().padEnd(54)} │`)
      }
    }
  } else {
    parts.push(`├${sep}┤`)
    parts.push('│ ✅ No conflicts or redundancies found.                       │')
  }

  parts.push(`└${sep}┘`)

  if (systemPrompt) {
    parts.push('\n=== COMPILED SYSTEM PROMPT ===')
    parts.push(systemPrompt)
    parts.push('==============================')
  }

  return parts.join('\n')
}
