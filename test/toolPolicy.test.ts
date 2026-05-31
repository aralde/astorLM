import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent } from '../src/agent/session.js'
import { tool } from '../src/tools/define.js'
import { parseAllowedTools, restrictToolsHook } from '../src/skills/toolPolicy.js'
import { MockProvider } from './mock-provider.js'
import type { ToolResultBlock } from '../src/types.js'

describe('parseAllowedTools', () => {
  it('parses a comma-separated frontmatter field', () => {
    expect(parseAllowedTools({ metadata: { 'allowed-tools': 'read, bash , grep' } })).toEqual([
      'read',
      'bash',
      'grep',
    ])
  })

  it('returns null when absent or empty', () => {
    expect(parseAllowedTools({ metadata: undefined })).toBeNull()
    expect(parseAllowedTools({ metadata: {} })).toBeNull()
    expect(parseAllowedTools({ metadata: { 'allowed-tools': '  ,  ' } })).toBeNull()
  })
})

describe('restrictToolsHook', () => {
  const makeTool = (name: string, calls: string[]) =>
    tool({
      name,
      description: name,
      schema: z.object({}),
      execute: async () => {
        calls.push(name)
        return `${name} ran`
      },
    })

  it('runs allowed tools and denies the rest with an explanatory result', async () => {
    const calls: string[] = []
    const provider = new MockProvider([
      {
        toolCalls: [
          { id: 'a', name: 'readish', input: {} },
          { id: 'b', name: 'dangerous', input: {} },
        ],
        stopReason: 'tool_use',
      },
      { text: 'done', stopReason: 'end_turn' },
    ])

    const session = await createAgent({
      provider,
      tools: [makeTool('readish', calls), makeTool('dangerous', calls)],
      hooks: restrictToolsHook(['readish']),
    })
    await session.run('go')

    // Only the allowed tool actually executed.
    expect(calls).toEqual(['readish'])

    const blocks = session.getMessages()[2]!.content as ToolResultBlock[]
    expect(blocks[0]).toMatchObject({ tool_use_id: 'a', content: 'readish ran', is_error: false })
    expect(blocks[1]).toMatchObject({ tool_use_id: 'b', is_error: true })
    expect(blocks[1]!.content).toContain('not in the active skill')
  })

  it('honors alwaysAllow and a custom denyMessage', async () => {
    const calls: string[] = []
    const provider = new MockProvider([
      {
        toolCalls: [
          { id: 'a', name: 'read', input: {} },
          { id: 'b', name: 'write', input: {} },
        ],
        stopReason: 'tool_use',
      },
      { text: 'done', stopReason: 'end_turn' },
    ])

    const session = await createAgent({
      provider,
      tools: [makeTool('read', calls), makeTool('write', calls)],
      hooks: restrictToolsHook([], {
        alwaysAllow: ['read'],
        denyMessage: (t) => `nope: ${t}`,
      }),
    })
    await session.run('go')

    expect(calls).toEqual(['read'])
    const blocks = session.getMessages()[2]!.content as ToolResultBlock[]
    expect(blocks[1]!.content).toBe('nope: write')
  })
})
