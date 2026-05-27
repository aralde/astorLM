import { describe, expect, it } from 'vitest'
import { createAgentSession, type AgentSession } from '../src/agent/session.js'
import { createInMemorySkillSource } from '../src/skills/inMemorySource.js'
import { MockProvider } from './mock-provider.js'
import type { ContentBlock } from '../src/types.js'

/**
 * Finds the tool_result block addressed to a given tool_use id within
 * the session's message log. We look at `session.getMessages()` rather
 * than `provider.calls[n].messages`, because the mock provider keeps a
 * reference to the live array — after the loop terminates, every
 * recorded call points at the final mutated state.
 */
function findToolResult(
  session: AgentSession,
  toolUseId: string,
): Extract<ContentBlock, { type: 'tool_result' }> | undefined {
  for (const m of session.getMessages()) {
    if (m.role !== 'user') continue
    for (const block of m.content) {
      if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
        return block
      }
    }
  }
  return undefined
}

const SKILL_BODY = '## How to deck\nUse pptx-genjs to render slides.'

const makeSource = () =>
  createInMemorySkillSource({
    name: 'test-bundle',
    skills: [
      {
        name: 'pptx',
        description: 'Build PowerPoint decks when the user asks for slides.',
        body: SKILL_BODY,
      },
    ],
  })

describe('skills integration (session)', () => {
  describe("mode: 'on-demand' (default)", () => {
    it('lists skills in <available-skills> and auto-registers load_skill', async () => {
      const provider = new MockProvider([{ text: 'ok', stopReason: 'end_turn' }])

      const session = await createAgentSession({
        provider,
        skillSources: [makeSource()],
      })

      // load_skill must be registered.
      expect(session.registry.has('load_skill')).toBe(true)

      await session.prompt('Hello')

      // The system prompt sent to the provider must list the skill but not its body.
      const sentSystem = provider.calls[0]!.systemPrompt
      expect(sentSystem).toContain('<available-skills>')
      // The skill name appears wrapped in backticks (markdown-style),
      // not preceded by a `name:` YAML label — Llama models hallucinate
      // function names like `name: foo` when primed with the latter.
      expect(sentSystem).toContain('`pptx`')
      expect(sentSystem).not.toMatch(/name:\s*pptx/)
      expect(sentSystem).toContain(
        'Build PowerPoint decks when the user asks for slides.',
      )
      expect(sentSystem).not.toContain(SKILL_BODY)
    })

    it('returns the body wrapped in <skill> when load_skill is invoked', async () => {
      const provider = new MockProvider([
        {
          toolCalls: [{ id: 'tu-1', name: 'load_skill', input: { name: 'pptx' } }],
        },
        { text: 'Loaded.', stopReason: 'end_turn' },
      ])

      const session = await createAgentSession({
        provider,
        skillSources: [makeSource()],
      })

      await session.prompt('Make a deck about cats')

      const toolResult = findToolResult(session, 'tu-1')
      expect(toolResult).toBeDefined()
      expect(toolResult!.is_error).toBeFalsy()
      expect(toolResult!.content).toContain('<skill name="pptx" source="test-bundle">')
      expect(toolResult!.content).toContain(SKILL_BODY)
      // And the loop actually called the provider a second time.
      expect(provider.calls.length).toBe(2)
    })

    it('reports an actionable error for an unknown skill name', async () => {
      const provider = new MockProvider([
        {
          toolCalls: [
            { id: 'tu-1', name: 'load_skill', input: { name: 'ghost' } },
          ],
        },
        { text: 'recovered', stopReason: 'end_turn' },
      ])

      const session = await createAgentSession({
        provider,
        skillSources: [makeSource()],
      })

      await session.prompt('Try a non-existent skill')

      const toolResult = findToolResult(session, 'tu-1')
      expect(toolResult).toBeDefined()
      expect(toolResult!.is_error).toBe(true)
      expect(toolResult!.content).toMatch(/Skill "ghost" not found/)
      expect(toolResult!.content).toMatch(/Available: pptx/)
    })

    it('does not register load_skill when there are no skill sources', async () => {
      const provider = new MockProvider([{ text: 'ok', stopReason: 'end_turn' }])
      const session = await createAgentSession({ provider })
      expect(session.registry.has('load_skill')).toBe(false)
    })
  })

  describe("mode: 'all'", () => {
    it('inlines every skill body into the system prompt and skips load_skill', async () => {
      const provider = new MockProvider([{ text: 'ok', stopReason: 'end_turn' }])

      const session = await createAgentSession({
        provider,
        skillSources: [makeSource()],
        skillMode: 'all',
      })

      expect(session.registry.has('load_skill')).toBe(false)

      await session.prompt('Hello')
      const sentSystem = provider.calls[0]!.systemPrompt
      expect(sentSystem).toContain('<skill name="pptx" source="test-bundle">')
      expect(sentSystem).toContain(SKILL_BODY)
      expect(sentSystem).not.toContain('<available-skills>')
    })
  })

  describe('conflict handling', () => {
    it('throws when two sources offer the same skill name', async () => {
      const provider = new MockProvider([])
      const a = createInMemorySkillSource({
        name: 'src-a',
        skills: [{ name: 'dup', description: 'd', body: 'b' }],
      })
      const b = createInMemorySkillSource({
        name: 'src-b',
        skills: [{ name: 'dup', description: 'd', body: 'b' }],
      })

      await expect(
        createAgentSession({ provider, skillSources: [a, b] }),
      ).rejects.toThrow(/Skill name conflict/)
    })
  })

  describe('appendSystemPrompt ordering', () => {
    it('places the skills block before any user-supplied appendSystemPrompt', async () => {
      const provider = new MockProvider([{ text: 'ok', stopReason: 'end_turn' }])
      const session = await createAgentSession({
        provider,
        skillSources: [makeSource()],
        appendSystemPrompt: 'EXTRA-USER-TEXT',
      })

      await session.prompt('Hello')
      const sentSystem = provider.calls[0]!.systemPrompt
      const skillsIdx = sentSystem.indexOf('<available-skills>')
      const extraIdx = sentSystem.indexOf('EXTRA-USER-TEXT')
      expect(skillsIdx).toBeGreaterThan(-1)
      expect(extraIdx).toBeGreaterThan(-1)
      expect(skillsIdx).toBeLessThan(extraIdx)
    })
  })
})

