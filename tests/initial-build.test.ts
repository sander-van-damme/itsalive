import { describe, expect, it } from 'vitest';
import { InitialBuildIntent } from '../src/shell/core/initial-build';

const APP_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('InitialBuildIntent', () => {
  it('retains preparation through failures and transient active runs, then starts exactly once after acceptance', () => {
    const intent = new InitialBuildIntent();
    intent.schedule(APP_ID);
    expect(intent.candidate(APP_ID, false, false)).toBeUndefined();
    expect(intent.candidate(APP_ID, true, true)).toBeUndefined();
    expect(intent.candidate(APP_ID, true, false)).toBe(APP_ID);
    expect(intent.candidate(APP_ID, true, false)).toBe(APP_ID);
    intent.accepted(APP_ID);
    expect(intent.candidate(APP_ID, true, false)).toBeUndefined();
  });

  it('does not offer a pending build to another selected app and clears it on deletion', () => {
    const intent = new InitialBuildIntent();
    intent.schedule(APP_ID);
    expect(intent.candidate('550e8400-e29b-41d4-a716-446655440001', true, false)).toBeUndefined();
    intent.clear(APP_ID);
    expect(intent.candidate(APP_ID, true, false)).toBeUndefined();
  });
});
