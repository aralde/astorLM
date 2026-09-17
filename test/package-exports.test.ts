import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Guards the packaging contract.
 *
 * `tsup.config.ts` (what gets built) and `package.json#exports` (what consumers
 * may import) were maintained by hand, with nothing tying them together. Four
 * modules — tracing, metrics, replay and evals — existed in `src/`, were
 * documented in the README, and were in neither list: they never reached
 * `dist/`, so importing them failed with ERR_PACKAGE_PATH_NOT_EXPORTED.
 *
 * These tests fail before a release rather than after one.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, { types: string; import: string; require: string }>
  files: string[]
}

/** The `entry: [...]` array from the tsup config, read as text to avoid loading the build tooling. */
function tsupEntries(): string[] {
  const source = readFileSync(join(root, 'tsup.config.ts'), 'utf8')
  const block = /entry:\s*\[([^\]]*)\]/.exec(source)
  if (!block) throw new Error('Could not find the entry array in tsup.config.ts')
  return [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

/** `src/foo/index.ts` -> `./foo`, `src/core.ts` -> `./core`, `src/index.ts` -> `.` */
function entryToSubpath(entry: string): string {
  const rest = entry
    .replace(/^src\//, '')
    .replace(/\/index\.ts$/, '')
    .replace(/\.ts$/, '')
  return rest === 'index' || rest === '' ? '.' : `./${rest}`
}

/** Every directory under `src/experimental/` that exposes an `index.ts`. */
function experimentalModules(): string[] {
  const dir = join(root, 'src', 'experimental')
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'index.ts')))
    .map((e) => e.name)
}

describe('packaging contract', () => {
  const entries = tsupEntries()

  it('builds every entry listed in the tsup config', () => {
    for (const entry of entries) {
      expect(existsSync(join(root, entry)), `${entry} is listed as an entry but does not exist`).toBe(
        true,
      )
    }
  })

  it('exports every built entry', () => {
    const exported = Object.keys(pkg.exports)
    for (const entry of entries) {
      const subpath = entryToSubpath(entry)
      expect(exported, `${entry} is built but not reachable as "${subpath}"`).toContain(subpath)
    }
  })

  it('builds everything it exports', () => {
    const built = new Set(entries.map(entryToSubpath))
    for (const subpath of Object.keys(pkg.exports)) {
      expect(built, `"${subpath}" is exported but nothing builds it`).toContain(subpath)
    }
  })

  it('points every export at the file its entry produces', () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const base = subpath === '.' ? './dist/index' : `./dist/${subpath.slice(2)}/index`
      // The root and the single-file barrels emit `dist/<name>.js`, the rest
      // emit `dist/<dir>/index.js`; accept whichever the entry implies.
      const entry = entries.find((e) => entryToSubpath(e) === subpath)!
      const expected = entry.endsWith('/index.ts')
        ? base
        : `./dist/${entry.replace(/^src\//, '').replace(/\.ts$/, '')}`

      expect(target.import, `"${subpath}" import`).toBe(`${expected}.js`)
      expect(target.require, `"${subpath}" require`).toBe(`${expected}.cjs`)
      expect(target.types, `"${subpath}" types`).toBe(`${expected}.d.ts`)
    }
  })

  it('ships every experimental module that has a public entry point', () => {
    const exported = Object.keys(pkg.exports)
    for (const name of experimentalModules()) {
      expect(
        exported,
        `src/experimental/${name}/index.ts looks public but "./experimental/${name}" is not exported`,
      ).toContain(`./experimental/${name}`)
    }
  })

  it('includes the files a consumer needs in the published tarball', () => {
    for (const required of ['dist', 'README.md', 'LICENSE']) {
      expect(pkg.files).toContain(required)
    }
  })
})
