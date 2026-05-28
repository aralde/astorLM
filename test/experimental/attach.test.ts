import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent } from '../../src/agent/session.js'
import { tool } from '../../src/tools/define.js'
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
  it('injects a hint when an approved resolution exists and counts the reuse', async () => {
    // Tool that ALWAYS fails with the same error.
    const failing = tool({
      name: 'deploy',
      description: 'deploy',
      schema: z.object({ stack: z.string() }),
      execute: async () => {
        throw new Error('IAM PassRole denied for principal in eu-west-3')
      },
    })

    // Successful "fix" tool — simulates the agent applying a correction.
    const fix = tool({
      name: 'fix',
      description: 'fix',
      schema: z.object({ what: z.string() }),
      execute: async () => 'applied',
    })

    const registry = createErrorRegistry({ hitThreshold: 0.6 })
    await registry.init()

    // ---------- Session 1: hits the error, "resolves" it, leaves pending ----------
    const provider1 = new MockProvider([
      { toolCalls: [{ id: 't1', name: 'deploy', input: { stack: 'a' } }], stopReason: 'tool_use' },
      // After the error, two consecutive successful fixes:
      { toolCalls: [{ id: 't2', name: 'fix', input: { what: 'passrole' } }], stopReason: 'tool_use' },
      { toolCalls: [{ id: 't3', name: 'fix', input: { what: 'recheck' } }], stopReason: 'tool_use' },
      { text: 'Done: attached iam:PassRole to the principal.', stopReason: 'end_turn' },
    ])

    const session1 = await createAgent({
      provider: provider1,
      tools: [failing, fix],
      hooks: errorRegistryHooks({ registry, context: ctx, successWindow: 2 }),
    })
    await session1.run('deploy stack a')

    // One entry created, one pending resolution.
    expect(registry.listEntries()).toHaveLength(1)
    const pending = registry.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0].resolution.description).toContain('PassRole')

    // ---------- Human approval (asynchronous) ----------
    await registry.approveResolution(pending[0].resolution.id, 'ariel@example.com')

    // ---------- Session 2: same error, the hook should inject the hint ----------
    const provider2 = new MockProvider([
      { toolCalls: [{ id: 'u1', name: 'deploy', input: { stack: 'b' } }], stopReason: 'tool_use' },
      { toolCalls: [{ id: 'u2', name: 'fix', input: { what: 'apply hint' } }], stopReason: 'tool_use' },
      { toolCalls: [{ id: 'u3', name: 'fix', input: { what: 'verify' } }], stopReason: 'tool_use' },
      { text: 'Applied the hint, done.', stopReason: 'end_turn' },
    ])

    const session2 = await createAgent({
      provider: provider2,
      tools: [failing, fix],
      hooks: errorRegistryHooks({ registry, context: ctx, successWindow: 2 }),
    })
    await session2.run('deploy stack b')

    // The tool_result that was sent to provider2 should contain the
    // <error-registry-hint> block.
    const allText = JSON.stringify(session2.getMessages())
    expect(allText).toContain('error-registry-hint')
    expect(allText).toContain('PassRole')

    // The successful reuse of the approved resolution was counted.
    const hit = await registry.query({
      rawError: 'IAM PassRole denied for principal in eu-west-3',
      toolName: 'deploy',
      context: ctx,
    })
    expect(hit!.approvedResolutions[0].successCount).toBe(1)
  })

  it('does not record a resolution when the same error recurs within the window', async () => {
    const failing = tool({
      name: 'flaky',
      description: '',
      schema: z.object({}),
      execute: async () => {
        throw new Error('boom always')
      },
    })

    const registry = createErrorRegistry({ hitThreshold: 0.6 })
    await registry.init()

    // The agent fails, tries once, fails again, and gives up.
    const provider = new MockProvider([
      { toolCalls: [{ id: 'a', name: 'flaky', input: {} }], stopReason: 'tool_use' },
      { toolCalls: [{ id: 'b', name: 'flaky', input: {} }], stopReason: 'tool_use' },
      { text: 'giving up', stopReason: 'end_turn' },
    ])

    const session = await createAgent({
      provider,
      tools: [failing],
      hooks: errorRegistryHooks({ registry, context: ctx, successWindow: 2 }),
    })
    await session.run('try it')

    // No pending resolutions: we never had successWindow consecutive
    // successful executions without recurrence.
    expect(registry.listPending()).toHaveLength(0)
    // But the entry was created (the error was observed).
    expect(registry.listEntries()).toHaveLength(1)
  })
})
