import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '../types.js'
import { mcpToolToTool } from './adapter.js'
import type { McpToolUi } from './adapter.js'

export type { McpToolUi } from './adapter.js'

export type McpTransportConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }

export interface MountMcpServerOptions {
  /** Local identifier for the server (used as a prefix for the tools: `<name>__<tool>`). */
  name: string
  transport: McpTransportConfig
  clientName?: string
  clientVersion?: string
  /**
   * Invoked whenever one of this server's tools returns an MCP Apps UI link
   * (SEP-1865, `_meta.ui.resourceUri`). The host can read the referenced
   * `ui://` resource with {@link MountedMcpServer.readUiResource} and render it.
   */
  onToolUi?: (ui: McpToolUi) => void
}

/** A `ui://` resource (an HTML UI template per MCP Apps). */
export interface McpUiResource {
  uri: string
  mimeType?: string
  text: string
}

export interface MountedMcpServer {
  readonly name: string
  readonly tools: Tool[]
  /** Read any resource exposed by the server (raw MCP `resources/read`). */
  readResource(uri: string): Promise<unknown>
  /**
   * Read an MCP Apps UI template (`ui://...`) and return its HTML text.
   * Convenience over {@link readResource} for the SEP-1865 render flow.
   */
  readUiResource(uri: string): Promise<McpUiResource>
  close(): Promise<void>
}

/**
 * Connects to an MCP server, lists its tools and adapts them to the library's
 * tool system. Tools are prefixed with `<server>__` to avoid collisions.
 */
export async function mountMcpServer(opts: MountMcpServerOptions): Promise<MountedMcpServer> {
  const transport =
    opts.transport.type === 'stdio'
      ? new StdioClientTransport({
          command: opts.transport.command,
          args: opts.transport.args ?? [],
          env: opts.transport.env as Record<string, string> | undefined,
        })
      : new StreamableHTTPClientTransport(new URL(opts.transport.url), {
          requestInit: { headers: opts.transport.headers },
        })

  const client = new Client(
    { name: opts.clientName ?? 'astorlm', version: opts.clientVersion ?? '0.1.0' },
    { capabilities: {} },
  )

  await client.connect(transport)
  const listed = await client.listTools()

  const tools = listed.tools.map((mcpTool) =>
    mcpToolToTool({
      serverName: opts.name,
      mcpTool,
      onUi: opts.onToolUi,
      callTool: async (toolName, args) => {
        const res = await client.callTool({ name: toolName, arguments: args as Record<string, unknown> })
        return res
      },
    }),
  )

  return {
    name: opts.name,
    tools,
    async readResource(uri: string) {
      return client.readResource({ uri })
    },
    async readUiResource(uri: string): Promise<McpUiResource> {
      const res = (await client.readResource({ uri })) as {
        contents?: Array<{ uri?: string; mimeType?: string; text?: string }>
      }
      const first = res.contents?.[0]
      if (!first || typeof first.text !== 'string') {
        throw new Error(`UI resource ${uri} has no text content`)
      }
      return { uri: first.uri ?? uri, mimeType: first.mimeType, text: first.text }
    },
    async close() {
      await client.close()
    },
  }
}
