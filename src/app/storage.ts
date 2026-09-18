import { closeAppDatabase } from "./db";

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deletion = indexedDB.deleteDatabase(name);
    deletion.onsuccess = () => resolve();
    deletion.onerror = () => reject(deletion.error ?? new Error(`Unable to delete IndexedDB database ${name}`));
    deletion.onblocked = () => reject(new Error(`IndexedDB database ${name} is still open`));
  });
}

/** Clears storage owned by this app origin. This is a private bridge operation. */
export async function clearOriginStorage(): Promise<void> {
  const failures: unknown[] = [];
  try { await closeAppDatabase(); } catch (error) { failures.push(error); }
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof navigator.serviceWorker?.getRegistrations === "function") {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const result = await Promise.allSettled(registrations.map(async registration => {
        if (!await registration.unregister()) throw new Error(`Unable to unregister service worker ${registration.scope}`);
      }));
      failures.push(...result.filter(item => item.status === "rejected").map(item => item.reason));
    } catch (error) { failures.push(error); }
  }
  try { localStorage.clear(); } catch (error) { failures.push(error); }
  try { sessionStorage.clear(); } catch (error) { failures.push(error); }
  if (typeof caches !== "undefined") {
    try {
      const result = await Promise.allSettled((await caches.keys()).map(name => caches.delete(name)));
      failures.push(...result.filter(item => item.status === "rejected").map(item => item.reason));
    } catch (error) { failures.push(error); }
  }
  if (typeof indexedDB !== "undefined") {
    try {
      const databases = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [{ name: "itsalive-app-v2" }];
      const result = await Promise.allSettled(databases.flatMap(item => item.name ? [deleteDatabase(item.name)] : []));
      failures.push(...result.filter(item => item.status === "rejected").map(item => item.reason));
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Some app-origin storage could not be cleared");
}
