export const ROOT_CLEANUP_ORIGIN = "https://itsalive.org";
export const CLEANUP_PATH = "/__clear";
export const CLEANUP_REQUEST_HEADER = "X-Itsalive-Cleanup";

export interface AppWorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

function corsHeaders(): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": ROOT_CLEANUP_ORIGIN,
    "Access-Control-Allow-Credentials": "true",
    "Cache-Control": "no-store",
    "Vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  });
}

function forbidden(): Response {
  return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
}

function requestedHeaders(request: Request): string[] {
  return (request.headers.get("Access-Control-Request-Headers") ?? "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

export async function handleAppRequest(request: Request, env: AppWorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== CLEANUP_PATH) return env.ASSETS.fetch(request);

  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") {
    const method = request.headers.get("Access-Control-Request-Method");
    const headers = requestedHeaders(request);
    if (
      origin !== ROOT_CLEANUP_ORIGIN
      || method !== "POST"
      || headers.length !== 1
      || headers[0] !== CLEANUP_REQUEST_HEADER.toLowerCase()
    ) return forbidden();

    const responseHeaders = corsHeaders();
    responseHeaders.set("Access-Control-Allow-Methods", "POST");
    responseHeaders.set("Access-Control-Allow-Headers", CLEANUP_REQUEST_HEADER);
    responseHeaders.set("Access-Control-Max-Age", "600");
    return new Response(null, { status: 204, headers: responseHeaders });
  }

  if (request.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { "Allow": "POST, OPTIONS", "Cache-Control": "no-store" },
    });
  }

  if (
    origin !== ROOT_CLEANUP_ORIGIN
    || request.headers.get(CLEANUP_REQUEST_HEADER) !== "1"
  ) return forbidden();

  const responseHeaders = corsHeaders();
  responseHeaders.set("Clear-Site-Data", '"storage", "cache"');
  return new Response(null, { status: 204, headers: responseHeaders });
}

export default {
  fetch: handleAppRequest,
};
