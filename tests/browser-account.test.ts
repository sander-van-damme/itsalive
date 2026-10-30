import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  ACCOUNT_PENDING_KEY,
  ACCOUNT_STORAGE_KEY,
  BrowserAccount,
} from "../src/ai/browser-account";
import { handleChatGPTAccountAPI } from "../src/server/chatgpt-auth";

const origin = "https://itsalive.org";
const clientId = "itsalive-registered-public-client";
const redirectUri = `${origin}/auth/chatgpt/callback`;
const config = {
  configured: true,
  clientId,
  redirectUri,
  issuer: "https://auth.openai.com",
  authorizationEndpoint: "https://auth.openai.com/api/accounts/authorize",
};
afterEach(() => vi.unstubAllGlobals());
class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
function fixture(scopes = ["openid", "chatgpt.tokens.use.direct"]) {
  const storage = new MemoryStorage();
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/config")) return Response.json(config);
      if (String(url).endsWith("/token"))
        return Response.json({
          clientId,
          accessToken: "private-access-token",
          refreshToken: "private-refresh-token",
          idToken: "signed-id",
          subject: "account-one",
          email: "test@example.test",
          scopes,
          expiresAt: Date.now() + 3_600_000,
        });
      if (String(url).endsWith("/signout"))
        return Response.json({ signedOut: true, revoked: true });
      return Response.json({ data: [{ id: "gpt-6.1-sol" }] });
    },
  );
  const account = new BrowserAccount({
    storage,
    origin,
    fetcher,
    crypto: webcrypto as Crypto,
  });
  const start = async () => {
    const auth = new URL(await account.begin());
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", "one-use-code");
    callback.searchParams.set("state", auth.searchParams.get("state")!);
    return { auth, callback };
  };
  return { storage, fetcher, account, start };
}

