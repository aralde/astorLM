import type { Tool } from '../types.js'

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/**
 * UI surfaced by a mounted MCP tool that follows the MCP Apps convention
 * (SEP-1865). The `content` string is what the model sees; `structuredContent`
 * and `resourceUri` are the side channel a host uses to render an interactive
 * UI component. They are never injected into the model context by the adapter.
 */
export interface McpToolUi {
  /** Local (prefixed) tool name that produced the UI: `<server>__<tool>`. */
  toolName: string
  /** URI of the UI template resource, e.g. `ui://weather/dashboard`. */
  resourceUri: string
  /** Structured data for the UI. NOT sent to the model (per MCP Apps). */
  structuredContent?: Record<string, unknown>
  /** Text content that was returned to the model. */
  content: string
}

/** Raw shape of an MCP `tools/call` result we care about. */
interface McpToolResult {
  content?: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?: { ui?: { resourceUri?: string } }
}

export interface AdapterOptions {
  serverName: string
  mcpTool: McpToolDescriptor
  callTool: (toolName: string, args: unknown) => Promise<unknown>
  /**
   * Invoked when a tool result carries an MCP Apps UI link
   * (`_meta.ui.resourceUri`). Lets a host render the interactive component
   * without polluting the model context.
   */
  onUi?: (ui: McpToolUi) => void
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
      const result = (await opts.callTool(remoteName, input)) as McpToolResult
      if (result.isError) {
        throw new Error(stringifyContent(result.content) || 'MCP tool reported an error')
      }
      const content = stringifyContent(result.content)

      // MCP Apps (SEP-1865): surface the UI link on the side channel.
      const resourceUri = result._meta?.ui?.resourceUri
      if (resourceUri && opts.onUi) {
        opts.onUi({
          toolName: localName,
          resourceUri,
          structuredContent: result.structuredContent,
          content,
        })
      }

      return content
    },
  }
}

function stringifyContent(content: Array<{ type: string; text?: string }> | undefined): string {
  if (!content) return ''
  return content
    .map((c) => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c)))
    .join('\n')
}
