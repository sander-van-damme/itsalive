const ROOT_ORIGIN = "https://itsalive.org";
const CLEANUP_HEADER = "X-Itsalive-Cleanup";
const ALLOWED_METHOD = "POST";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

function corsHeaders(): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", ROOT_ORIGIN);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  return headers;
}

function preflightAuthorized(request: Request): boolean {
  if (request.headers.get("Origin") !== ROOT_ORIGIN) return false;
  if (request.headers.get("Access-Control-Request-Method")?.toUpperCase() !== ALLOWED_METHOD) return false;
  const requested = (request.headers.get("Access-Control-Request-Headers") ?? "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  return requested.includes(CLEANUP_HEADER.toLowerCase());
}

function cleanupAuthorized(request: Request): boolean {
  return request.headers.get("Origin") === ROOT_ORIGIN
    && request.headers.get(CLEANUP_HEADER) === "1";
}

function clearResponse(): Response {
  const headers = corsHeaders();
  headers.set("Clear-Site-Data", '"storage", "cache"');
  return new Response(null, { status: 204, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/__clear") return env.ASSETS.fetch(request);

    if (request.method === "OPTIONS") {
      if (!preflightAuthorized(request)) return new Response(null, { status: 403 });
      const headers = corsHeaders();
      headers.set("Access-Control-Allow-Methods", ALLOWED_METHOD);
      headers.set("Access-Control-Allow-Headers", CLEANUP_HEADER);
      headers.set("Access-Control-Max-Age", "600");
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== ALLOWED_METHOD) {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: ALLOWED_METHOD } });
    }
    if (!cleanupAuthorized(request)) return new Response("Forbidden", { status: 403 });

    return clearResponse();
  },
};
