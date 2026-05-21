import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/node.ts', 'src/tools/node.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  splitting: false,
})
