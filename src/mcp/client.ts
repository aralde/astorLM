import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '../types.js'
import { mcpToolToTool } from './adapter.js'

export type McpTransportConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }

export interface MountMcpServerOptions {
  /** Identificador local del server (se usa de prefijo de las tools: `<name>__<tool>`). */
  name: string
  transport: McpTransportConfig
  clientName?: string
  clientVersion?: string
}

export interface MountedMcpServer {
  readonly name: string
  readonly tools: Tool[]
  close(): Promise<void>
}

/**
 * Conecta a un servidor MCP, lista sus tools y las adapta al sistema de tools
 * de la librería. Las tools se prefijan con `<server>__` para evitar colisiones.
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
      callTool: async (toolName, args) => {
        const res = await client.callTool({ name: toolName, arguments: args as Record<string, unknown> })
        return res
      },
    }),
  )

  return {
    name: opts.name,
    tools,
    async close() {
      await client.close()
    },
  }
}
