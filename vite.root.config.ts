import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    root: resolve(__dirname, 'sites/root'),
    envDir: __dirname,
    define: { __ROOT_DOMAIN__: JSON.stringify(env.ROOT_DOMAIN || 'localhost:4173') },
    build: { outDir: resolve(__dirname, 'dist-root'), emptyOutDir: true },
    server: { port: 4173, host: true }
  };
});
