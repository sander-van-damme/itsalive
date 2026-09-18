import { describe, expect, it } from 'vitest';
import { deriveAppName, renameAppRecord, validateAppName } from '../src/shell/core/app-metadata';

describe('validateAppName', () => {
  it('normalizes a supported display name', () => expect(validateAppName('  Practice   Buddy ')).toBe('Practice Buddy'));
  it('rejects empty and overlong names', () => {
    expect(() => validateAppName('   ')).toThrow();
    expect(() => validateAppName('x'.repeat(61))).toThrow();
  });
  it('renames the record without changing its stable id or other data', () => {
    const original = { id: '550e8400-e29b-41d4-a716-446655440005', name: 'Old name', prompt: 'Keep me', updatedAt: 1 };
    expect(renameAppRecord(original, 'Practice Buddy', 99)).toEqual({ ...original, name: 'Practice Buddy', updatedAt: 99 });
    expect(renameAppRecord(original, 'Practice Buddy', 99).id).toBe(original.id);
  });
});


describe('deriveAppName', () => {
  it('removes generic first-run intent instead of naming the app after the sentence prefix', () => {
    expect(deriveAppName('I want an app that teaches me chords, musical chords, and use the violin as the model instrument.')).toBe('Chords');
  });

  it('keeps concise meaningful app descriptions readable', () => {
    expect(deriveAppName('I want to make a meal planner for my family')).toBe('Meal Planner Family');
    expect(deriveAppName('Create a practice timer')).toBe('Practice Timer');
  });
});
