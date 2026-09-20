import { ROOT_DOMAIN, appOrigin } from "../../shared";
import type { ShellDatabase } from "./database";

export const APP_CLEANUP_HEADER = "X-Itsalive-Cleanup";

export async function clearAppOrigin(
  id: string,
  fetcher: typeof fetch = fetch,
  protocol: "http:" | "https:" = location.protocol === "http:" ? "http:" : "https:",
): Promise<void> {
  const response = await fetcher(`${appOrigin(id, ROOT_DOMAIN, protocol)}/__clear`, {
    method: "POST",
    mode: "cors",
    credentials: "include",
    headers: { [APP_CLEANUP_HEADER]: "1" },
  });
  if (!response.ok) throw new Error(`App-origin cleanup failed (${response.status})`);
}

/**
 * Product deletion is shell-owned and authoritative. Origin cleanup happens
 * afterwards as best-effort hygiene and must never block forgetting the app.
 */
export async function deleteApp(
  db: ShellDatabase,
  id: string,
  clearOrigin: (() => Promise<unknown>) | undefined = () => clearAppOrigin(id),
  reportCleanupFailure: (error: unknown) => void = error => console.warn("[itsalive] Could not clear app-origin storage", error),
): Promise<void> {
  await db.apps.delete(id);
  if (!clearOrigin) return;
  try { await clearOrigin(); }
  catch (error) { reportCleanupFailure(error); }
}
