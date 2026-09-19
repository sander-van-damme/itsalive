import type { ShellDatabase } from "./database";

export const APP_CLEANUP_HEADER = "X-Itsalive-Cleanup";

export async function clearAppOrigin(
  origin: string,
  request: typeof fetch = fetch,
): Promise<void> {
  const url = new URL("/__clear", new URL(origin).origin);
  const response = await request(url, {
    method: "POST",
    credentials: "include",
    headers: { [APP_CLEANUP_HEADER]: "1" },
  });
  if (!response.ok) throw new Error(`App-origin cleanup failed (${response.status})`);
}

/**
 * Product deletion is shell-owned and completes before best-effort browser-origin cleanup.
 * A forgotten immutable UUID is never reused, so cleanup failure cannot resurrect the app.
 */
export async function deleteApp(
  db: ShellDatabase,
  id: string,
  clearOrigin?: () => Promise<unknown>,
  reportCleanupFailure: (error: unknown) => void = error => console.warn("[itsalive] Could not clear app-origin storage", error),
): Promise<void> {
  await db.apps.delete(id);
  if (!clearOrigin) return;
  try { await clearOrigin(); }
  catch (error) { reportCleanupFailure(error); }
}
