import type { Tool, ToolContext } from '../types.js'

export interface ToolExecutionResult {
  output: string
  isError: boolean
  durationMs: number
}

/**
 * Tool registry. Lets you register, list and execute tools by name.
 * The loop talks to this class and never to loose tools.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" already registered`)
    }
    this.tools.set(tool.name, tool)
  }

  registerMany(tools: Tool[]): void {
    for (const t of tools) this.register(t)
  }

  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): Tool[] {
    return [...this.tools.values()]
  }

  /** Schemas ready to send to the model. */
  toSchemas(): Array<Pick<Tool, 'name' | 'description' | 'inputSchema'>> {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
  }

  async run(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name)
    const started = performance.now()
    if (!tool) {
      return {
        output: `Unknown tool: "${name}"`,
        isError: true,
        durationMs: performance.now() - started,
      }
    }
    try {
      const input = tool.parseInput(rawInput)
      const output = await tool.execute(input, ctx)
      return { output, isError: false, durationMs: performance.now() - started }
    } catch (err) {
      return {
        output: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        isError: true,
        durationMs: performance.now() - started,
      }
    }
  }
}
