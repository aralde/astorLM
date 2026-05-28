import path from 'node:path'
import type { SessionHooks, TokenUsage, Tool, AgentEvent } from '../../types.js'

// ---------- Agent Contract Types ----------

export interface AgentContractBudget {
  maxTurns?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxTotalTokens?: number
  maxDurationMs?: number
}

export interface AgentContractTools {
  allow?: string[]
  deny?: string[]
}

export interface AgentContractSandbox {
  allowedPaths?: string[]
  deniedPaths?: string[]
  bash?: {
    allowedCommands?: string[]
    deniedCommands?: string[]
    allowInteractive?: boolean
  }
}

export interface AgentContract {
  budget?: AgentContractBudget
  tools?: AgentContractTools
  sandbox?: AgentContractSandbox
}

export class ContractViolationError extends Error {
  constructor(public rule: string, message: string) {
    super(message)
    this.name = 'ContractViolationError'
  }
}

// ---------- Helper Functions ----------

/**
 * Convierte un patrón glob simple a RegExp. Soporta `*`, `**`, `?`.
 */
export function globToRegex(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i++
        if (pattern[i + 1] === '/') i++
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if (c && '.+^$(){}[]|\\'.includes(c)) {
      out += `\\${c}`
    } else {
      out += c
    }
  }
  out += '$'
  return new RegExp(out)
}

function pathMatchesPattern(cwd: string, targetPath: string, pattern: string): boolean {
  const isAbsolutePattern = path.isAbsolute(pattern)
  const resolvedPattern = isAbsolutePattern ? path.resolve(pattern) : path.resolve(cwd, pattern)
  const resolvedTarget = path.resolve(cwd, targetPath)

  const patternNorm = resolvedPattern.split(path.sep).join('/')
  const targetNorm = resolvedTarget.split(path.sep).join('/')

  const re = globToRegex(patternNorm)
  return re.test(targetNorm)
}

function getPathProperties(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return []
  const paths: string[] = []
  const candidates = ['path', 'filePath', 'file', 'target']
  for (const key of candidates) {
    if (key in input) {
      const val = (input as any)[key]
      if (typeof val === 'string') {
        paths.push(val)
      }
    }
  }
  return paths
}

// ---------- Validator Class ----------

export class ContractValidator {
  private startedAt = Date.now()

  constructor(
    private contract: AgentContract | undefined,
    private cwd: string
  ) {}

  validateBudget(sessionUsage: TokenUsage, currentTurns: number): void {
    if (!this.contract?.budget) return

    const budget = this.contract.budget

    if (budget.maxTurns !== undefined && currentTurns > budget.maxTurns) {
      throw new ContractViolationError(
        'budget.maxTurns',
        `Max turns exceeded: ${currentTurns} (limit: ${budget.maxTurns})`
      )
    }

    if (budget.maxInputTokens !== undefined && sessionUsage.inputTokens > budget.maxInputTokens) {
      throw new ContractViolationError(
        'budget.maxInputTokens',
        `Max input tokens exceeded: ${sessionUsage.inputTokens} (limit: ${budget.maxInputTokens})`
      )
    }

    if (budget.maxOutputTokens !== undefined && sessionUsage.outputTokens > budget.maxOutputTokens) {
      throw new ContractViolationError(
        'budget.maxOutputTokens',
        `Max output tokens exceeded: ${sessionUsage.outputTokens} (limit: ${budget.maxOutputTokens})`
      )
    }

    const totalTokens = sessionUsage.inputTokens + sessionUsage.outputTokens
    if (budget.maxTotalTokens !== undefined && totalTokens > budget.maxTotalTokens) {
      throw new ContractViolationError(
        'budget.maxTotalTokens',
        `Max total tokens exceeded: ${totalTokens} (limit: ${budget.maxTotalTokens})`
      )
    }

    if (budget.maxDurationMs !== undefined) {
      const elapsed = Date.now() - this.startedAt
      if (elapsed > budget.maxDurationMs) {
        throw new ContractViolationError(
          'budget.maxDurationMs',
          `Max duration exceeded: ${elapsed}ms (limit: ${budget.maxDurationMs}ms)`
        )
      }
    }
  }

  filterToolSchemas<T extends { name: string }>(tools: T[]): T[] {
    if (!this.contract?.tools) return tools
    const { allow, deny } = this.contract.tools

    return tools.filter((t) => {
      if (allow && !allow.includes(t.name)) return false
      if (deny && deny.includes(t.name)) return false
      return true
    })
  }

