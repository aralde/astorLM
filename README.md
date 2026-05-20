# astorlm

Librería agéntica embebible en TypeScript. Inspirada en [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi), pero **SDK-first** (sin CLI/TUI).

> MVP: agent loop + sistema de tools tipadas + provider Anthropic + cliente MCP + sesiones en memoria.

## Anatomía del harness

Las piezas que componen un coding agent:

| Pieza                  | Archivo                              | Qué hace                                                                         |
| ---------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| **Tipos núcleo**       | `src/types.ts`                       | `Message`, `ContentBlock`, `Tool`, `Provider`, `AgentEvent`                      |
| **Agent loop**         | `src/agent/loop.ts`                  | Bucle `provider → tools → provider` hasta `end_turn`                             |
| **AgentSession**       | `src/agent/session.ts`               | API pública: `prompt()`, `abort()`, `subscribe()`, `registerTool()`              |
| **Event bus**          | `src/agent/events.ts`                | Pub/sub para eventos del stream                                                  |
| **Provider Anthropic** | `src/provider/anthropic.ts`          | Streaming Anthropic → `ProviderEvent`s                                           |
| **Provider OpenAI**    | `src/provider/openai.ts`             | Chat Completions + tool_calls (también sirve para Groq/OpenRouter via `baseURL`) |
| **Tools**              | `src/tools/define.ts`, `registry.ts` | `defineTool()` tipado con Zod + JSON Schema + registry                           |
| **Built-in tools**     | `src/tools/builtin/*`                | `read`, `write`, `edit`, `bash`, `grep`, `ls`, `glob`                            |
| **MCP client**         | `src/mcp/client.ts`, `adapter.ts`    | Stdio + HTTP. Cada MCP tool se prefija con `<server>__`                          |
| **System prompt**      | `src/prompt/system.ts`               | Prompt base + carga de `AGENTS.md` / `CLAUDE.md`                                 |
| **Auth**               | `src/auth/storage.ts`                | Resolución `override → env`                                                      |

## Uso mínimo

```ts
import { AnthropicProvider, createAgentSession, createCodingTools } from 'astorlm'

const session = createAgentSession({
  cwd: process.cwd(),
  provider: new AnthropicProvider({ model: 'claude-sonnet-4-6' }),
  tools: createCodingTools(),
})

session.subscribe((e) => {
  if (e.type === 'text_delta') process.stdout.write(e.text)
})

await session.prompt('Listá los archivos .ts del proyecto.')
```

## Cancelación

Hay dos formas equivalentes de cancelar un `prompt()` en vuelo:

```ts
// 1. Método de la sesión (ergonómico para botones "Stop", shutdown, timeouts):
const p = session.prompt('hacé algo largo...')
session.abort()
await p.catch((e) => { if (e.name !== 'AbortError') throw e })

// 2. AbortSignal externo (útil si ya tenés un AbortController propio):
const ctrl = new AbortController()
session.prompt('...', { abortSignal: ctrl.signal })
ctrl.abort()
```

`session.abort()` es no-op si no hay prompt en vuelo. El loop propaga la cancelación al provider y al `bash` tool, y emite `session_end` con `reason: 'aborted'`.

## Tools custom

```ts
import { defineTool } from 'astorlm'
import { z } from 'zod'

const sumar = defineTool({
  name: 'sumar',
  description: 'Suma dos números',
  schema: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }) => String(a + b),
})

session.registerTool(sumar)
```

## MCP

```ts
import { mountMcpServer } from 'astorlm'

const server = await mountMcpServer({
  name: 'fs',
  transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
})

const session = createAgentSession({
  provider,
  tools: [...createCodingTools(), ...server.tools],
})
```

## Eventos

Subscribite vía `session.subscribe(listener)`. Eventos:

- `turn_start` / `turn_end`
- `text_delta` — chunks de texto del assistant
- `assistant_message` — mensaje final del turno
- `tool_execution_start` / `tool_execution_end`
- `session_end`

## Scripts

```bash
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
pnpm build         # tsup → dist/

ANTHROPIC_API_KEY=... pnpm example:basic
ANTHROPIC_API_KEY=... pnpm example:mcp
```

## Roadmap (post-MVP)

- Persistencia JSONL de sesiones con branching (id/parentId).
- Compaction automática del historial al acercarse al límite.
- Extensions/Skills cargables desde FS.
- 
- Modos `print`/`rpc` sobre el SDK.
- Steering / queueing durante el stream.
- Settings global + por proyecto.
