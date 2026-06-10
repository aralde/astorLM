import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/core.ts',
    'src/tools/index.ts',
    'src/prompt/index.ts',
    'src/embeddings/index.ts',
    'src/experimental/error-registry/index.ts',
    'src/experimental/contract/index.ts',
    'src/experimental/wasm-runner/index.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  splitting: false,
  // Keep the optional WASM runtime out of the bundle: it is dynamically
  // imported and ships its own .wasm assets that must be resolved from the
  // consumer's node_modules, not inlined into dist/.
  external: ['quickjs-emscripten', /^@jitl\/quickjs-/],
})
