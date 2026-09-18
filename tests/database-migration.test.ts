import { describe, expect, it, vi } from 'vitest';
import { migrateLegacyRecords } from '../src/shell/core/database';

describe('legacy app identity migration', () => {
  it('assigns one immutable UUID and rewrites history, logs, and schedule identity', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('550e8400-e29b-41d4-a716-446655440000');
    const result = migrateLegacyRecords(
      [{ slug: 'meal-planner', name: 'Meals', prompt: 'Plan meals', summary: '', createdAt: 1, updatedAt: 2 }],
      [
        [{ id: 7, appSlug: 'meal-planner', timestamp: 3, role: 'user', content: 'hello' }],
        [{ id: 8, appSlug: 'meal-planner', timestamp: 4, level: 'info', source: 'app', message: 'saved' }],
        [{ id: 'meal-planner:daily', appSlug: 'meal-planner', expression: '0 9 * * *', registeredAt: 5 }],
      ],
    );
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(result.apps[0]).toMatchObject({ id, name: 'Meals', prompt: 'Plan meals' });
    expect(result.apps[0]).not.toHaveProperty('slug');
    expect(result.associated[0]![0]).toMatchObject({ id: 7, appId: id, content: 'hello' });
    expect(result.associated[1]![0]).toMatchObject({ id: 8, appId: id, message: 'saved' });
    expect(result.associated[2]![0]).toMatchObject({ id: `${id}:daily`, appId: id });
    expect(result.associated.flat()).not.toEqual(expect.arrayContaining([expect.objectContaining({ appSlug: 'meal-planner' })]));
  });
});
