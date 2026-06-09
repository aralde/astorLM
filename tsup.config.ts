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
    'src/experimental/tracing/index.ts',
    'src/experimental/tracing/otel/index.ts',
    'src/experimental/metrics/index.ts',
    'src/experimental/replay/index.ts',
    'src/experimental/evals/index.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  splitting: false,
})
