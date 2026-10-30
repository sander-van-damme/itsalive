import { BrowserAccount } from "./browser-account";
import { redactCredentials } from "../shared/redaction";
/** Existing local installations can continue using their loopback registration. */
export const COMPANION_ORIGIN = "http://127.0.0.1:1456";
let sessionToken = "";
let browser: BrowserAccount | undefined;
let browserMode: Promise<boolean> | undefined;
function browserAccount(): BrowserAccount {
  return (browser ??= new BrowserAccount({
    storage: localStorage,
    origin: location.origin,
    locks: navigator.locks,
  }));
}
export function redactAccountDiagnostic(value: unknown): unknown {
  return typeof localStorage === "undefined"
    ? redactCredentials(value)
    : browserAccount().redactDiagnostic(value);
}
async function usesBrowserAccount(): Promise<boolean> {
  if (typeof location === "undefined") return false;
  if (
    !/^(localhost|127\.0\.0\.1)$/.test(location.hostname) &&
    !location.hostname.endsWith(".localhost")
  )
    return true;
  return (browserMode ??= browserAccount()
    .configuration(AbortSignal.timeout(3000))
    .then((value) => value.configured)
    .catch(() => false));
}
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
  if (await usesBrowserAccount()) return browserAccount().session(signal);
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
  if (await usesBrowserAccount()) {
    if (path === "/signin")
      return Response.json({
        url: await browserAccount().begin(init.signal ?? undefined),
      });
    if (path === "/signout") return browserAccount().signout();
    return browserAccount().fetch(path, init);
  }
  if (!sessionToken) await accountSession(init.signal ?? undefined);
  const headers = new Headers(init.headers);
  headers.set("X-Itsalive-Session", sessionToken);
  return fetch(`${COMPANION_ORIGIN}${path}`, { ...init, headers });
}

/** Called before the shell starts, including when the callback has no opener. */
export async function completeAccountCallback(): Promise<boolean> {
  if (location.pathname !== "/auth/chatgpt/callback") return false;
  const callback = new URL(location.href);
  history.replaceState(null, "", callback.pathname);
  document.title = "Connect ChatGPT · It's Alive";
  const main = document.createElement("main");
  main.className = "account-callback";
  const heading = document.createElement("h1");
  heading.textContent = "Connecting ChatGPT…";
  const message = document.createElement("p");
  message.setAttribute("role", "status");
  main.append(heading, message);
  document.body.replaceChildren(main);
  try {
    await browserAccount().complete(callback);
    const session = await browserAccount().session();
    heading.textContent = session.sharing
      ? "ChatGPT connected"
      : "Signed in to ChatGPT";
    message.textContent = session.sharing
      ? "You can close this window and return to your app."
      : "Plan usage was not granted. Enable it in ChatGPT, then connect again.";
    if (session.sharing) window.close();
  } catch (error) {
    heading.textContent = "ChatGPT did not connect";
    message.textContent =
      error instanceof Error
        ? error.message
        : "Return to your app and try again.";
  }
  const returnLink = document.createElement("a");
  returnLink.href = "/";
  returnLink.textContent = "Return to It's Alive";
  main.append(returnLink);
  return true;
}
