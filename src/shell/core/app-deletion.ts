import type { ShellDatabase } from "./database";

/** Origin cleanup is optional because only the active app has a mounted runtime. */
export async function deleteApp(
  db: ShellDatabase,
  id: string,
  clearOrigin?: () => Promise<unknown>,
  reportCleanupFailure: (error: unknown) => void = error => console.warn("[itsalive] Could not clear app-origin storage", error),
): Promise<void> {
  if (clearOrigin) {
    try { await clearOrigin(); }
    catch (error) { reportCleanupFailure(error); }
  }
  await db.apps.delete(id);
}
