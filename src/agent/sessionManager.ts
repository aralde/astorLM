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

export abstract class SessionManager {
  static inMemory(): InMemorySessionManager {
    return new InMemorySessionManager()
  }

  async create(opts?: CreateSessionOptions): Promise<SessionState> {
    const id = opts?.id ?? crypto.randomUUID()
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
      id: m.id ?? crypto.randomUUID(),
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
