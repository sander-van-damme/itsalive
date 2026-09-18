// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { dbGet, dbSet, openAppDatabase, STORES } from '../src/app/db';
import { installAutosave, loadSavedDocument } from '../src/app/persistence';
import { createToolsApi } from '../src/app/tools';
import { ShellDatabase } from '../src/shell/core/database';

const APP_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('runtime-private persistence', () => {
  it('owns only document and tool stores and restores a saved app document', async () => {
    const db = await openAppDatabase();
    expect([...db.objectStoreNames]).toEqual(['document', 'tools']);

    await dbSet(STORES.document, 'html', '<!doctype html><html lang="en"><head><title>Saved app</title></head><body><main id="saved">Durable state</main></body></html>');
    document.body.replaceChildren();
    expect(await loadSavedDocument()).toBe(true);
    expect(document.title).toBe('Saved app');
    expect(document.querySelector('#saved')?.textContent).toBe('Durable state');
  });

  it('removes every installed autosave listener when disconnected', () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const autosave = installAutosave();
    const listeners = added.mock.calls.filter(([type]) => ['input', 'change', 'pagehide'].includes(type));

    autosave.disconnect();

    expect(listeners).toHaveLength(3);
    for (const [type, listener] of listeners) {
      expect(removed.mock.calls.some(call => call[0] === type && call[1] === listener)).toBe(true);
    }
    added.mockRestore();
    removed.mockRestore();
  });

  it('persists and executes custom tools', async () => {
    Object.defineProperty(window, 'itsalive', { value: { apiVersion: 2 }, configurable: true });
    const tools = createToolsApi(() => undefined);
    await tools.create({
      name: 'add',
      description: 'Add two numbers',
      code: 'return ({ a, b }, env) => ({ total: a + b, version: env.itsalive.apiVersion });',
    });
    expect(await dbGet(STORES.tools, 'add')).toMatchObject({ name: 'add' });
    await expect(tools.call('add', { a: 2, b: 3 })).resolves.toEqual({ total: 5, version: 2 });
  });
});

describe('shell persistence', () => {
  it('persists apps, history, logs, and schedules without legacy stores', async () => {
    const db = new ShellDatabase(`shell-${crypto.randomUUID()}`);
    const connection = await db.open();
    expect([...connection.objectStoreNames]).toEqual(['apps', 'history', 'logs', 'schedules']);

    await db.apps.put({ id: APP_ID, name: 'Test', prompt: 'Build', summary: '', createdAt: 1, updatedAt: 1 });
    await db.history.add({ appId: APP_ID, timestamp: 2, role: 'user', kind: 'chat', content: 'hello' });
    await db.logs.add({ appId: APP_ID, timestamp: 3, level: 'info', source: 'test', message: 'saved' });
    await db.schedules.put({ id: `${APP_ID}:daily`, appId: APP_ID, expression: '0 8 * * *', registeredAt: 4, nextRun: 5 });

    expect(await db.apps.get(APP_ID)).toMatchObject({ name: 'Test' });
    expect(await db.history.forApp(APP_ID)).toHaveLength(1);
    expect(await db.logs.forApp(APP_ID)).toHaveLength(1);
    expect(await db.schedules.forApp(APP_ID)).toHaveLength(1);
  });
});
