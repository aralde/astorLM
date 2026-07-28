import { createAgent } from './agent/session.js'
import type { CreateAgentOptions, Agent } from './agent/session.js'
import { SessionManager } from './agent/sessionManager.js'
import type { SessionState } from './agent/sessionManager.js'
import type { Message } from './types.js'
import { LocalExecutor } from './executor/local.js'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Options for configuring the FileSessionManager.
 */
export interface FileSessionManagerOptions {
  dir: string
}

/**
 * A SessionManager implementation that persists session state to the filesystem.
 * Stores metadata in `.meta.json` files and conversation history in `.jsonl` files.
 */
export class FileSessionManager extends SessionManager {
  readonly dir: string

  /**
   * Creates a new FileSessionManager.
   * @param opts - Options containing the directory to store session files.
   */
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

/**
 * Options for creating a local Node-based agent.
 * Inherits all core Agent creation options.
 */
export interface CreateLocalAgentOptions extends CreateAgentOptions {}

/**
 * Creates a local Node-based agent.
 * This is a wrapper around `createAgent` that automatically configures defaults
 * suitable for local Node.js execution (e.g., local filesystem, LocalExecutor).
 * 
 * @param opts - Options for configuring the local agent.
 * @returns A Promise that resolves to the initialized Agent instance.
 */
export function createLocalAgent(opts: CreateLocalAgentOptions): Promise<Agent> {
  const cwd = opts.cwd ?? process.cwd()
  const fileReader = opts.fileReader ?? (async (relPath: string) => {
    const abs = path.join(cwd, relPath)
    return fs.readFile(abs, 'utf8')
  })

  return createAgent({
    ...opts,
    cwd,
    fileReader,
    executor: opts.executor ?? new LocalExecutor(),
  })
}

// Re-export Node-specific MCP Client
export { mountMcpServer } from './mcp/client.js'
export type {
  MountMcpServerOptions,
  MountedMcpServer,
  McpTransportConfig,
  McpToolUi,
  McpUiResource,
} from './mcp/client.js'

// Re-export AstorAgent
export { AstorAgent } from './agent/facade.js'
export type { AstorAgentOptions, AstorOutputMode } from './agent/facade.js'

// Node-specific executors
export { LocalExecutor } from './executor/local.js'
export { DockerExecutor } from './executor/docker.js'
export type { DockerExecutorOptions } from './executor/docker.js'

// Skill sources that need Node APIs (filesystem). The core `Skill`,
// `SkillSource`, `SkillRegistry`, etc. live in the agnostic barrel.
export { createFileSystemSkillSource } from './skills-node/fileSystemSource.js'
export type { FileSystemSkillSourceOptions } from './skills-node/fileSystemSource.js'
export { createLayeredSkillSource } from './skills-node/layeredSource.js'
export type { LayeredSkillSourceOptions } from './skills-node/layeredSource.js'
