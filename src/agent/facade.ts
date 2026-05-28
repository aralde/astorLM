import { createAgent } from './session.js'
import { SessionManager } from './sessionManager.js'
import { createCodingTools } from '../tools/index.js'
import type { Provider, Tool, AgentEvent } from '../types.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export type AstorOutputMode = 'silent' | 'console' | 'verbose' | ((event: AgentEvent) => void)

function setupOutputMode(session: any, mode: AstorOutputMode) {
  if (mode === 'silent') return

  if (typeof mode === 'function') {
    session.on('event', mode)
    return
  }

  session.on('event', (e: AgentEvent) => {
    if (e.type === 'text_delta') {
      process.stdout.write(e.text)
    }

    if (mode === 'verbose') {
      if (e.type === 'tool_execution_start') {
        console.log(`\n[TOOL START] 🛠️  ${e.name} -> Input: ${JSON.stringify(e.input).slice(0, 200)}`)
      } else if (e.type === 'tool_execution_end') {
        const errorMsg = e.isError ? ' ❌ ERROR' : ''
        console.log(`\n[TOOL END] ✅  ${e.name} (${e.durationMs.toFixed(0)}ms)${errorMsg}`)
      } else if (e.type === 'session_end') {
        console.log(`\n[SESSION END] 🏁  Reason: ${e.reason}`)
      }
    }
  })
}

export interface AstorAgentOptions {
  provider: Provider
  sessionManager?: SessionManager
  tools?: Tool[]
  cwd?: string
  defaultOutputMode?: AstorOutputMode
  sessionId?: string
}

export class AstorAgent {
  private provider: Provider
  private sessionManager: SessionManager
  private tools: Tool[]
  private cwd: string
  private defaultOutputMode: AstorOutputMode
  private sessionId?: string

  constructor(opts: AstorAgentOptions) {
    if (!opts.provider) {
      throw new Error('AstorAgent requires a provider option.')
    }
    this.provider = opts.provider
    this.sessionManager = opts.sessionManager ?? SessionManager.inMemory()
    this.tools = opts.tools ?? createCodingTools()
    this.cwd = opts.cwd ?? process.cwd()
    this.defaultOutputMode = opts.defaultOutputMode ?? 'console'
    this.sessionId = opts.sessionId
  }

  /**
   * Ejecuta una tarea en una sesión nueva o existente.
   * Auto-inicializa la sesión, configura la salida/logs y ejecuta el prompt.
   */
  async run(
    input: string,
    opts?: { sessionId?: string; outputMode?: AstorOutputMode }
  ): Promise<{ sessionId: string; text: string }> {
    const session = await createAgent({
      provider: this.provider,
      sessionManager: this.sessionManager,
      sessionId: opts?.sessionId ?? this.sessionId,
      tools: this.tools,
      cwd: this.cwd,
      fileReader: async (relPath: string) => {
        const abs = path.join(this.cwd, relPath)
        return readFile(abs, 'utf8')
      }
    })

    setupOutputMode(session, opts?.outputMode ?? this.defaultOutputMode)

    const result = await session.run(input)
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as any).text)
      .join('\n')

    return {
      sessionId: session.id,
      text,
    }
  }

  /**
   * Crea una sesión hija branchada.
   */
  async fork(opts: {
    parentId: string
    branchFromMessageId?: string
    newSessionId?: string
  }): Promise<AstorAgent> {
    const childState = await this.sessionManager.create({
      id: opts.newSessionId,
      parentId: opts.parentId,
      branchFromMessageId: opts.branchFromMessageId,
    })

    return new AstorAgent({
      provider: this.provider,
      sessionManager: this.sessionManager,
      tools: this.tools,
      cwd: this.cwd,
      defaultOutputMode: this.defaultOutputMode,
      sessionId: childState.id,
    })
  }
}
