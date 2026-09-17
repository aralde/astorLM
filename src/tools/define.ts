import type { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { Tool, ToolContext } from '../types.js'

export interface ToolOptions<S extends z.ZodTypeAny> {
  name: string
  description: string
  schema: S
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<string> | string
}

/**
 * Defines a typed tool. Converts the Zod schema to JSON Schema once, and leaves
 * validation in `parseInput` so the loop can fail cleanly before running
 * `execute`.
 */
export function tool<S extends z.ZodTypeAny>(opts: ToolOptions<S>): Tool {
  const jsonSchema = zodToJsonSchema(opts.schema, { target: 'openApi3' }) as Record<string, unknown>
  // Anthropic expects an object with a top-level `type: "object"`; Zod sometimes wraps it.
  const inputSchema = normalizeSchema(jsonSchema)

  return {
    name: opts.name,
    description: opts.description,
    inputSchema,
    parseInput: (raw) => opts.schema.parse(raw),
    execute: async (input, ctx) => opts.execute(input as z.infer<S>, ctx),
  }
}

function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema['type'] === 'object') return schema
  // Some wrappers (refs) are unwrapped into a compatible {}.
  return { type: 'object', properties: {}, ...schema }
}


