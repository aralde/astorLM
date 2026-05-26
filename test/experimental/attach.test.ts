import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgentSession } from '../../src/agent/session.js'
import { defineTool } from '../../src/tools/define.js'
import { createErrorRegistry } from '../../src/experimental/error-registry/registry.js'
import { errorRegistryHooks } from '../../src/experimental/error-registry/attach.js'
import { MockProvider } from '../mock-provider.js'

const ctx = {
  cwd: '/tmp/proj',
  osPlatform: 'linux',
  nodeVersion: 'v20.0.0',
  tags: ['demo'],
}

describe('errorRegistryHooks', () => {
  it('inyecta un hint cuando hay resolución aprobada y registra reuse exitoso', async () => {
    // Tool que SIEMPRE falla con el mismo error.
    const failing = defineTool({
      name: 'deploy',
      description: 'deploy',
      schema: z.object({ stack: z.string() }),
      execute: async () => {
        throw new Error('IAM PassRole denied for principal in eu-west-3')
      },
    })

    // Tool de "fix" exitosa, simula que el agente arregla algo.
    const fix = defineTool({
      name: 'fix',
      description: 'fix',
      schema: z.object({ what: z.string() }),
      execute: async () => 'applied',
    })

    const registry = createErrorRegistry({ hitThreshold: 0.6 })
    await registry.init()

    // ---------- Sesión 1: choca con el error, "resuelve", queda pending ----------
    const provider1 = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'deploy', input: { stack: 'a' } }], stopReason: 'tool_use' },
      // Después del error, hace dos fixes exitosos seguidos:
      { toolCalls: [{ id: 't2', name: 'fix', input: { what: 'passrole' } }], stopReason: 'tool_use' },
      { toolCalls: [{ id: 't3', name: 'fix', input: { what: 'recheck' } }], stopReason: 'tool_use' },
      { text: 'Listo: agregué iam:PassRole al principal.', stopReason: 'end_turn' },
    ])

    const session1 = await createAgentSession({
      provider: provider1,
      tools: [failing, fix],
      hooks: errorRegistryHooks({ registry, context: ctx, successWindow: 2 }),
    })
    await session1.prompt('deploy stack a')

    // Una entry creada, una resolución pending.
    expect(registry.listEntries()).toHaveLength(1)
    const pending = registry.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0].resolution.description).toContain('PassRole')

    // ---------- Aprobación humana (asincrónica) ----------
    await registry.approveResolution(pending[0].resolution.id, 'ariel@example.com')

    // ---------- Sesión 2: mismo error, el hook debe inyectar el hint ----------
    const provider2 = new MockProvider([
      { toolCalls: [{ id: 'u1', name: 'deploy', input: { stack: 'b' } }], stopReason: 'tool_use' },
      { toolCalls: [{ id: 'u2', name: 'fix', input: { what: 'apply hint' } }], stopReason: 'tool_use' },
      { toolCalls: [{ id: 'u3', name: 'fix', input: { what: 'verify' } }], stopReason: 'tool_use' },
      { text: 'Aplicado el hint, listo.', stopReason: 'end_turn' },
    ])

    const session2 = await createAgentSession({
      provider: provider2,
      tools: [failing, fix],
      hooks: errorRegistryHooks({ registry, context: ctx, successWindow: 2 }),
    })
    await session2.prompt('deploy stack b')

    // Verificar que en algún tool_result que se le mandó al provider2
    // aparece el bloque <error-registry-hint> con la solución aprobada.
    // (calls[i].messages tiene referencia compartida con el historial, así
    // que escaneamos la unión final.)
    const allText = JSON.stringify(session2.getMessages())
    expect(allText).toContain('error-registry-hint')
    expect(allText).toContain('PassRole')

    // Y se contabilizó el reuse exitoso sobre la resolución aprobada.
    const hit = await registry.query({
      rawError: 'IAM PassRole denied for principal in eu-west-3',
      toolName: 'deploy',
      context: ctx,
    })
    expect(hit!.approvedResolutions[0].successCount).toBe(1)
  })

  it('no registra resolución si el mismo error recurre dentro de la ventana', async () => {
    const failing = defineTool({
      name: 'flaky',
      description: '',
      schema: z.object({}),
      execute: async () => {
        throw new Error('boom always')
      },
    })

    const registry = createErrorRegistry({ hitThreshold: 0.6 })
    await registry.init()

    // El agente falla, intenta una vez, vuelve a fallar, y termina.
    const provider = new MockProvider([
      { toolCalls: [{ id: 'a', name: 'flaky', input: {} }], stopReason: 'tool_use' },
      { toolCalls: [{ id: 'b', name: 'flaky', input: {} }], stopReason: 'tool_use' },
      { text: 'me rindo', stopReason: 'end_turn' },
    ])

    const session = await createAgentSession({
      provider,
      tools: [failing],
      hooks: errorRegistryHooks({ registry, context: ctx, successWindow: 2 }),
    })
    await session.prompt('intentá')

    // No debería haber resoluciones pending: nunca hubo successWindow seguidos sin recurrencia.
    expect(registry.listPending()).toHaveLength(0)
    // Sí debería haber una entry creada (el error fue visto).
    expect(registry.listEntries()).toHaveLength(1)
  })
})
