import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname, 'sites/root'),
  build: { outDir: resolve(__dirname, 'dist-root'), emptyOutDir: true },
  server: { port: 4173, host: true }
});
