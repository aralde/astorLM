import { createAgentSession } from './session.js'
import { SessionManager } from './sessionManager.js'
import { createCodingTools } from '../tools/index.js'
import type { Provider, Tool, AgentEvent } from '../types.js'

export type AstorOutputMode = 'silent' | 'console' | 'verbose' | ((event: AgentEvent) => void)

function setupOutputMode(session: any, mode: AstorOutputMode) {
  if (mode === 'silent') return

  if (typeof mode === 'function') {
    session.subscribe(mode)
    return
  }

  session.subscribe((e: AgentEvent) => {
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
}

export class AstorAgent {
  private provider: Provider
  private sessionManager: SessionManager
  private tools: Tool[]
  private cwd: string
  private defaultOutputMode: AstorOutputMode

  constructor(opts: AstorAgentOptions) {
    this.provider = opts.provider
    this.sessionManager = opts.sessionManager ?? SessionManager.inMemory()
    this.tools = opts.tools ?? createCodingTools()
    this.cwd = opts.cwd ?? process.cwd()
    this.defaultOutputMode = opts.defaultOutputMode ?? 'console'
  }

  /**
   * Ejecuta una tarea en una sesión nueva o existente.
   * Auto-inicializa la sesión, configura la salida/logs y ejecuta el prompt.
   */
  async runTask(
    promptText: string,
    opts?: { sessionId?: string; outputMode?: AstorOutputMode }
  ): Promise<{ sessionId: string; text: string }> {
    const session = createAgentSession({
      provider: this.provider,
      sessionManager: this.sessionManager,
      sessionId: opts?.sessionId,
      tools: this.tools,
      cwd: this.cwd,
    })

    await session.initPromise
    setupOutputMode(session, opts?.outputMode ?? this.defaultOutputMode)

    const result = await session.prompt(promptText)
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
   * Crea una sesión hija branchada y ejecuta una instrucción sobre ella inmediatamente.
   */
  async runBranchTask(opts: {
    parentId: string
    branchFromMessageId?: string
    newSessionId?: string
    promptText: string
    outputMode?: AstorOutputMode
  }): Promise<{ sessionId: string; text: string }> {
    const childState = await this.sessionManager.create({
      id: opts.newSessionId,
      parentId: opts.parentId,
      branchFromMessageId: opts.branchFromMessageId,
    })

    return this.runTask(opts.promptText, {
      sessionId: childState.id,
      outputMode: opts.outputMode,
    })
  }
}
