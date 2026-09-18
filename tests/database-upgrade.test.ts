import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { ShellDatabase } from '../src/shell/core/database';

const NAME = 'itsalive-old-schema-test';

function openVersionOne(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('apps', { keyPath: 'slug' }).put({ slug: 'old-app', name: 'Old' });
      db.createObjectStore('history', { keyPath: 'id', autoIncrement: true }).put({ appSlug: 'old-app', content: 'old history' });
      db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true }).put({ appSlug: 'old-app', message: 'old log' });
      db.createObjectStore('schedules', { keyPath: 'id' }).put({ id: 'old-app:daily', appSlug: 'old-app' });
      db.createObjectStore('credentials', { keyPath: 'id' }).put({ id: 'provider', value: 'kept' });
      db.createObjectStore('models', { keyPath: 'id' }).put({ id: 'model' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe('old shell schema reset', () => {
  afterEach(() => indexedDB.deleteDatabase(NAME));

  it('opens safely while discarding slug-era app-owned records', async () => {
    const old = await openVersionOne();
    old.close();
    const db = new ShellDatabase(NAME);

    expect(await db.apps.list()).toEqual([]);
    expect(await db.all('history')).toEqual([]);
    expect(await db.logs.all()).toEqual([]);
    expect(await db.schedules.list()).toEqual([]);
    expect(await db.credentials.get('provider')).toMatchObject({ id: 'provider', value: 'kept' });
  });
});
