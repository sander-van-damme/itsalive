import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../src/shell/core/system-prompt';

describe('SYSTEM_PROMPT code examples', () => {
  it('use plain JavaScript rather than TypeScript syntax', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\.querySelector(?:All)?\s*</);
    expect(SYSTEM_PROMPT).not.toMatch(/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:/);
    expect(SYSTEM_PROMPT).not.toMatch(/\s+as\s+[A-Z][A-Za-z0-9_$]*(?:<[^>]+>)?/);
  });

  it('requires completion messages to use plain user-facing language', () => {
    expect(SYSTEM_PROMPT).toContain('shown directly to the user');
    expect(SYSTEM_PROMPT).toContain('Do not mention implementation details');
    expect(SYSTEM_PROMPT).toContain('AudioContext');
    expect(SYSTEM_PROMPT).toContain('prefers-reduced-motion');
  });

  it('keeps behavioral history out of the generated app document', () => {
    expect(SYSTEM_PROMPT).toContain('behavioral summaries');
    expect(SYSTEM_PROMPT).not.toContain('itsalive-history');
  });

  it('documents shell-backed log lookup as asynchronous', () => {
    expect(SYSTEM_PROMPT).toContain('await itsalive.logs.get(...)');
  });

  it('defines the canonical generated-app root as an invariant', () => {
    expect(SYSTEM_PROMPT).toContain('#itsalive-root');
    expect(SYSTEM_PROMPT).toContain('Do not remove or replace #itsalive-root');
  });

  it('defines a safe staged-construction contract', () => {
    expect(SYSTEM_PROMPT).toContain('data-itsalive-building');
    expect(SYSTEM_PROMPT).toContain('inert');
    expect(SYSTEM_PROMPT).toContain('aria-busy="true"');
    expect(SYSTEM_PROMPT).toContain('visible inert scaffold → primary behavior');
    expect(SYSTEM_PROMPT).toContain('min-height: 100dvh');
  });

  it('ships a platform-owned frosted treatment for unfinished generated UI', () => {
    const runtimeAssets = readFileSync(new URL('../src/runtime/assets.ts', import.meta.url), 'utf8');
    const appShell = readFileSync(new URL('../sites/app/index.html', import.meta.url), 'utf8');
    expect(runtimeAssets).toContain('#itsalive-root [data-itsalive-building]');
    expect(runtimeAssets).toContain('content: "Building…"');
    expect(runtimeAssets).toContain('backdrop-filter: blur(4px)');
    expect(appShell).toContain('min-height:100dvh');
  });
});
