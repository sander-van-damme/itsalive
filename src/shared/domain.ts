export interface ParsedRootDomain {
  hostname: string;
  port: string;
  protocol: "http:" | "https:";
  origin: string;
}

/** The canonical root domain used by the shell and every app origin. */
export const ROOT_DOMAIN = "itsalive.org";

const APP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validates the immutable UUID used as both storage identity and hostname label. */
export function normalizeAppId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!APP_ID_PATTERN.test(id)) throw new Error("App ID must be a UUID.");
  return id;
}

export function isValidAppId(value: unknown): value is string {
  return typeof value === "string" && value === value.trim().toLowerCase() && APP_ID_PATTERN.test(value);
}

/** Accepts a bare hostname (production) or an http(s) origin (local development). */
export function parseRootDomain(value: string, defaultProtocol: "http:" | "https:" = "https:"): ParsedRootDomain {
  const input = value.trim().replace(/\.$/, "");
  if (!input || /[/?#]/.test(input.replace(/^https?:\/\//i, ""))) {
    throw new Error("ROOT_DOMAIN must be a hostname, optionally including a port or http(s) protocol.");
  }
  const url = new URL(/^https?:\/\//i.test(input) ? input : `${defaultProtocol}//${input}`);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/") {
    throw new Error("ROOT_DOMAIN must describe an http(s) origin without credentials or a path.");
  }
  return { hostname: url.hostname.toLowerCase(), port: url.port, protocol: url.protocol, origin: url.origin };
}

export function rootOrigin(rootDomain: string, protocol?: "http:" | "https:"): string {
  return parseRootDomain(rootDomain, protocol).origin;
}

/** Reads the selected app from the canonical client-side fragment. */
export function appIdFromShellUrl(value: URL | string): string | undefined {
  const url = value instanceof URL ? value : new URL(value);
  return new URLSearchParams(url.hash.slice(1)).get("app") ?? undefined;
}

/** Builds the canonical client-side shell URL without sending the app ID to the server. */
export function shellUrlForApp(value: URL | string, id: string): URL {
  const url = new URL(value.toString());
  url.searchParams.delete("app");
  const fragment = new URLSearchParams(url.hash.slice(1));
  fragment.set("app", normalizeAppId(id));
  url.hash = fragment.toString();
  return url;
}

export function appOrigin(id: string, rootDomain: string, protocol?: "http:" | "https:"): string {
  const root = parseRootDomain(rootDomain, protocol);
  const hostname = `${normalizeAppId(id)}.${root.hostname}`;
  return `${root.protocol}//${hostname}${root.port ? `:${root.port}` : ""}`;
}
