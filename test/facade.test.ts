import { describe, expect, it } from 'vitest'
import { AstorAgent } from '../src/agent/facade.js'
import { SessionManager } from '../src/agent/sessionManager.js'
import { MockProvider } from './mock-provider.js'
import type { AgentEvent } from '../src/types.js'

describe('AstorAgent Facade', () => {
  it('runTask ejecuta correctamente e inicializa automáticamente', async () => {
    const manager = SessionManager.inMemory()
    const provider = new MockProvider([
      { text: 'Respuesta facade', stopReason: 'end_turn' },
    ])

    const agent = new AstorAgent({
      provider,
      sessionManager: manager,
      tools: [], // No tools for this test
      defaultOutputMode: 'silent',
    })

    const result = await agent.runTask('hola facade', { sessionId: 'test-facade' })
    expect(result.sessionId).toBe('test-facade')
    expect(result.text).toBe('Respuesta facade')

    // Verificar que persistió en el manager
    const saved = await manager.get('test-facade')
    expect(saved).not.toBeNull()
    expect(saved!.messages).toHaveLength(2)
    expect(saved!.messages[0]!.content[0]!.type).toBe('text')
    expect((saved!.messages[0]!.content[0] as any).text).toBe('hola facade')
  })

  it('soporta custom logger / outputMode callback', async () => {
    const provider = new MockProvider([
      { text: 'Respuesta logger', stopReason: 'end_turn' },
    ])

    const agent = new AstorAgent({
      provider,
      tools: [],
      defaultOutputMode: 'silent',
    })

    const events: AgentEvent[] = []
    const customCallback = (e: AgentEvent) => {
      events.push(e)
    }

    await agent.runTask('test callback', { outputMode: customCallback })

    expect(events.length).toBeGreaterThan(0)
    // Debería contener text_delta
    const textDeltas = events.filter((e) => e.type === 'text_delta')
    expect(textDeltas.length).toBeGreaterThan(0)
  })

  it('runBranchTask realiza branching y corre instrucción en un solo paso', async () => {
    const manager = SessionManager.inMemory()
    const provider = new MockProvider([
      { text: 'Respuesta branch', stopReason: 'end_turn' },
    ])

    const agent = new AstorAgent({
      provider,
      sessionManager: manager,
      tools: [],
      defaultOutputMode: 'silent',
    })

    // Crear sesión padre e inicializarla con algún mensaje
    const parent = await manager.create({ id: 'padre' })
    parent.messages = [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'origen' }] },
      { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'respuesta' }] },
    ]
    await manager.save(parent)

    // Crear branch e interactuar
    const result = await agent.runBranchTask({
      parentId: 'padre',
      branchFromMessageId: 'm2',
      newSessionId: 'hija',
      promptText: 'continuación',
    })

    expect(result.sessionId).toBe('hija')
    expect(result.text).toBe('Respuesta branch')

    // Verificar que la hija tiene 4 mensajes (m1, m2 de herencia, y el nuevo prompt/respuesta)
    const childState = await manager.get('hija')
    expect(childState!.messages).toHaveLength(4)
    expect(childState!.messages[0]!.id).toBe('m1')
    expect(childState!.messages[1]!.id).toBe('m2')
  })
})
