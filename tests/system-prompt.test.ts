import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../src/shell/core/system-prompt';

describe('SYSTEM_PROMPT code examples', () => {
  it('use plain JavaScript rather than TypeScript syntax', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\.querySelector(?:All)?\s*</);
    expect(SYSTEM_PROMPT).not.toMatch(/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:/);
    expect(SYSTEM_PROMPT).not.toMatch(/\s+as\s+[A-Z][A-Za-z0-9_$]*(?:<[^>]+>)?/);
    expect(SYSTEM_PROMPT).not.toMatch(/\b[A-Za-z_$][\w$]*\?\s*[,}]/);
  });

  it('requires a complete atomic JavaScript program rather than streamed delimiters', () => {
    expect(SYSTEM_PROMPT).toContain('exactly one complete executable JavaScript program per model turn');
    expect(SYSTEM_PROMPT).toContain('No partial response is executed');
    expect(SYSTEM_PROMPT).toContain('captured console output');
    expect(SYSTEM_PROMPT).not.toContain('/* itsalive:command */');
    expect(SYSTEM_PROMPT).not.toContain('/* itsalive:end */');
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

  it('documents the typed public application and coding-agent API without provider internals', () => {
    expect(SYSTEM_PROMPT).toContain("AVAILABLE PLATFORM APIs");
    expect(SYSTEM_PROMPT).toContain("agent.screenshot(input?: { scale?: number }): Promise<string>");
    expect(SYSTEM_PROMPT).toContain("application.store: JsonObject");
    expect(SYSTEM_PROMPT).toContain("application.ai.choose<T extends string>");
    expect(SYSTEM_PROMPT).toContain("application.ai.score(question: string, levels: string[], context?: JsonValue): Promise<number | null>");
    expect(SYSTEM_PROMPT).toContain("application.ai.decide(question: string, context?: JsonValue): Promise<boolean | null>");
    expect(SYSTEM_PROMPT).toContain("undefined, functions, class instances");
    expect(SYSTEM_PROMPT).not.toContain("Jev");
    expect(SYSTEM_PROMPT).not.toContain("provider-specific");
  });

  it('defines the canonical generated-app root as an invariant', () => {
    expect(SYSTEM_PROMPT).toContain('#itsalive-root');
    expect(SYSTEM_PROMPT).toContain('Do not remove or replace #itsalive-root');
  });

  it('defines a safe staged-construction contract', () => {
    expect(SYSTEM_PROMPT).toContain('data-itsalive-building');
    expect(SYSTEM_PROMPT).toContain('do not make the whole component inert');
    expect(SYSTEM_PROMPT).toContain('data-itsalive-build-owner="shell"');
    expect(SYSTEM_PROMPT).toContain('They do not disable the component');
    expect(SYSTEM_PROMPT).toContain('aria-busy');
    expect(SYSTEM_PROMPT).toContain('inspect → make one coherent change → inspect/verify');
    expect(SYSTEM_PROMPT).toContain('min-height: 100dvh');
  });

  it('ships a quiet platform-owned region treatment for unfinished generated UI', () => {
    const runtimeAssets = readFileSync(new URL('../src/runtime/assets.ts', import.meta.url), 'utf8');
    const appShell = readFileSync(new URL('../sites/app/index.html', import.meta.url), 'utf8');
    expect(runtimeAssets).toContain('#itsalive-root [data-itsalive-building]');
    expect(runtimeAssets).toContain('data-itsalive-build-state="queued"');
    expect(runtimeAssets).not.toContain('content: "Building…"');
    expect(runtimeAssets).not.toContain('backdrop-filter');
    expect(runtimeAssets).not.toContain('@keyframes');
    expect(appShell).toContain('min-height:100dvh');
  });
});
