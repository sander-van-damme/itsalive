import { describe, expect, it, vi } from "vitest";
import worker from "../worker/app";

const ROOT_ORIGIN = "https://itsalive.org";
const APP_ORIGIN = "https://550e8400-e29b-41d4-a716-446655440000.itsalive.org";

const env = () => ({
  ASSETS: {
    fetch: vi.fn(async () => new Response("asset", { status: 200 })),
  },
});

describe("wildcard cleanup worker", () => {
  it("requires an authorized preflight for the destructive endpoint", async () => {
    const e = env();
    const authorized = await worker.fetch(new Request(`${APP_ORIGIN}/__clear`, {
      method: "OPTIONS",
      headers: {
        Origin: ROOT_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "X-Itsalive-Cleanup",
      },
    }), e);
    expect(authorized.status).toBe(204);
    expect(authorized.headers.get("Access-Control-Allow-Origin")).toBe(ROOT_ORIGIN);
    expect(authorized.headers.get("Access-Control-Allow-Methods")).toBe("POST");
    expect(authorized.headers.get("Access-Control-Allow-Headers")).toBe("X-Itsalive-Cleanup");

    const hostile = await worker.fetch(new Request(`${APP_ORIGIN}/__clear`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "X-Itsalive-Cleanup",
      },
    }), e);
    expect(hostile.status).toBe(403);
  });

  it("returns Clear-Site-Data only for an authorized root-origin POST", async () => {
    const e = env();
    const response = await worker.fetch(new Request(`${APP_ORIGIN}/__clear`, {
      method: "POST",
      headers: {
        Origin: ROOT_ORIGIN,
        "X-Itsalive-Cleanup": "1",
      },
    }), e);

    expect(response.status).toBe(204);
    expect(response.headers.get("Clear-Site-Data")).toBe('"storage", "cache"');
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ROOT_ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");

    const noHeader = await worker.fetch(new Request(`${APP_ORIGIN}/__clear`, {
      method: "POST",
      headers: { Origin: ROOT_ORIGIN },
    }), e);
    expect(noHeader.status).toBe(403);
    expect(noHeader.headers.get("Clear-Site-Data")).toBeNull();

    const hostile = await worker.fetch(new Request(`${APP_ORIGIN}/__clear`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "X-Itsalive-Cleanup": "1",
      },
    }), e);
    expect(hostile.status).toBe(403);
    expect(hostile.headers.get("Clear-Site-Data")).toBeNull();
  });

  it("passes ordinary wildcard requests through to static assets", async () => {
    const e = env();
    const response = await worker.fetch(new Request(`${APP_ORIGIN}/some/app/path`), e);
    expect(await response.text()).toBe("asset");
    expect(e.ASSETS.fetch).toHaveBeenCalledOnce();
  });
});
