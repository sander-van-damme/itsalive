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
  it('keeps short direct descriptions concise', () => {
    expect(deriveAppName('a stopwatch')).toBe('Stopwatch');
    expect(deriveAppName('Create a practice timer')).toBe('Practice Timer');
    expect(deriveAppName('I want a calculator')).toBe('Calculator');
  });

  it('removes creation and helper phrasing before naming the app', () => {
    expect(deriveAppName('I want an app that teaches me chords, musical chords, and use the violin as the model instrument.')).toBe('Chords');
    expect(deriveAppName('Could you create an app that helps users track expenses?')).toBe('Expense Tracker');
    expect(deriveAppName('Build me something that lets me organize household tasks.')).toBe('Household Task Organizer');
  });

  it('turns common action intents into noun-like app titles', () => {
    expect(deriveAppName('create an app that helps me with learning musical chords, use the violin as the example instrument')).toBe('Musical Chord Trainer');
    expect(deriveAppName('Create an app that helps with learning the musical chords. Use the violin as the example instrument.')).toBe('Musical Chord Trainer');
    expect(deriveAppName('build me a tool to track my reading sessions')).toBe('Reading Session Tracker');
    expect(deriveAppName('I need an application for planning weekly meals')).toBe('Weekly Meal Planner');
  });

  it('keeps naming deterministic and within the display-name limit', () => {
    const prompt = 'Create an app that helps me track extraordinarilylongcategoryname anotherlongcategoryvalue averylongdescriptor morewords';
    const first = deriveAppName(prompt);
    expect(deriveAppName(prompt)).toBe(first);
    expect(first.length).toBeLessThanOrEqual(60);
  });

  it('falls back safely for empty or generic prompts', () => {
    expect(deriveAppName('')).toBe('New app');
    expect(deriveAppName('create an app')).toBe('New app');
  });
});
