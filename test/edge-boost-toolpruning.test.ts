import { describe, expect, it, vi } from 'vitest'
import { buildToolPruningHook } from '../src/experimental/edge-boost/toolPruning.js'
import { resolveEdgeBoostTuning } from '../src/experimental/edge-boost/types.js'
import type { Embedder } from '../src/embeddings/types.js'
import type { Message } from '../src/types.js'

// Deterministic fake embedder: a bag-of-words vector over a fixed vocabulary, so
// cosine similarity ranks by shared keywords.
const VOCAB = ['search', 'weather', 'file', 'math', 'plan']
const vec = (text: string): number[] => {
  const t = text.toLowerCase()
  return VOCAB.map((w) => (t.includes(w) ? 1 : 0))
}

function makeEmbedder(opts: { fail?: boolean } = {}) {
  let embed = 0
  let embedMany = 0
  const embedder: Embedder = {
    model: 'fake',
    async embed(text) {
      embed++
      if (opts.fail) throw new Error('embedder down')
      return { embedding: vec(text) }
    },
    async embedMany(texts) {
      embedMany++
      if (opts.fail) throw new Error('embedder down')
      return { embeddings: texts.map(vec) }
    },
  }
  return { embedder, counts: () => ({ embed, embedMany }) }
}

const toolsA = [
  { name: 'search', description: 'search the web', inputSchema: {} },
  { name: 'weather', description: 'get the weather forecast', inputSchema: {} },
  { name: 'file', description: 'read a file', inputSchema: {} },
  { name: 'math', description: 'do math calculations', inputSchema: {} },
  { name: 'plan', description: 'planning helper', inputSchema: {} },
]

const userMsg = (text: string): Message[] => [{ role: 'user', content: [{ type: 'text', text }] }]
const ctx = (tools: typeof toolsA, messages: Message[]) => ({
  messages,
  systemPrompt: 'sys',
  tools,
  cwd: '/',
})

describe('semantic tool pruning', () => {
  it('exposes only the top-K relevant tools', async () => {
    const { embedder } = makeEmbedder()
    const hook = buildToolPruningHook({ embedder, topK: 2, alwaysKeep: [] })
    const res = await hook(ctx(toolsA, userMsg('what is the weather today')))
    expect(res.tools).toHaveLength(2)
    expect(res.tools!.map((t) => t.name)).toContain('weather')
  })

  it('always keeps names in alwaysKeep', async () => {
    const { embedder } = makeEmbedder()
    const hook = buildToolPruningHook({ embedder, topK: 1, alwaysKeep: ['plan'] })
    const res = await hook(ctx(toolsA, userMsg('what is the weather today')))
    const names = res.tools!.map((t) => t.name)
    expect(names).toContain('weather') // top hit
    expect(names).toContain('plan') // always kept
  })

  it('rebuilds the index when the tool name-set changes', async () => {
    const { embedder, counts } = makeEmbedder()
    const hook = buildToolPruningHook({ embedder, topK: 2, alwaysKeep: [] })
    await hook(ctx(toolsA, userMsg('weather please')))
    const toolsB = toolsA.map((t) => ({ ...t, name: t.name + '_v2' }))
    await hook(ctx(toolsB, userMsg('weather please')))
    expect(counts().embedMany).toBe(2) // one build per distinct name-set
  })

  it('does not rebuild when the name-set is unchanged', async () => {
    const { embedder, counts } = makeEmbedder()
    const hook = buildToolPruningHook({ embedder, topK: 2, alwaysKeep: [] })
    await hook(ctx(toolsA, userMsg('weather please')))
    await hook(ctx(toolsA, userMsg('weather again')))
    expect(counts().embedMany).toBe(1)
  })

  it('passes tools through unpruned when the embedder fails (warn once)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { embedder } = makeEmbedder({ fail: true })
      const hook = buildToolPruningHook({ embedder, topK: 2, alwaysKeep: [] })
      const res1 = await hook(ctx(toolsA, userMsg('weather please')))
      const res2 = await hook(ctx(toolsA, userMsg('weather please')))
      expect(res1.tools).toBe(toolsA)
      expect(res2.tools).toBe(toolsA)
      expect(warn).toHaveBeenCalledTimes(1) // warned once, not per call
    } finally {
      warn.mockRestore()
    }
  })

  it('is a no-op when tools already fit within topK', async () => {
    const { embedder, counts } = makeEmbedder()
    const hook = buildToolPruningHook({ embedder, topK: 10, alwaysKeep: [] })
    const res = await hook(ctx(toolsA, userMsg('weather please')))
    expect(res.tools).toBe(toolsA)
    expect(counts().embedMany).toBe(0) // never touched the embedder
  })

  it('resolves toolPruning as disabled by default and enabled when provided', () => {
    expect(resolveEdgeBoostTuning().toolPruning).toBeNull()
    const { embedder } = makeEmbedder()
    const resolved = resolveEdgeBoostTuning({ toolPruning: { embedder } })
    expect(resolved.toolPruning).toMatchObject({ topK: 6, alwaysKeep: [] })
  })
})
