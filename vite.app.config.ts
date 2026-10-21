import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({
  root: resolve(import.meta.dirname, "sites/app"),
  build: {
    outDir: resolve(import.meta.dirname, "dist-app"),
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 4174,
    strictPort: true,
    hmr: process.env.ITSALIVE_E2E ? false : undefined,
    allowedHosts: [".localhost"],
    fs: { allow: [import.meta.dirname] },
  },
});
