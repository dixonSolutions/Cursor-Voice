import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: {
    outDir: '../web/dist',
    emptyOutDir: true,
  },
});
