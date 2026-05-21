import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAgentSession } from '../src/agent/session.js'
import {
  InMemorySessionManager,
  SessionManager,
} from '../src/agent/sessionManager.js'
import { FileSessionManager } from '../src/node.js'
import { MockProvider } from './mock-provider.js'
import type { Message } from '../src/types.js'

describe('SessionManager & Persistence', () => {
  describe('InMemorySessionManager', () => {
    it('creación, recuperación, actualización, listado y eliminación', async () => {
      const manager = SessionManager.inMemory()

      // Create
      const state = await manager.create({
        metadata: { foo: 'bar' },
      })
      expect(state.id).toBeDefined()
      expect(state.parentId).toBeUndefined()
      expect(state.messages).toEqual([])
      expect(state.metadata).toEqual({ foo: 'bar' })

      // Get
      const retrieved = await manager.get(state.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.metadata).toEqual({ foo: 'bar' })

      // Save/Update
      const message: Message = { id: 'msg1', role: 'user', content: [{ type: 'text', text: 'hi' }] }
      retrieved!.messages.push(message)
      retrieved!.updatedAt = Date.now()
      await manager.save(retrieved!)

      const afterUpdate = await manager.get(state.id)
      expect(afterUpdate!.messages).toHaveLength(1)
      expect(afterUpdate!.messages[0]!.id).toBe('msg1')

      // List
      const list = await manager.list()
      expect(list).toHaveLength(1)
      expect(list[0]!.id).toBe(state.id)

      // Delete
      await manager.delete(state.id)
      const afterDelete = await manager.get(state.id)
      expect(afterDelete).toBeNull()

      const listAfterDelete = await manager.list()
      expect(listAfterDelete).toHaveLength(0)
    })

    it('branching de sesión (copiar todos o hasta un messageId)', async () => {
      const manager = SessionManager.inMemory()

      const parent = await manager.create()
      parent.messages = [
        { id: 'm1', role: 'user', content: [{ type: 'text', text: 'uno' }] },
        { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'dos' }] },
        { id: 'm3', role: 'user', content: [{ type: 'text', text: 'tres' }] },
      ]
      await manager.save(parent)

      // Branch all
      const childAll = await manager.create({
        parentId: parent.id,
      })
      expect(childAll.parentId).toBe(parent.id)
      expect(childAll.messages).toHaveLength(3)
      expect(childAll.messages[1]!.id).toBe('m2')

      // Branch to specific ID (m2)
      const childPart = await manager.create({
        parentId: parent.id,
        branchFromMessageId: 'm2',
      })
      expect(childPart.parentId).toBe(parent.id)
      expect(childPart.messages).toHaveLength(2)
      expect(childPart.messages[0]!.id).toBe('m1')
      expect(childPart.messages[1]!.id).toBe('m2')

      // Branch to invalid ID throws
      await expect(
        manager.create({
          parentId: parent.id,
          branchFromMessageId: 'nonexistent',
        })
      ).rejects.toThrow('Message with ID nonexistent not found')
    })
  })

  describe('FileSessionManager', () => {
    it('persistencia en archivos JSONL y meta.json', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-sessions-'))
      const manager = new FileSessionManager({ dir })

      // Create
      const state = await manager.create({
        metadata: { hello: 'world' },
      })

      // Check file creation
      const metaPath = path.join(dir, `${state.id}.meta.json`)
      const jsonlPath = path.join(dir, `${state.id}.jsonl`)

      const metaContent = JSON.parse(await readFile(metaPath, 'utf8'))
      expect(metaContent.id).toBe(state.id)
      expect(metaContent.metadata).toEqual({ hello: 'world' })

      // Get
      const retrieved = await manager.get(state.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.id).toBe(state.id)
      expect(retrieved!.messages).toEqual([])

      // Save message and verify JSONL format
      const messages: Message[] = [
        { id: 'm1', role: 'user', content: [{ type: 'text', text: 'first' }] },
        { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'second' }] },
      ]
      retrieved!.messages = messages
      await manager.save(retrieved!)

      const jsonlContent = await readFile(jsonlPath, 'utf8')
      const lines = jsonlContent.split('\n').filter((l) => l.trim() !== '')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!).id).toBe('m1')
      expect(JSON.parse(lines[1]!).id).toBe('m2')

      // Get after update
      const retrieved2 = await manager.get(state.id)
      expect(retrieved2!.messages).toHaveLength(2)

      // List
      const list = await manager.list()
      expect(list).toHaveLength(1)
      expect(list[0]!.id).toBe(state.id)

      // Delete
      await manager.delete(state.id)
      expect(await manager.get(state.id)).toBeNull()
    })

    it('branching de sesión persiste correctamente', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'astorlm-branching-'))
      const manager = new FileSessionManager({ dir })

      const parent = await manager.create()
      parent.messages = [
        { id: 'm1', role: 'user', content: [{ type: 'text', text: 'uno' }] },
        { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'dos' }] },
      ]
      await manager.save(parent)

      const child = await manager.create({
        parentId: parent.id,
        branchFromMessageId: 'm1',
      })

      expect(child.messages).toHaveLength(1)
      expect(child.messages[0]!.id).toBe('m1')

      // Read from filesystem to verify it was written
      const childJsonlPath = path.join(dir, `${child.id}.jsonl`)
      const childJsonl = await readFile(childJsonlPath, 'utf8')
      const childLines = childJsonl.split('\n').filter((l) => l.trim() !== '')
      expect(childLines).toHaveLength(1)
      expect(JSON.parse(childLines[0]!).id).toBe('m1')
    })
  })

  describe('AgentSession Integration', () => {
    it('guarda los mensajes automáticamente durante el bucle y los inicializa al crear sesión', async () => {
      const manager = SessionManager.inMemory()
      const provider = new MockProvider([
        { text: 'Respuesta del modelo', stopReason: 'end_turn' },
      ])

      // 1. Create a session with manager
      const sessionId = 'session-test-integration'
      const session = await createAgentSession({
        provider,
        sessionId,
        sessionManager: manager,
      })

      // Session list should show the created session
      const list = await manager.list()
      expect(list).toHaveLength(1)
      expect(list[0]!.id).toBe(sessionId)
      expect(list[0]!.messages).toEqual([])

      // 2. Call prompt (this will add user message and then run loop, which adds assistant message)
      await session.prompt('hola agente')

      // Get messages from session
      const msgs = session.getMessages()
      expect(msgs).toHaveLength(2)
      expect(msgs[0]!.role).toBe('user')
      expect(msgs[0]!.id).toBeDefined()
      expect(msgs[1]!.role).toBe('assistant')
      expect(msgs[1]!.id).toBeDefined()

      // Verify that the manager has saved the exact messages
      const savedState = await manager.get(sessionId)
      expect(savedState).not.toBeNull()
      expect(savedState!.messages).toHaveLength(2)
      expect(savedState!.messages[0]!.id).toBe(msgs[0]!.id)
      expect(savedState!.messages[1]!.id).toBe(msgs[1]!.id)

      // 3. Create a brand new session using the same ID to verify loading
      const resumedSession = await createAgentSession({
        provider,
        sessionId,
        sessionManager: manager,
      })

      expect(resumedSession.getMessages()).toHaveLength(2)
      expect(resumedSession.getMessages()[0]!.id).toBe(msgs[0]!.id)
    })
  })
})
