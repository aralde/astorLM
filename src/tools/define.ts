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
 * Define una tool tipada. Convierte el schema Zod a JSON Schema una vez,
 * deja la validación en `parseInput` para que el loop pueda fallar limpio
 * antes de ejecutar el `execute`.
 */
export function tool<S extends z.ZodTypeAny>(opts: ToolOptions<S>): Tool {
  const jsonSchema = zodToJsonSchema(opts.schema, { target: 'openApi3' }) as Record<string, unknown>
  // Anthropic espera un objeto con `type: "object"` en el top-level — Zod a veces lo envuelve.
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
  // Algunos wrappers (refs) los desempaquetamos a {} compatible.
  return { type: 'object', properties: {}, ...schema }
}


