import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  // Keep native / CJS-only modules external — resolved at runtime from node_modules
  external: ['better-sqlite3', 'http-proxy'],
  // Inline everything else so the bridge is a single file
  noExternal: [],
});
