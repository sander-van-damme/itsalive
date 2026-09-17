import { describe, expect, it } from 'vitest';
import { nextCronRun } from '../src/shell/core/schedules';

describe('nextCronRun', () => {
  it('calculates wildcard and stepped schedules in UTC', () => {
    const after = Date.UTC(2026, 8, 17, 7, 58, 40);
    expect(nextCronRun('* * * * *', after)).toBe(Date.UTC(2026, 8, 17, 7, 59));
    expect(nextCronRun('*/15 8 * * *', after)).toBe(Date.UTC(2026, 8, 17, 8, 0));
  });
  it('supports ranges/lists and rejects malformed schedules', () => {
    const after = Date.UTC(2026, 8, 18, 8, 0);
    expect(nextCronRun('30 9 1-7 * 1,3,5', after)).toBe(Date.UTC(2026, 9, 2, 9, 30));
    expect(() => nextCronRun('not cron')).toThrow(/five-field|contain/i);
    expect(() => nextCronRun('90 * * * *')).toThrow(/invalid/i);
  });
});
