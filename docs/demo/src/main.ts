import { newQuickJSWASMModule } from 'quickjs-emscripten'
import variant from '@jitl/quickjs-singlefile-browser-release-sync'
import { z } from 'zod'
import {
  createAgent,
  tool,
  OpenAIProvider,
  QuickJsCodeRunner,
  createCodeRunnerTool,
} from '../../../src/browser.js'
import type { AgentEvent, Tool } from '../../../src/browser.js'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const form = $<HTMLFormElement>('form')
const logEl = $<HTMLElement>('log')
const filesEl = $<HTMLElement>('files')
const runBtn = $<HTMLButtonElement>('run')
const stopBtn = $<HTMLButtonElement>('stop')

const files = new Map<string, string>()
const runner = new QuickJsCodeRunner({ module: newQuickJSWASMModule(variant) })

const SYSTEM_PROMPT =
  'You are a coding agent running inside a browser tab. You have no shell and no network. ' +
  'Use write_file to create files in an in-memory workspace, run_file or run_code to execute ' +
  'JavaScript in a sandbox, and read_file / list_files to inspect the workspace. ' +
  'Print results with console.log. Write a small script, run it, then report what it printed.'

function renderFiles(): void {
  filesEl.replaceChildren()
  if (files.size === 0) {
    filesEl.textContent = '(empty)'
    return
  }
  for (const [name, content] of files) {
    const d = document.createElement('details')
    const s = document.createElement('summary')
    s.textContent = `${name} (${content.length} B)`
    const pre = document.createElement('pre')
    pre.textContent = content
    d.append(s, pre)
    filesEl.append(d)
  }
}

function buildTools(): Tool[] {
  const writeFile = tool({
    name: 'write_file',
    description: 'Create or overwrite a file in the in-memory workspace.',
    schema: z.object({ path: z.string().min(1), content: z.string() }),
    execute: ({ path, content }) => {
      files.set(path, content)
      renderFiles()
      return `Wrote ${content.length} bytes to ${path}`
    },
  })
  const readFile = tool({
    name: 'read_file',
    description: 'Read a file from the in-memory workspace.',
    schema: z.object({ path: z.string().min(1) }),
    execute: ({ path }) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`No such file: ${path}`)
      return content
    },
  })
  const listFiles = tool({
    name: 'list_files',
    description: 'List the files in the in-memory workspace.',
    schema: z.object({}),
    execute: () => (files.size ? [...files.keys()].join('\n') : '(empty)'),
  })
  const runFile = tool({
    name: 'run_file',
    description: 'Run a JavaScript file from the workspace in the WASM sandbox. No fs, network or imports.',
    schema: z.object({ path: z.string().min(1) }),
    execute: async ({ path }, ctx) => {
      const code = files.get(path)
      if (code === undefined) throw new Error(`No such file: ${path}`)
      const r = await runner.run({ code, abortSignal: ctx.abortSignal })
      const parts: string[] = []
      if (r.stdout) parts.push(r.stdout.trimEnd())
      if (!r.ok && r.error) parts.push(`[error] ${r.error}`)
      else if (r.value !== undefined) parts.push(`[result] ${r.value}`)
      if (r.stderr) parts.push(`[stderr] ${r.stderr.trimEnd()}`)
      return parts.join('\n') || '[no output]'
    },
  })
  return [writeFile, readFile, listFiles, runFile, createCodeRunnerTool({ runner })]
}

function addLine(kind: string, label: string, body: string): HTMLElement {
  const row = document.createElement('div')
  row.className = `line ${kind}`
  const tag = document.createElement('span')
  tag.className = 'tag'
  tag.textContent = label
  const pre = document.createElement('pre')
  pre.textContent = body
  row.append(tag, pre)
  logEl.append(row)
  row.scrollIntoView({ block: 'nearest' })
  return row
}

let streaming: HTMLPreElement | null = null

function onEvent(e: AgentEvent): void {
  if (e.type !== 'text_delta') streaming = null
  switch (e.type) {
    case 'turn_start':
      addLine('turn', `turn ${e.turn}`, 'calling the model')
      break
    case 'text_delta': {
      if (!streaming) streaming = addLine('text', 'model', '').querySelector('pre')
      streaming!.textContent += e.text
      break
    }
    case 'tool_execution_start':
      addLine('tool', `tool: ${e.name}`, JSON.stringify(e.input, null, 2))
      break
    case 'tool_execution_end':
      addLine(e.isError ? 'error' : 'result', `result (${e.durationMs} ms)`, e.output)
      break
    case 'provider_retry':
      addLine('error', 'retry', `attempt ${e.attempt}/${e.maxAttempts} in ${e.delayMs} ms`)
      break
    case 'session_end':
      addLine('turn', 'done', e.reason)
      break
  }
}

let controller: AbortController | null = null

form.addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const data = new FormData(form)
  const baseURL = String(data.get('baseURL')).trim()
  const apiKey = String(data.get('apiKey')).trim() || 'none'
  const model = String(data.get('model')).trim()
  const task = String(data.get('task')).trim()
  if (!baseURL || !model || !task) return

  files.clear()
  renderFiles()
  logEl.replaceChildren()
  addLine('user', 'you', task)
  runBtn.disabled = true
  stopBtn.disabled = false
  controller = new AbortController()

  try {
    const agent = await createAgent({
      provider: new OpenAIProvider({ model, baseURL, apiKey, dangerouslyAllowBrowser: true }),
      tools: buildTools(),
      systemPrompt: SYSTEM_PROMPT,
      maxTurns: 12,
    })
    agent.on('event', onEvent)
    await agent.run(task, { abortSignal: controller.signal })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const hint = /fetch|network|connection/i.test(msg)
      ? '\nThe request may have been blocked by CORS: the endpoint must allow this origin.'
      : ''
    addLine('error', 'error', msg + hint)
  } finally {
    runBtn.disabled = false
    stopBtn.disabled = true
    controller = null
  }
})

stopBtn.addEventListener('click', () => controller?.abort())
renderFiles()