describe("hosted browser account", () => {
  it("uses PKCE, state and nonce; verifies the transaction and persists credentials only in the browser store", async () => {
    const f = fixture();
    const { auth, callback } = await f.start();
    const pending = JSON.parse(f.storage.getItem(ACCOUNT_PENDING_KEY)!);
    expect(auth.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(pending.codeVerifier).digest("base64url"),
    );
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("client_id")).toBe(clientId);
    expect(auth.searchParams.get("scope")).toContain(
      "chatgpt.tokens.use.direct",
    );
    const bad = new URL(callback);
    bad.searchParams.set("state", "wrong");
    await expect(f.account.complete(bad)).rejects.toThrow("did not match");
    expect(
      f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/token")),
    ).toHaveLength(0);
    await f.account.complete(callback);
    const request = f.fetcher.mock.calls.find(([url]) =>
      String(url).endsWith("/token"),
    )![1]!;
    expect(JSON.parse(request.body as string)).toMatchObject({
      codeVerifier: pending.codeVerifier,
      nonce: pending.nonce,
      redirectUri,
    });
    expect(JSON.parse(f.storage.getItem(ACCOUNT_STORAGE_KEY)!)).toMatchObject({
      accessToken: "private-access-token",
      refreshToken: "private-refresh-token",
    });
    expect(f.storage.getItem(ACCOUNT_PENDING_KEY)).toBeNull();
    await expect(f.account.complete(callback)).rejects.toThrow();
    expect(await f.account.session()).toMatchObject({
      connected: true,
      sharing: true,
      pending: false,
    });
  });
  it("never treats identity-only sign-in as allowance authorization", async () => {
    const f = fixture(["openid", "email"]);
    await f.account.complete((await f.start()).callback);
    expect(await f.account.session()).toMatchObject({
      connected: true,
      sharing: false,
    });
    await expect(
      f.account.fetch("/responses", { method: "POST" }),
    ).rejects.toThrow("has not granted plan usage");
    expect(
      f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/responses")),
    ).toBe(false);
  });
  it("serializes refresh and keeps the rotated refresh token; sign-out prevents a pending refresh from restoring credentials", async () => {
    const f = fixture();
    await f.account.complete((await f.start()).callback);
    const expire = () => {
      const tokens = JSON.parse(f.storage.getItem(ACCOUNT_STORAGE_KEY)!);
      f.storage.setItem(
        ACCOUNT_STORAGE_KEY,
        JSON.stringify({ ...tokens, expiresAt: 0 }),
      );
    };
    expire();
    f.fetcher.mockClear();
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        clientId,
        accessToken: "rotated-access",
        refreshToken: "rotated-refresh",
        expiresAt: Date.now() + 3_600_000,
      }),
    );
    await Promise.all([f.account.fetch("/models"), f.account.fetch("/models")]);
    expect(
      f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/token")),
    ).toHaveLength(1);
    const sent = f.fetcher.mock.calls.find(([url]) =>
      String(url).endsWith("/models"),
    )![1]!;
    expect(new Headers(sent.headers).get("authorization")).toBe(
      "Bearer rotated-access",
    );
    expect(
      JSON.parse(f.storage.getItem(ACCOUNT_STORAGE_KEY)!).refreshToken,
    ).toBe("rotated-refresh");
    expire();
    let complete!: (response: Response) => void;
    f.fetcher.mockImplementationOnce(
      async () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const refresh = f.account.fetch("/models");
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    await f.account.signout();
    complete(
      Response.json({
        clientId,
        accessToken: "rotated",
        expiresAt: Date.now() + 100_000,
      }),
    );
    await expect(refresh).rejects.toThrow("connection changed");
    expect(f.storage.getItem(ACCOUNT_STORAGE_KEY)).toBeNull();
  });
  it("shows a missing registration without attempting an unsupported loopback client on HTTPS", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        ...config,
        configured: false,
        clientId: null,
        error: "Website connection is not configured.",
      }),
    );
    await expect(f.account.begin()).rejects.toThrow("not configured");
    expect(f.storage.getItem(ACCOUNT_PENDING_KEY)).toBeNull();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("redacts raw stored OAuth credentials if accidentally pasted into diagnostic content", async () => {
    const f = fixture();
    await f.account.complete((await f.start()).callback);
    const result = JSON.stringify(
      f.account.redactDiagnostic({
        prompt: "I pasted private-access-token and private-refresh-token",
        reply: "signed-id",
      }),
    );
    expect(result).not.toContain("private-access-token");
    expect(result).not.toContain("private-refresh-token");
    expect(result).not.toContain("signed-id");
    expect(result).toContain("I pasted [redacted]");
  });
  it("clears an expired connection when its refresh grant has been revoked", async () => {
    const f = fixture();
    await f.account.complete((await f.start()).callback);
    const tokens = JSON.parse(f.storage.getItem(ACCOUNT_STORAGE_KEY)!);
    f.storage.setItem(
      ACCOUNT_STORAGE_KEY,
      JSON.stringify({ ...tokens, expiresAt: 0 }),
    );
    f.fetcher.mockResolvedValueOnce(
      Response.json(
        { error: { code: "invalid_grant", message: "Please connect again." } },
        { status: 400 },
      ),
    );
    await expect(f.account.fetch("/models")).rejects.toThrow("connect again");
    expect(f.storage.getItem(ACCOUNT_STORAGE_KEY)).toBeNull();
  });
  it.each(["/models", "/responses"])(
    "does not dispatch %s when refresh narrows the plan grant",
    async (path) => {
      const f = fixture();
      await f.account.complete((await f.start()).callback);
      const tokens = JSON.parse(f.storage.getItem(ACCOUNT_STORAGE_KEY)!);
      f.storage.setItem(
        ACCOUNT_STORAGE_KEY,
        JSON.stringify({ ...tokens, expiresAt: 0 }),
      );
      f.fetcher.mockClear();
      f.fetcher.mockResolvedValueOnce(
        Response.json({
          clientId,
          accessToken: "identity-only-refreshed-token",
          refreshToken: "rotated-refresh-token",
          scopes: ["openid"],
          expiresAt: Date.now() + 3_600_000,
        }),
      );
      await expect(
        f.account.fetch(path, path === "/responses" ? { method: "POST" } : {}),
      ).rejects.toMatchObject({
        kind: "access",
        code: "plan_access_revoked",
      });
      expect(
        f.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname),
      ).toEqual(["/api/chatgpt/token"]);
      expect(JSON.parse(f.storage.getItem(ACCOUNT_STORAGE_KEY)!)).toMatchObject(
        {
          accessToken: "identity-only-refreshed-token",
          scopes: ["openid"],
        },
      );
      expect(await f.account.session()).toMatchObject({
        connected: true,
        sharing: false,
      });
      await expect(f.account.fetch(path)).rejects.toThrow(
        "has not granted plan usage",
      );
      expect(
        f.fetcher.mock.calls.some(([url]) => String(url).endsWith(path)),
      ).toBe(false);
    },
  );
  it("cancels a request waiting for refresh without cancelling another caller's exchange", async () => {
    const f = fixture();
    await f.account.complete((await f.start()).callback);
    const tokens = JSON.parse(f.storage.getItem(ACCOUNT_STORAGE_KEY)!);
    f.storage.setItem(
      ACCOUNT_STORAGE_KEY,
      JSON.stringify({ ...tokens, expiresAt: 0 }),
    );
    f.fetcher.mockClear();
    let settle!: (response: Response) => void;
    f.fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );
    const controller = new AbortController();
    const cancelled = f.account.fetch("/responses", {
      method: "POST",
      signal: controller.signal,
    });
    const cancelledResult = expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });
    const continuing = f.account.fetch("/models");
    await vi.waitFor(() => expect(settle).toBeTypeOf("function"));
    controller.abort();
    await cancelledResult;
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    settle(
      Response.json({
        clientId,
        accessToken: "refreshed",
        expiresAt: Date.now() + 3_600_000,
      }),
    );
    expect((await continuing).ok).toBe(true);
    expect(
      f.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual(["/api/chatgpt/token", "/api/chatgpt/models"]);
  });
});

