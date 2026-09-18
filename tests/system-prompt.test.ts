import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../src/shell/core/system-prompt';

describe('SYSTEM_PROMPT code examples', () => {
  it('use plain JavaScript rather than TypeScript syntax', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\.querySelector(?:All)?\s*</);
    expect(SYSTEM_PROMPT).not.toMatch(/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:/);
    expect(SYSTEM_PROMPT).not.toMatch(/\s+as\s+[A-Z][A-Za-z0-9_$]*(?:<[^>]+>)?/);
  });

  it('defines the canonical generated-app root as an invariant', () => {
    expect(SYSTEM_PROMPT).toContain('#itsalive-root');
    expect(SYSTEM_PROMPT).toContain('Do not remove or replace #itsalive-root');
  });
});
