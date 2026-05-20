import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Message } from '../types.js'

export interface SessionState {
  id: string
  parentId?: string
  messages: Message[]
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface CreateSessionOptions {
  id?: string
  parentId?: string
  branchFromMessageId?: string
  metadata?: Record<string, unknown>
}

export interface FileSessionManagerOptions {
  dir: string
}

export abstract class SessionManager {
  static inMemory(): InMemorySessionManager {
    return new InMemorySessionManager()
  }

  static fileSystem(opts: FileSessionManagerOptions): FileSessionManager {
    return new FileSessionManager(opts)
  }

  async create(opts?: CreateSessionOptions): Promise<SessionState> {
    const id = opts?.id ?? randomUUID()
    let messages: Message[] = []

    if (opts?.parentId) {
      const parent = await this.get(opts.parentId)
      if (!parent) {
        throw new Error(`Parent session ${opts.parentId} not found`)
      }
      if (opts.branchFromMessageId) {
        const index = parent.messages.findIndex((m) => m.id === opts.branchFromMessageId)
        if (index === -1) {
          throw new Error(
            `Message with ID ${opts.branchFromMessageId} not found in parent session ${opts.parentId}`
          )
        }
        messages = parent.messages.slice(0, index + 1)
      } else {
        messages = parent.messages.slice()
      }
    }

    // Ensure all copied messages have IDs
    messages = messages.map((m) => ({
      ...m,
      id: m.id ?? randomUUID(),
    }))

    const state: SessionState = {
      id,
      parentId: opts?.parentId,
      messages,
      metadata: opts?.metadata ?? {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    await this.save(state)
    return state
  }

  abstract get(id: string): Promise<SessionState | null>
  abstract save(state: SessionState): Promise<void>
  abstract list(): Promise<SessionState[]>
  abstract delete(id: string): Promise<void>
}

export class InMemorySessionManager extends SessionManager {
  private sessions = new Map<string, SessionState>()

  async get(id: string): Promise<SessionState | null> {
    const state = this.sessions.get(id)
    if (!state) return null
    return {
      ...state,
      messages: state.messages.map((m) => ({ ...m })),
    }
  }

  async save(state: SessionState): Promise<void> {
    this.sessions.set(state.id, {
      ...state,
      messages: state.messages.map((m) => ({ ...m })),
    })
  }

  async list(): Promise<SessionState[]> {
    return Array.from(this.sessions.values())
      .map((state) => ({
        ...state,
        messages: state.messages.map((m) => ({ ...m })),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id)
  }
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
