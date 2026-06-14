import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  // Keep native modules external — they are resolved at runtime
  external: ['better-sqlite3'],
  // Inline everything else so the bridge is a single file
  noExternal: [],
});