  validateToolCall(toolName: string, input: unknown): { allowed: boolean; reason?: string } {
    if (this.contract?.tools) {
      const { allow, deny } = this.contract.tools
      if (allow && !allow.includes(toolName)) {
        return { allowed: false, reason: `Tool "${toolName}" is not allowed by the contract.` }
      }
      if (deny && deny.includes(toolName)) {
        return { allowed: false, reason: `Tool "${toolName}" is explicitly denied by the contract.` }
      }
    }

    if (this.contract?.sandbox?.allowedPaths || this.contract?.sandbox?.deniedPaths) {
      const paths = getPathProperties(input)
      for (const p of paths) {
        let resolved: string
        try {
          resolved = path.resolve(this.cwd, p)
        } catch {
          return { allowed: false, reason: `Invalid path format: ${p}` }
        }

        if (this.contract.sandbox.allowedPaths) {
          let matches = false
          for (const pattern of this.contract.sandbox.allowedPaths) {
            if (pathMatchesPattern(this.cwd, p, pattern)) {
              matches = true
              break
            }
          }
          if (!matches) {
            return { allowed: false, reason: `Path "${p}" is not allowed by contract.` }
          }
        }

        if (this.contract.sandbox.deniedPaths) {
          for (const pattern of this.contract.sandbox.deniedPaths) {
            if (pathMatchesPattern(this.cwd, p, pattern)) {
              return { allowed: false, reason: `Path "${p}" is explicitly denied by contract.` }
            }
          }
        }
      }
    }

    if (this.contract?.sandbox?.bash) {
      const isBashTool = ['bash', 'bash_spawn', 'bash_get_output'].includes(toolName)
      if (isBashTool && typeof input === 'object' && input !== null) {
        const cmd = (input as any).command || (input as any).cmd
        if (typeof cmd === 'string') {
          const bashRules = this.contract.sandbox.bash

          if (bashRules.allowedCommands) {
            let matches = false
            for (const allowed of bashRules.allowedCommands) {
              if (cmd.trim() === allowed.trim() || cmd.trim().startsWith(allowed.trim() + ' ')) {
                matches = true
                break
              }
            }
            if (!matches) {
              return { allowed: false, reason: `Command "${cmd}" is not allowed by contract.` }
            }
          }

          if (bashRules.deniedCommands) {
            for (const denied of bashRules.deniedCommands) {
              let matches = false
              if (denied.startsWith('/') && denied.endsWith('/')) {
                const re = new RegExp(denied.slice(1, -1))
                matches = re.test(cmd)
              } else if (denied.includes('*') || denied.includes('?') || denied.includes('^')) {
                const re = globToRegex(denied)
                matches = re.test(cmd)
              } else {
                matches = cmd.includes(denied)
              }
              if (matches) {
                return {
                  allowed: false,
                  reason: `Command "${cmd}" is explicitly denied by contract rule: "${denied}".`
                }
              }
            }
          }
        }
      }
    }

    return { allowed: true }
  }
}

// ---------- Hook Creator Function ----------

export function createContractHooks(contract: AgentContract): SessionHooks {
  let validatorInstance: ContractValidator | null = null

  return {
    beforeTurn: async (context) => {
      if (!validatorInstance) {
        validatorInstance = new ContractValidator(contract, context.cwd)
      }
      try {
        validatorInstance.validateBudget(context.sessionUsage, context.accumulatedTurns)
      } catch (err) {
        if (err instanceof ContractViolationError) {
          context.bus?.emit({
            type: 'contract_violation',
            rule: err.rule,
            details: err.message
          })
        }
        throw err
      }
    },

    beforeProviderCall: async (context) => {
      if (!validatorInstance) {
        validatorInstance = new ContractValidator(contract, context.cwd)
      }
      const filtered = validatorInstance.filterToolSchemas(context.tools)
      return {
        messages: context.messages,
        systemPrompt: context.systemPrompt,
        tools: filtered
      }
    },

    beforeToolExecution: async (context) => {
      if (!validatorInstance) {
        validatorInstance = new ContractValidator(contract, context.cwd)
      }
      const check = validatorInstance.validateToolCall(context.toolName, context.input)
      if (!check.allowed) {
        const reason = check.reason || 'Blocked by Agent Contract.'
        context.bus?.emit({
          type: 'contract_violation',
          rule: `tools.${context.toolName}`,
          details: reason
        })
        throw new ContractViolationError(`tools.${context.toolName}`, reason)
      }
      return { authorize: true }
    }
  }
}
