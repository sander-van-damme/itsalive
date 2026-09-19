import { describe, expect, it, vi } from "vitest";
import {
  APP_CLEANUP_HEADER,
  clearAppOrigin,
} from "../src/shell/core/app-deletion";
import {
  CLEANUP_PATH,
  CLEANUP_REQUEST_HEADER,
  ROOT_CLEANUP_ORIGIN,
  handleAppRequest,
  type AppWorkerEnv,
} from "../src/app-worker";

describe("shell-triggered app-origin cleanup", () => {
  it("uses a credentialed non-simple POST to the app cleanup endpoint", async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }));

    await clearAppOrigin("https://550e8400-e29b-41d4-a716-446655440000.itsalive.org", request as typeof fetch);

    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe("https://550e8400-e29b-41d4-a716-446655440000.itsalive.org/__clear");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { [APP_CLEANUP_HEADER]: "1" },
    });
  });

  it("reports a non-success cleanup response", async () => {
    const request = vi.fn(async () => new Response(null, { status: 403 }));
    await expect(clearAppOrigin("https://app.itsalive.org", request as typeof fetch))
      .rejects.toThrow("App-origin cleanup failed (403)");
  });
});

describe("wildcard cleanup endpoint", () => {
  const assets = { fetch: vi.fn(async () => new Response("asset", { status: 200 })) };
  const env = { ASSETS: assets } satisfies AppWorkerEnv;
  const appUrl = `https://550e8400-e29b-41d4-a716-446655440000.itsalive.org${CLEANUP_PATH}`;

  it("approves only the exact root-origin preflight and cleanup header", async () => {
    const response = await handleAppRequest(new Request(appUrl, {
      method: "OPTIONS",
      headers: {
        Origin: ROOT_CLEANUP_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": CLEANUP_REQUEST_HEADER,
      },
    }), env);

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ROOT_CLEANUP_ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(CLEANUP_REQUEST_HEADER);
    expect(response.headers.get("Clear-Site-Data")).toBeNull();
  });

  it("rejects third-party origins and unexpected preflight headers", async () => {
    const thirdParty = await handleAppRequest(new Request(appUrl, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": CLEANUP_REQUEST_HEADER,
      },
    }), env);
    expect(thirdParty.status).toBe(403);

    const extraHeader = await handleAppRequest(new Request(appUrl, {
      method: "OPTIONS",
      headers: {
        Origin: ROOT_CLEANUP_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": `${CLEANUP_REQUEST_HEADER}, X-Other`,
      },
    }), env);
    expect(extraHeader.status).toBe(403);
  });

  it("returns Clear-Site-Data only for an authorized destructive request", async () => {
    const unauthorized = await handleAppRequest(new Request(appUrl, {
      method: "POST",
      headers: { Origin: "https://evil.example", [CLEANUP_REQUEST_HEADER]: "1" },
    }), env);
    expect(unauthorized.status).toBe(403);
    expect(unauthorized.headers.get("Clear-Site-Data")).toBeNull();

    const missingHeader = await handleAppRequest(new Request(appUrl, {
      method: "POST",
      headers: { Origin: ROOT_CLEANUP_ORIGIN },
    }), env);
    expect(missingHeader.status).toBe(403);
    expect(missingHeader.headers.get("Clear-Site-Data")).toBeNull();

    const response = await handleAppRequest(new Request(appUrl, {
      method: "POST",
      headers: { Origin: ROOT_CLEANUP_ORIGIN, [CLEANUP_REQUEST_HEADER]: "1" },
    }), env);

    expect(response.status).toBe(204);
    expect(response.headers.get("Clear-Site-Data")).toBe('"storage", "cache"');
    expect(response.headers.get("Clear-Site-Data")).not.toContain("cookies");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ROOT_CLEANUP_ORIGIN);
  });

  it("passes ordinary wildcard asset requests through untouched", async () => {
    assets.fetch.mockClear();
    const request = new Request("https://550e8400-e29b-41d4-a716-446655440000.itsalive.org/");
    const response = await handleAppRequest(request, env);
    expect(await response.text()).toBe("asset");
    expect(assets.fetch).toHaveBeenCalledWith(request);
  });
});
