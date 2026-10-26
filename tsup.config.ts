import { defineConfig } from 'tsup'

// Ships CommonJS (require) and ESM (import), each with its own type declarations.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
})
