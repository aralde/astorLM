import type { Tool } from '../types.js'

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface AdapterOptions {
  serverName: string
  mcpTool: McpToolDescriptor
  callTool: (toolName: string, args: unknown) => Promise<unknown>
}

/**
 * Adapts a tool described by an MCP server into a native `Tool`.
 * The final name is `<serverName>__<originalName>` (Anthropic allows the double underscore).
 * The input is forwarded as-is (MCP already validates on the server side).
 */
export function mcpToolToTool(opts: AdapterOptions): Tool {
  const localName = `${opts.serverName}__${opts.mcpTool.name}`
  const remoteName = opts.mcpTool.name
  const schema = (opts.mcpTool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }

  return {
    name: localName,
    description: opts.mcpTool.description ?? `MCP tool ${remoteName} from ${opts.serverName}`,
    inputSchema: schema,
    parseInput: (raw) => raw,
    execute: async (input) => {
      const result = (await opts.callTool(remoteName, input)) as {
        content?: Array<{ type: string; text?: string }>
        isError?: boolean
      }
      if (result.isError) {
        throw new Error(stringifyContent(result.content) || 'MCP tool reported an error')
      }
      return stringifyContent(result.content)
    },
  }
}

function stringifyContent(content: Array<{ type: string; text?: string }> | undefined): string {
  if (!content) return ''
  return content
    .map((c) => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c)))
    .join('\n')
}
