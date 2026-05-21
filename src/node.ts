import { createAgentSession } from './agent/session.js'
import type { CreateAgentSessionOptions, AgentSession } from './agent/session.js'
import { SessionManager } from './agent/sessionManager.js'
import type { SessionState } from './agent/sessionManager.js'
import type { Message } from './types.js'
import fs from 'node:fs/promises'
import path from 'node:path'

// Export FileSessionManagerOptions y FileSessionManager
export interface FileSessionManagerOptions {
  dir: string
}

export class FileSessionManager extends SessionManager {
  readonly dir: string

  constructor(opts: FileSessionManagerOptions) {
    super()
    this.dir = path.resolve(opts.dir)
  }

  async get(id: string): Promise<SessionState | null> {
    const metaPath = path.join(this.dir, `${id}.meta.json`)
    const jsonlPath = path.join(this.dir, `${id}.jsonl`)

    try {
      const metaContent = await fs.readFile(metaPath, 'utf8')
      const meta = JSON.parse(metaContent)

      let messages: Message[] = []
      try {
        const jsonlContent = await fs.readFile(jsonlPath, 'utf8')
        messages = jsonlContent
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line))
      } catch (err) {
        // Safe to ignore if the file does not exist or is empty
      }

      return {
        id: meta.id,
        parentId: meta.parentId,
        metadata: meta.metadata ?? {},
        createdAt: meta.createdAt ?? Date.now(),
        updatedAt: meta.updatedAt ?? Date.now(),
        messages,
      }
    } catch (err) {
      return null
    }
  }

  async save(state: SessionState): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })

    const metaPath = path.join(this.dir, `${state.id}.meta.json`)
    const jsonlPath = path.join(this.dir, `${state.id}.jsonl`)

    const meta = {
      id: state.id,
      parentId: state.parentId,
      metadata: state.metadata,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    }

    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8')

    const jsonlLines =
      state.messages.map((m) => JSON.stringify(m)).join('\n') +
      (state.messages.length > 0 ? '\n' : '')
    await fs.writeFile(jsonlPath, jsonlLines, 'utf8')
  }

  async list(): Promise<SessionState[]> {
    try {
      await fs.mkdir(this.dir, { recursive: true })
      const files = await fs.readdir(this.dir)
      const metaFiles = files.filter((f) => f.endsWith('.meta.json'))

      const states: SessionState[] = []
      for (const file of metaFiles) {
        const id = file.slice(0, -10) // remove '.meta.json'
        const state = await this.get(id)
        if (state) {
          states.push(state)
        }
      }
      return states.sort((a, b) => b.updatedAt - a.updatedAt)
    } catch (err) {
      return []
    }
  }

  async delete(id: string): Promise<void> {
    const metaPath = path.join(this.dir, `${id}.meta.json`)
    const jsonlPath = path.join(this.dir, `${id}.jsonl`)

    try {
      await fs.unlink(metaPath)
    } catch (err) {
      // Ignore if it doesn't exist
    }
    try {
      await fs.unlink(jsonlPath)
    } catch (err) {
      // Ignore if it doesn't exist
    }
  }
}

// Monkeypatch SessionManager para mantener compatibilidad con SessionManager.fileSystem() en Node
(SessionManager as any).fileSystem = function (opts: FileSessionManagerOptions) {
  return new FileSessionManager(opts)
}

// Wrapper createNodeAgentSession
export interface CreateNodeAgentSessionOptions extends CreateAgentSessionOptions {}

export function createNodeAgentSession(opts: CreateNodeAgentSessionOptions): Promise<AgentSession> {
  const cwd = opts.cwd ?? process.cwd()
  const fileReader = opts.fileReader ?? (async (relPath: string) => {
    const abs = path.join(cwd, relPath)
    return fs.readFile(abs, 'utf8')
  })

  return createAgentSession({
    ...opts,
    cwd,
    fileReader,
  })
}

// Re-exportar MCP Client específico de Node
export { mountMcpServer } from './mcp/client.js'
export type { MountMcpServerOptions, MountedMcpServer, McpTransportConfig } from './mcp/client.js'

// Re-exportar AstorAgent
export { AstorAgent } from './agent/facade.js'
export type { AstorAgentOptions, AstorOutputMode } from './agent/facade.js'
