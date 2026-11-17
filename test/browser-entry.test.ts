import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = resolve(root, 'src/browser.ts')

const nodeBuiltins = new Set(builtinModules.map((m) => m.replace(/^node:/, '').split('/')[0]!))

const specifierPattern =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

function resolveLocal(from: string, spec: string): string {
  const base = resolve(dirname(from), spec)
  const candidates = [base.replace(/\.js$/, '.ts'), base + '.ts', resolve(base, 'index.ts')]
  const found = candidates.find((c) => existsSync(c))
  if (!found) throw new Error(`Cannot resolve ${spec} from ${from}`)
  return found
}

function scan(): { files: string[]; offenders: string[] } {
  const seen = new Set<string>()
  const offenders: string[] = []
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(specifierPattern)) {
      const spec = match[1]!
      if (spec.startsWith('.')) {
        queue.push(resolveLocal(file, spec))
      } else if (spec.startsWith('node:') || nodeBuiltins.has(spec.split('/')[0]!)) {
        offenders.push(`${file.slice(root.length + 1)} -> ${spec}`)
      }
    }
  }
  return { files: [...seen], offenders }
}

describe('browser entry point', () => {
  it('reaches the loop, providers and runner', () => {
    const { files } = scan()
    const rel = files.map((f) => f.slice(root.length + 1))
    expect(rel).toContain('src/agent/loop.ts')
    expect(rel).toContain('src/provider/openai.ts')
    expect(rel).toContain('src/experimental/wasm-runner/quickjs.ts')
  })

  it('imports no node:* module, directly or transitively', () => {
    expect(scan().offenders).toEqual([])
  })

  it('exposes the browser API', async () => {
    const mod = await import('../src/browser.js')
    for (const name of [
      'createAgent',
      'tool',
      'OpenAIProvider',
      'AnthropicProvider',
      'QuickJsCodeRunner',
      'createCodeRunnerTool',
    ]) {
      expect(mod).toHaveProperty(name)
    }
  })
})
