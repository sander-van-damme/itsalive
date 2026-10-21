import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({
  root: resolve(import.meta.dirname, "sites/root"),
  publicDir: resolve(import.meta.dirname, "public"),
  build: {
    outDir: resolve(import.meta.dirname, "dist-root"),
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
    hmr: process.env.ITSALIVE_E2E ? false : undefined,
    allowedHosts: [".localhost"],
    fs: { allow: [import.meta.dirname] },
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@swc/wasm-web", "esbuild-wasm"] },
});
