const DEFAULT_SYSTEM_PROMPT = `Sos un agente de coding embebido. Trabajás dentro de un cwd dado.
- Usá las herramientas para inspeccionar y modificar el filesystem; no inventes contenido de archivos.
- Antes de editar un archivo, leelo si no lo viste antes.
- Si una tool falla, leé el error y ajustá el approach; no repitas la misma llamada.
- Respondé en el idioma del usuario. Sé conciso.`

export interface BuildSystemPromptOptions {
  cwd: string
  /** Reemplazo total del prompt por defecto. */
  systemPrompt?: string
  /** Texto adicional que se concatena al final del prompt (sea default o custom). */
  appendSystemPrompt?: string
  /** Archivos de contexto a cargar desde cwd. Por defecto AGENTS.md y CLAUDE.md. */
  contextFiles?: string[]
  /** Cargador de archivos asíncrono para leer archivos de contexto. */
  fileReader?: (path: string) => Promise<string | null>
}

export async function buildSystemPrompt(opts: BuildSystemPromptOptions): Promise<string> {
  const parts: string[] = [opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT]
  parts.push(`\n\n<cwd>${opts.cwd}</cwd>`)

  const files = opts.contextFiles ?? ['AGENTS.md', 'CLAUDE.md']
  if (opts.fileReader) {
    for (const f of files) {
      const content = await opts.fileReader(f).catch(() => null)
      if (content) {
        parts.push(`\n\n<context file="${f}">\n${content}\n</context>`)
      }
    }
  }

  if (opts.appendSystemPrompt) parts.push(`\n\n${opts.appendSystemPrompt}`)

  return parts.join('')
}

export { DEFAULT_SYSTEM_PROMPT }
