import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createAgent } from '../src/agent/session.js'
import { tool } from '../src/tools/define.js'
import { MockProvider } from './mock-provider.js'
import { InMemorySessionManager } from '../src/agent/sessionManager.js'
import type { AgentEvent } from '../src/types.js'

describe('loop variants & heartbeat', () => {
  it('inicializa con el patrón correcto', async () => {
    const provider = new MockProvider([{ text: 'ok' }])
    const agent = await createAgent({ provider, pattern: 'PLAN_EXECUTE' })
    expect(agent.pattern).toBe('PLAN_EXECUTE')
  })

  it('ejecuta heartbeat periódico y emite ticks', async () => {
    const provider = new MockProvider([
      { text: 'Heartbeat response 1' },
      { text: 'Heartbeat response 2' },
      { text: 'Heartbeat response 3' },
    ])

    const events: AgentEvent[] = []
    const agent = await createAgent({
      provider,
      heartbeat: {
        intervalMs: 15,
        checkPrompt: 'check-status',
      },
    })

    agent.on('event', (e) => events.push(e))

    // Esperar un par de intervalos de heartbeat
    await new Promise((resolve) => setTimeout(resolve, 50))
    agent.stopHeartbeat()

    const ticks = events.filter((e) => e.type === 'heartbeat_tick')
    expect(ticks.length).toBeGreaterThanOrEqual(1)
    expect((ticks[0] as any).checkPrompt).toBe('check-status')

    // Verificar que se haya llamado al provider
    expect(provider.calls.length).toBeGreaterThanOrEqual(1)
    expect(provider.calls[0]?.messages[0]?.content[0]).toMatchObject({
      type: 'text',
      text: 'check-status',
    })
  })

  it('evita concurrencia tirando error en llamadas simultáneas a run()', async () => {
    // Mock tool that runs slowly
    const slow = tool({
      name: 'slow',
      description: 'demora',
      schema: z.object({}),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return 'done'
      },
    })

    const provider = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'slow', input: {} }] },
      { text: 'final text' },
    ])

    const agent = await createAgent({ provider, tools: [slow] })

    const p1 = agent.run('start')
    // Llamar a run de nuevo mientras p1 está en ejecución debe lanzar un error de concurrencia
    await expect(agent.run('concurrente')).rejects.toThrow('Agent is already running a task.')

    await p1
  })

  it('descarta el tick de heartbeat si el agente ya está ejecutando una tarea', async () => {
    const slow = tool({
      name: 'slow',
      description: 'demora',
      schema: z.object({}),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
        return 'done'
      },
    })

    const provider = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'slow', input: {} }] },
      { text: 'done' },
      { text: 'heartbeat done' },
    ])

    const agent = await createAgent({
      provider,
      tools: [slow],
      heartbeat: {
        intervalMs: 10,
        checkPrompt: 'check',
      },
    })

    // Apagamos el heartbeat manual al inicio para controlarlo
    agent.stopHeartbeat()

    // Iniciamos una ejecución lenta
    const runPromise = agent.run('iniciar tarea lenta')

    // Arrancamos el heartbeat mientras corre
    agent.startHeartbeat()

    // Esperamos 25ms, durante los cuales debió ocurrir al menos un tick de heartbeat
    await new Promise((resolve) => setTimeout(resolve, 25))

    agent.stopHeartbeat()
    await runPromise

    // El heartbeat debió descartar los ticks de ejecución, por lo que no debió iniciar ningún prompt
    // El provider sólo debió ver las llamadas de la ejecución manual (2 turnos: tool call + text response)
    expect(provider.calls.length).toBe(2)
  })

  it('soporta PLAN_EXECUTE y gestiona el plan mediante herramientas y prompt', async () => {
    const provider = new MockProvider([
      {
        toolCalls: [
          { id: 'p1', name: 'add_plan_item', input: { description: 'Escribir tests' } },
          { id: 'p2', name: 'add_plan_item', input: { description: 'Correr tests' } },
        ],
        stopReason: 'tool_use',
      },
      {
        toolCalls: [
          { id: 'p3', name: 'update_plan_item', input: { id: 'TO_BE_REPLACED', status: 'completed' } },
        ],
        stopReason: 'tool_use',
      },
      { text: 'Plan completado.', stopReason: 'end_turn' },
    ])

    const agent = await createAgent({
      provider,
      pattern: 'PLAN_EXECUTE',
      hooks: {
        beforeToolExecution: async ({ toolName, input }) => {
          if (toolName === 'update_plan_item') {
            const raw = input as { id: string; status: string }
            if (raw.id === 'TO_BE_REPLACED') {
              const item = agent.getPlan().find((i) => i.description === 'Escribir tests')
              if (item) {
                raw.id = item.id
              }
            }
          }
          return { authorize: true }
        }
      }
    })

    expect(agent.getPlan()).toHaveLength(0)

    // Corremos el agente
    await agent.run('Organiza el trabajo')

    const plan = agent.getPlan()
    expect(plan).toHaveLength(2)
    expect(plan.find((i) => i.description === 'Escribir tests')?.status).toBe('completed')
    expect(plan.find((i) => i.description === 'Correr tests')?.status).toBe('pending')

    // Verificar que el plan se inyectó dinámicamente en el system prompt en todos los turnos
    expect(provider.calls[0]?.systemPrompt).toContain('[Active Plan State]')
    expect(provider.calls[0]?.systemPrompt).toContain('(No tasks defined yet. Use add_plan_item tool to define tasks)')
    expect(provider.calls[1]?.systemPrompt).toContain('[Active Plan State]')
    expect(provider.calls[1]?.systemPrompt).toContain('Escribir tests')
    expect(provider.calls[1]?.systemPrompt).toContain('Correr tests')
    expect(provider.calls[2]?.systemPrompt).toContain('- [COMPLETED] Escribir tests')
  })

  it('asigna ids cortos secuenciales a los items del plan', async () => {
    const provider = new MockProvider([
      {
        toolCalls: [
          { id: 'a', name: 'add_plan_item', input: { description: 'Tarea uno' } },
          { id: 'b', name: 'add_plan_item', input: { description: 'Tarea dos' } },
        ],
        stopReason: 'tool_use',
      },
      { text: 'listo', stopReason: 'end_turn' },
    ])

    const agent = await createAgent({ provider, pattern: 'PLAN_EXECUTE' })
    await agent.run('plan')

    expect(agent.getPlan().map((i) => i.id)).toEqual(['1', '2'])
  })

  it('persiste el plan en metadata y lo restaura al recrear la sesion', async () => {
    const manager = new InMemorySessionManager()
    const sessionId = 'plan-persist-1'

    const provider1 = new MockProvider([
      {
        toolCalls: [
          { id: 'a', name: 'add_plan_item', input: { description: 'Escribir tests' } },
          { id: 'b', name: 'add_plan_item', input: { description: 'Correr tests' } },
        ],
        stopReason: 'tool_use',
      },
      {
        toolCalls: [{ id: 'c', name: 'update_plan_item', input: { id: '1', status: 'completed' } }],
        stopReason: 'tool_use',
      },
      { text: 'ok', stopReason: 'end_turn' },
    ])

    const agent1 = await createAgent({
      provider: provider1,
      pattern: 'PLAN_EXECUTE',
      sessionManager: manager,
      sessionId,
    })
    await agent1.run('organiza')
    expect(agent1.getPlan()).toHaveLength(2)

    // Recrear la sesion contra el mismo manager: el plan debe restaurarse.
    const agent2 = await createAgent({
      provider: new MockProvider([{ text: 'noop' }]),
      pattern: 'PLAN_EXECUTE',
      sessionManager: manager,
      sessionId,
    })

    const restored = agent2.getPlan()
    expect(restored).toHaveLength(2)
    expect(restored.find((i) => i.description === 'Escribir tests')?.status).toBe('completed')
    expect(restored.find((i) => i.description === 'Correr tests')?.status).toBe('pending')

    // El contador continua desde el id mas alto restaurado (no reinicia en 1).
    const provider3 = new MockProvider([
      {
        toolCalls: [{ id: 'd', name: 'add_plan_item', input: { description: 'Tarea nueva' } }],
        stopReason: 'tool_use',
      },
      { text: 'ok', stopReason: 'end_turn' },
    ])
    const agent3 = await createAgent({
      provider: provider3,
      pattern: 'PLAN_EXECUTE',
      sessionManager: manager,
      sessionId,
    })
    await agent3.run('agrega una mas')
    expect(agent3.getPlan().find((i) => i.description === 'Tarea nueva')?.id).toBe('3')
  })

  it('heartbeat latente con localCondition solo llama al LLM si la condicion es verdadera', async () => {
    const provider = new MockProvider([
      { text: 'Heartbeat response' },
    ])

    let conditionValue = false
    const events: AgentEvent[] = []
    const agent = await createAgent({
      provider,
      heartbeat: {
        intervalMs: 10,
        checkPrompt: 'check-status',
        localCondition: () => conditionValue,
      },
    })
    agent.on('event', (e) => events.push(e))

    // Esperar a que pasen ticks con conditionValue = false
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(provider.calls.length).toBe(0) // No debe haberse llamado al LLM

    // Cambiar la condición a true
    conditionValue = true
    await new Promise((resolve) => setTimeout(resolve, 30))
    agent.stopHeartbeat()

    expect(provider.calls.length).toBeGreaterThanOrEqual(1) // Debe haberse llamado al LLM
  })

  it('heartbeat se detiene automaticamente por maxTicks y timeoutMs', async () => {
    const provider = new MockProvider([
      { text: 'Heartbeat response 1' },
      { text: 'Heartbeat response 2' },
      { text: 'Heartbeat response 3' },
    ])

    const agent = await createAgent({
      provider,
      heartbeat: {
        intervalMs: 10,
        checkPrompt: 'check-status',
        maxTicks: 2,
      },
    })

    // Esperar ticks suficientes para que se apague por maxTicks
    await new Promise((resolve) => setTimeout(resolve, 40))
    // Al apagarse por maxTicks (2 ticks), no debe seguir llamando
    const callsAfterTicks = provider.calls.length
    expect(callsAfterTicks).toBe(2)

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(provider.calls.length).toBe(2) // No debe haber incrementado
  })

  it('heartbeat no auto-inicia si autoStart es false', async () => {
    const provider = new MockProvider([{ text: 'Heartbeat response' }])
    const agent = await createAgent({
      provider,
      heartbeat: {
        intervalMs: 10,
        checkPrompt: 'check-status',
        autoStart: false,
      },
    })

    // Esperar un intervalo de heartbeat
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(provider.calls.length).toBe(0) // No debe haberse iniciado automáticamente

    // Iniciar manualmente
    agent.startHeartbeat()
    await new Promise((resolve) => setTimeout(resolve, 25))
    agent.stopHeartbeat()
    expect(provider.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('heartbeat se detiene por timeoutMs por defecto de 300000ms', async () => {
    vi.useFakeTimers()
    const provider = new MockProvider([
      { text: 'Heartbeat response 1' },
      { text: 'Heartbeat response 2' },
      { text: 'Heartbeat response 3' },
    ])
    
    const agent = await createAgent({
      provider,
      heartbeat: {
        intervalMs: 100000,
        checkPrompt: 'check-status',
      },
    })

    // A los 105s, tick 1
    await vi.advanceTimersByTimeAsync(105000)
    expect(provider.calls.length).toBe(1)

    // A los 205s, tick 2
    await vi.advanceTimersByTimeAsync(100000)
    expect(provider.calls.length).toBe(2)

    // A los 305s (el timeout ya disparó a los 300s)
    await vi.advanceTimersByTimeAsync(100000)
    
    // A los 405s, no debería haber incrementado
    await vi.advanceTimersByTimeAsync(100000)
    expect(provider.calls.length).toBe(2)

    vi.useRealTimers()
  })
})

