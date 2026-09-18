import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

function buildCommit(): string {
  const ciCommit = process.env.CF_PAGES_COMMIT_SHA ?? process.env.GITHUB_SHA;
  if (ciCommit?.trim()) return ciCommit.trim();

  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  root: resolve(__dirname, 'sites/root'),
  define: { __ITSALIVE_COMMIT__: JSON.stringify(buildCommit()) },
  build: { outDir: resolve(__dirname, 'dist-root'), emptyOutDir: true },
  server: { port: 4173, host: true }
});
