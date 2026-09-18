// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearOriginStorage } from '../src/app/storage';

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('data');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function wasDeleted(name: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let created = false;
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      created = true;
      request.result.createObjectStore('probe');
    };
    request.onsuccess = () => {
      request.result.close();
      const deletion = indexedDB.deleteDatabase(name);
      deletion.onsuccess = () => resolve(created);
      deletion.onerror = () => reject(deletion.error);
    };
    request.onerror = () => reject(request.error);
  });
}

const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  if (originalServiceWorker) Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
  else Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('clearOriginStorage', () => {
  it('unregisters service workers and deletes runtime and generated IndexedDB databases', async () => {
    const runtimeDb = await openDatabase('itsalive-app-v2');
    const generatedDb = await openDatabase('generated-app-state');
    runtimeDb.close();
    generatedDb.close();

    const unregister = vi.fn().mockResolvedValue(true);
    const getRegistrations = vi.fn().mockResolvedValue([{ scope: 'https://app.test/', unregister }]);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistrations },
    });

    localStorage.setItem('app', 'state');
    sessionStorage.setItem('app', 'session');

    await clearOriginStorage();

    expect(getRegistrations).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(localStorage.getItem('app')).toBeNull();
    expect(sessionStorage.getItem('app')).toBeNull();
    expect(await wasDeleted('itsalive-app-v2')).toBe(true);
    expect(await wasDeleted('generated-app-state')).toBe(true);
  });

  it('reports a failed service-worker unregister as cleanup failure', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistrations: vi.fn().mockResolvedValue([{ scope: 'https://app.test/', unregister: vi.fn().mockResolvedValue(false) }]) },
    });

    await expect(clearOriginStorage()).rejects.toThrow('Some app-origin storage could not be cleared');
  });
});
