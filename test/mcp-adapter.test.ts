import { describe, it, expect, vi } from 'vitest'
import { mcpToolToTool } from '../src/mcp/adapter.js'
import type { McpToolUi } from '../src/mcp/adapter.js'
import type { ToolContext } from '../src/types.js'

const ctx = {} as ToolContext // the MCP adapter ignores the context

function makeTool(callResult: unknown, onUi?: (ui: McpToolUi) => void) {
  return mcpToolToTool({
    serverName: 'docs',
    mcpTool: { name: 'semantic_search', inputSchema: { type: 'object', properties: {} } },
    callTool: async () => callResult,
    onUi,
  })
}

describe('mcpToolToTool — MCP Apps UI surfacing', () => {
  it('prefixes the tool name with the server', () => {
    const tool = makeTool({ content: [{ type: 'text', text: 'ok' }] })
    expect(tool.name).toBe('docs__semantic_search')
  })

  it('returns text content to the model', async () => {
    const tool = makeTool({ content: [{ type: 'text', text: 'hello' }] })
    await expect(tool.execute({}, ctx)).resolves.toBe('hello')
  })

  it('fires onUi with the payload when _meta.ui.resourceUri is present', async () => {
    const onUi = vi.fn()
    const tool = makeTool(
      {
        content: [{ type: 'text', text: 'summary' }],
        structuredContent: { query: 'q', hits: [{ id: 'a' }] },
        _meta: { ui: { resourceUri: 'ui://semantic/results' } },
      },
      onUi,
    )
    await tool.execute({}, ctx)
    expect(onUi).toHaveBeenCalledTimes(1)
    expect(onUi).toHaveBeenCalledWith({
      toolName: 'docs__semantic_search',
      resourceUri: 'ui://semantic/results',
      structuredContent: { query: 'q', hits: [{ id: 'a' }] },
      content: 'summary',
    })
  })

  it('does not fire onUi when there is no UI link', async () => {
    const onUi = vi.fn()
    const tool = makeTool({ content: [{ type: 'text', text: 'plain' }] }, onUi)
    await tool.execute({}, ctx)
    expect(onUi).not.toHaveBeenCalled()
  })

  it('throws on isError results and never fires onUi', async () => {
    const onUi = vi.fn()
    const tool = makeTool(
      { isError: true, content: [{ type: 'text', text: 'boom' }], _meta: { ui: { resourceUri: 'ui://x' } } },
      onUi,
    )
    await expect(tool.execute({}, ctx)).rejects.toThrow('boom')
    expect(onUi).not.toHaveBeenCalled()
  })
})