function request(path: string, body?: unknown, requestOrigin: string = origin) {
  return new Request(`${origin}/api/chatgpt${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: requestOrigin, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
describe("hosted account server boundary", () => {
  it("cryptographically validates a signed identity and rejects a different nonce or audience", async () => {
    const pair = await generateKeyPair("RS256");
    const key = {
      ...(await exportJWK(pair.publicKey)),
      kid: "account-verification-test",
      alg: "RS256",
      use: "sig",
    };
    const discovery = vi.fn(async () => Response.json({ keys: [key] }));
    vi.stubGlobal("fetch", discovery);
    const signed = async (nonce: string, audience = clientId) =>
      new SignJWT({ nonce, email: "verified@example.test" })
        .setProtectedHeader({ alg: "RS256", kid: key.kid })
        .setIssuer("https://auth.openai.com")
        .setAudience(audience)
        .setSubject("verified-account")
        .setExpirationTime("5m")
        .sign(pair.privateKey);
    const call = async (idToken: string) =>
      handleChatGPTAccountAPI(
        request("/token", {
          grantType: "authorization_code",
          code: "code",
          codeVerifier: "a".repeat(43),
          nonce: "n".repeat(43),
          redirectUri,
        }),
        {
          clientId,
          fetcher: vi.fn(async () =>
            Response.json({
              access_token: "private-token",
              id_token: idToken,
              expires_in: 3600,
              scope: "openid",
            }),
          ),
        },
      );
    expect((await call(await signed("n".repeat(43)))).status).toBe(200);
    expect(discovery).toHaveBeenCalled();
    expect((await call(await signed("different-nonce"))).status).toBe(502);
    expect(
      (await call(await signed("n".repeat(43), "different-client"))).status,
    ).toBe(502);
  });
  it("rejects cross-origin, unregistered clients and incorrect callbacks before contacting OpenAI", async () => {
    const fetcher = vi.fn();
    expect(
      (
        await handleChatGPTAccountAPI(
          request("/token", {}, "https://other.example"),
          { clientId, fetcher },
        )
      ).status,
    ).toBe(403);
    expect(
      (await handleChatGPTAccountAPI(request("/token", {}), { fetcher }))
        .status,
    ).toBe(503);
    expect(
      (
        await handleChatGPTAccountAPI(request("/token", {}), {
          clientId: "dynamic_agent_client",
          fetcher,
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await handleChatGPTAccountAPI(
          request("/token", {
            grantType: "authorization_code",
            code: "code",
            codeVerifier: "a".repeat(43),
            nonce: "n".repeat(43),
            redirectUri: "https://other.example/callback",
          }),
          { clientId, fetcher },
        )
      ).status,
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("exchanges only against the public endpoint and verifies signed identity, audience and nonce", async () => {
    const fetcher = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        Response.json({
          access_token: "private-access",
          refresh_token: "private-refresh",
          id_token: "signed-identity",
          expires_in: 3600,
          scope: "openid chatgpt.tokens.use.direct",
        }),
    );
    const verifyIdentity = vi.fn(async () => ({
      sub: "account",
      email: "test@example.test",
    }));
    const response = await handleChatGPTAccountAPI(
      request("/token", {
        grantType: "authorization_code",
        code: "code",
        codeVerifier: "a".repeat(43),
        nonce: "n".repeat(43),
        redirectUri,
      }),
      { clientId, fetcher, verifyIdentity },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(verifyIdentity).toHaveBeenCalledWith(
      "signed-identity",
      clientId,
      "n".repeat(43),
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://auth.openai.com/api/accounts/oauth/token",
    );
    expect(await response.json()).toMatchObject({
      clientId,
      subject: "account",
      accessToken: "private-access",
    });
  });
  it("keeps account billing separate and strips unsupported plan parameters without adding output caps", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("data: response\n\n", {
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "upstream-request",
          },
        }),
    );
    const req = request("/responses", {
      model: "gpt-6.1-sol",
      input: [],
      max_output_tokens: 10,
      truncation: "disabled",
      store: true,
    });
    req.headers.set("authorization", "Bearer plan-token");
    const response = await handleChatGPTAccountAPI(req, { clientId, fetcher });
    const [, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: "Bearer plan-token" });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-6.1-sol",
      input: [],
      store: false,
      stream: true,
    });
    expect(response.headers.get("x-request-id")).toBe("upstream-request");
    expect(await response.text()).toContain("data: response");
  });
  it("preserves opt-in upstream error details but removes even opaque account credentials", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        {
          error: {
            message: "Rejected plan-token-opaque-value",
            code: "unsupported_parameter",
            param: "invalid",
          },
        },
        { status: 400 },
      ),
    );
    const req = request("/responses", { model: "gpt-6.1-sol", input: [] });
    req.headers.set("authorization", "Bearer plan-token-opaque-value");
    req.headers.set("x-itsalive-debug", "1");
    const response = await handleChatGPTAccountAPI(req, { clientId, fetcher });
    const body = await response.text();
    expect(body).toContain("Rejected [redacted]");
    expect(body).not.toContain("plan-token-opaque-value");
  });
});
