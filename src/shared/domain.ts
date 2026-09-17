export interface ParsedRootDomain {
  hostname: string;
  port: string;
  protocol: "http:" | "https:";
  origin: string;
}

/** The canonical root domain used by the shell and every app origin. */
export const ROOT_DOMAIN = "itsalive.org";

const SLUG_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Normalizes and validates a value intended for a single DNS hostname label. */
export function normalizeAppSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error("App slug must be 1-63 lowercase letters, numbers, or hyphens, and cannot start or end with a hyphen.");
  }
  return slug;
}

export function isValidAppSlug(value: unknown): value is string {
  return typeof value === "string" && value === value.trim().toLowerCase() && SLUG_PATTERN.test(value);
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

export function appOrigin(slug: string, rootDomain: string, protocol?: "http:" | "https:"): string {
  const root = parseRootDomain(rootDomain, protocol);
  const hostname = `${normalizeAppSlug(slug)}.${root.hostname}`;
  return `${root.protocol}//${hostname}${root.port ? `:${root.port}` : ""}`;
}

export function appUrl(slug: string, rootDomain: string, protocol?: "http:" | "https:"): URL {
  return new URL(appOrigin(slug, rootDomain, protocol));
}

/** Extracts the app label only when the URL is an immediate subdomain of root. */
export function appSlugFromUrl(input: string | URL, rootDomain: string): string | null {
  let url: URL;
  try { url = input instanceof URL ? input : new URL(input); } catch { return null; }
  const root = parseRootDomain(rootDomain, url.protocol === "http:" ? "http:" : "https:");
  if (url.protocol !== root.protocol || url.port !== root.port) return null;
  const suffix = `.${root.hostname}`;
  if (!url.hostname.endsWith(suffix)) return null;
  const slug = url.hostname.slice(0, -suffix.length);
  return isValidAppSlug(slug) ? slug : null;
}

export function isExpectedAppOrigin(origin: string, slug: string, rootDomain: string): boolean {
  try { return new URL(origin).origin === appOrigin(slug, rootDomain, new URL(origin).protocol as "http:" | "https:"); }
  catch { return false; }
}
