import { describe, expect, it } from 'vitest';
import { renameAppRecord, validateAppName } from '../src/shell/core/app-metadata';

describe('validateAppName', () => {
  it('normalizes a supported display name', () => expect(validateAppName('  Practice   Buddy ')).toBe('Practice Buddy'));
  it('rejects empty and overlong names', () => {
    expect(() => validateAppName('   ')).toThrow();
    expect(() => validateAppName('x'.repeat(61))).toThrow();
  });
  it('renames the record without changing its stable id or other data', () => {
    const original = { id: 'practice-app', name: 'Old name', prompt: 'Keep me', updatedAt: 1 };
    expect(renameAppRecord(original, 'Practice Buddy', 99)).toEqual({ ...original, name: 'Practice Buddy', updatedAt: 99 });
    expect(renameAppRecord(original, 'Practice Buddy', 99).id).toBe(original.id);
  });
});
