/** The local helper keeps ChatGPT OAuth credentials outside the browser. */
export const COMPANION_ORIGIN = "http://127.0.0.1:1456";
let sessionToken = "";
export interface AccountSession {
  connected: boolean;
  sharing: boolean;
  email?: string;
  csrf: string;
  pending?: boolean;
  error?: string;
}
export async function accountSession(
  signal?: AbortSignal,
): Promise<AccountSession> {
  const response = await fetch(`${COMPANION_ORIGIN}/session`, {
    signal: signal ?? AbortSignal.timeout(3000),
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error("The ChatGPT connection helper is unavailable.");
  const session = (await response.json()) as AccountSession;
  sessionToken = session.csrf;
  return session;
}
export async function companionFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!sessionToken) await accountSession(init.signal ?? undefined);
  const headers = new Headers(init.headers);
  headers.set("X-Itsalive-Session", sessionToken);
  return fetch(`${COMPANION_ORIGIN}${path}`, { ...init, headers });
}
