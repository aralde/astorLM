import { describe, expect, it } from 'vitest'
import { estimateTokens, optimizeContext } from '../src/agent/optimizer.js'
import { createAgentSession } from '../src/agent/session.js'
import { MockProvider } from './mock-provider.js'
import { SessionManager } from '../src/agent/sessionManager.js'
import type { Message, ContextOptimizerOptions } from '../src/types.js'

describe('Context Optimizer & Token Estimator', () => {
  describe('estimateTokens', () => {
    it('estima correctamente en base a caracteres (chars / 4)', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello world!' }], // 12 chars
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi!' }], // 3 chars
        },
      ]
      // systemPrompt: undefined
      // charCount = 'user'.length (4) + 12 + 'assistant'.length (9) + 3 = 28 chars
      // 28 / 4 = 7 tokens
      expect(estimateTokens(messages)).toBe(7)

      // Con systemPrompt de 13 chars: +13 chars = 41 chars total
      // 41 / 4 = 10.25 -> 11 tokens
      expect(estimateTokens(messages, 'System prompt')).toBe(11)
    })
  })

  describe('optimizeContext', () => {
    const defaultOpts: Required<ContextOptimizerOptions> = {
      maxTokens: 100,
      compressThreshold: 0.8, // 80 tokens
      keepRecentTurns: 1,
      tokenCounter: (msgs, sys) => estimateTokens(msgs, sys),
    }

    it('no optimiza si está por debajo del threshold', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Short prompt' }] },
      ]
      const { messages: optimized, optimized: wasOptimized } = optimizeContext(
        messages,
        'Sys',
        defaultOpts
      )
      expect(wasOptimized).toBe(false)
      expect(optimized).toEqual(messages)
    })

    it('no optimiza si todos los mensajes están protegidos por keepRecentTurns', () => {
      // 200 chars ≈ 50 tokens
      // threshold es 80 tokens, pero si ponemos maxTokens muy bajo: maxTokens: 40 -> threshold = 32 tokens
      // 200 chars excede threshold (50 > 32)
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'a'.repeat(200) }] },
      ]
      const { messages: optimized, optimized: wasOptimized } = optimizeContext(
        messages,
        'Sys',
        {
          ...defaultOpts,
          maxTokens: 40,
        }
      )
      // Como solo hay un mensaje, es parte del turno reciente protegido.
      expect(wasOptimized).toBe(false)
      expect(optimized).toEqual(messages)
    })

    it('compacta bloques tool_result antiguos cuando excede el threshold', () => {
      // Generamos un historial largo para tener mensajes fuera del keepRecentTurns
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Initial request' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me run a tool' },
            { type: 'tool_use', id: 'tu_1', name: 'grep', input: { query: 'foo' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: 'very long tool result output '.repeat(50), // ~1450 chars ≈ 362 tokens
            },
          ],
        },
        // Turno reciente (protegido por keepRecentTurns: 1)
        { role: 'user', content: [{ type: 'text', text: 'Recent follow-up prompt' }] },
      ]

      // Con maxTokens: 400 y threshold: 320 (80%), 362 tokens de tool_result superan el umbral cuando se
      // suma el resto de textos, pero después de compactar queda muy por debajo, evitando eliminar mensajes.
      const { messages: optimized, optimized: wasOptimized } = optimizeContext(
        messages,
        'Sys',
        {
          ...defaultOpts,
          maxTokens: 400,
        }
      )

      expect(wasOptimized).toBe(true)
      // El mensaje 2 (tool_result) debe estar compactado
      const toolResultMsg = optimized[2]!
      expect(toolResultMsg.role).toBe('user')
      const block = toolResultMsg.content[0]!
      expect(block.type).toBe('tool_result')
      expect(block.content).toContain("[Tool 'grep' execution result truncated")
      expect(block.content).toContain('Original output length: 1450 characters')
      // El último mensaje (turno reciente) no debe alterarse
      expect(optimized[3]).toEqual(messages[3])
    })

    it('elimina los mensajes más antiguos (excepto el inicial) si compactar tool_results no es suficiente', () => {
      // Configuramos para que el contenido sea gigante tanto en los textos que no se pueden compactar
      // (ya que no son tool_results) como en general.
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Initial request' }] }, // Msg 0 (mantenido)
        { role: 'assistant', content: [{ type: 'text', text: 'Intermediate text '.repeat(100) }] }, // Msg 1 (eliminado)
        { role: 'user', content: [{ type: 'text', text: 'More intermediate text '.repeat(100) }] }, // Msg 2 (eliminado)
        // Turno reciente (protegido por keepRecentTurns: 1)
        { role: 'user', content: [{ type: 'text', text: 'Recent follow-up' }] }, // Msg 3 (mantenido)
      ]

      const { messages: optimized, optimized: wasOptimized } = optimizeContext(
        messages,
        'Sys',
        {
          ...defaultOpts,
          maxTokens: 50, // Umbral muy bajo
        }
      )

      expect(wasOptimized).toBe(true)
      // Debe quedar el inicial (Msg 0) y el reciente (Msg 3)
      expect(optimized).toHaveLength(2)
      expect(optimized[0]?.content[0]).toEqual({ type: 'text', text: 'Initial request' })
      expect(optimized[1]?.content[0]).toEqual({ type: 'text', text: 'Recent follow-up' })
    })
  })

  describe('Integration with AgentSession', () => {
    it('activa automáticamente el optimizador si el provider define contextLimit', async () => {
      const provider = new MockProvider([
        { text: 'Final response.', stopReason: 'end_turn' },
      ])
      // Simulamos que el provider expone un contextLimit de 500 tokens (threshold = 400)
      Object.defineProperty(provider, 'contextLimit', {
        value: 500,
        writable: false,
      })

      // Mensajes antiguos manualmente para simular historial previo con más de 3 turnos (keepRecentTurns = 3 por defecto)
      const msgs: Message[] = [
        // Turno 1 (se compactará su tool_result porque cae fuera de los últimos 3 turnos al enviar el prompt)
        {
          role: 'user',
          content: [{ type: 'text', text: 'Turn 1 initial setup' }],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'grep', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: 'huge grep output content '.repeat(100), // ~2500 chars ≈ 625 tokens
            },
          ],
        },
        // Turno 2 (protegido)
        {
          role: 'user',
          content: [{ type: 'text', text: 'Turn 2 user prompt' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Turn 2 response' }],
        },
        // Turno 3 (protegido)
        {
          role: 'user',
          content: [{ type: 'text', text: 'Turn 3 user prompt' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Turn 3 response' }],
        },
      ]

      const sessionManager = SessionManager.inMemory()
      const sessionId = 'test-session-id'
      await sessionManager.save({
        id: sessionId,
        messages: msgs,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      const session = await createAgentSession({
        provider,
        sessionId,
        sessionManager,
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      })

      // Ejecutar un nuevo prompt (se convertirá en el Turno 4, protegiendo Turnos 4, 3, 2).
      // Turno 1 quedará fuera de la ventana de protección y se compactará.
      await session.prompt('What is next?')

      // Validar que el historial guardado en la sesión fue compactado
      const finalMsgs = session.getMessages()
      // El mensaje con el tool_result de grep (índice 2 de msgs) debe haber sido compactado.
      const compactMsg = finalMsgs[2]!
      expect(compactMsg.content[0]?.type).toBe('tool_result')
      expect(compactMsg.content[0]?.content).toContain("[Tool 'grep' execution result truncated")
    })
  })
})
