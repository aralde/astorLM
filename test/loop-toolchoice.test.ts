import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent/session.js'
import { MockProvider } from './mock-provider.js'
import type { SessionHooks } from '../src/types.js'

describe('loop forwards toolChoice from beforeProviderCall', () => {
  it('passes a hook-provided toolChoice into the provider stream options', async () => {
    const provider = new MockProvider([{ text: 'done', stopReason: 'end_turn' }])
    const hooks: SessionHooks = {
      beforeProviderCall: async ({ messages, systemPrompt }) => ({
        messages,
        systemPrompt,
        toolChoice: 'none',
      }),
    }
    const session = await createAgent({ provider, hooks })
    await session.run('go')

    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]!.toolChoice).toBe('none')
  })

  it('leaves toolChoice undefined when the hook does not set it', async () => {
    const provider = new MockProvider([{ text: 'done', stopReason: 'end_turn' }])
    const session = await createAgent({ provider })
    await session.run('go')
    expect(provider.calls[0]!.toolChoice).toBeUndefined()
  })
})
