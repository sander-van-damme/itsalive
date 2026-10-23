import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createCompanion } from "../src/server/companion";

const origin = "http://itsalive.localhost:4173";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(scopes = "openid chatgpt.tokens.use.direct") {
  const directory = await mkdtemp(join(tmpdir(), "itsalive-account-"));
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/oauth/token"))
        return Response.json({
          access_token: "private-access",
          refresh_token: "private-refresh",
          id_token: "signed-identity",
          expires_in: 3600,
          scope: scopes,
        });
      if (String(url).endsWith("/openid-configuration"))
        return Response.json({
          revocation_endpoint: "https://auth.openai.com/revoke",
        });
      if (String(url).endsWith("/revoke"))
        return new Response(null, { status: 200 });
      if (String(url).endsWith("/models"))
        return Response.json({
          models: [
            {
              slug: "gpt-6.1-sol",
              display_name: "GPT-6.1 Sol",
              visibility: "list",
            },
          ],
        });
      return new Response('data: {"type":"response.completed"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    },
  );
  const verify = vi.fn(async () => ({
    sub: "account-one",
    email: "example@example.test",
  }));
  const helper = await createCompanion({ directory, port: 0, fetcher, verify });
  await helper.listen();
  const address = helper.server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const base = `http://127.0.0.1:${address.port}`;
  cleanup.push(async () => {
    helper.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      helper.server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });
  const session = await (
    await fetch(`${base}/session`, { headers: { Origin: origin } })
  ).json();
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    token = session.csrf,
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: origin,
        "X-Itsalive-Session": token,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const signIn = async () => {
    const { url } = await (await call("/signin", "POST")).json();
    const auth = new URL(url);
    const callback = new URL(auth.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", auth.searchParams.get("state")!);
    callback.searchParams.set("code", "one-use-code");
    callback.searchParams.set("client_id", "issued-client");
    return { auth, callback };
  };
  return { base, call, signIn, session, fetcher, verify, directory };
}
describe("local ChatGPT account connection", () => {
  it("serializes refreshes and atomically retains the rotated token", async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        access_token: "expiring-access",
        refresh_token: "first-refresh",
        id_token: "signed-identity",
        expires_in: 30,
        scope: "openid chatgpt.tokens.use.direct",
      }),
    );
    const { callback } = await f.signIn();
    await fetch(callback);
    const results = await Promise.all([f.call("/models"), f.call("/models")]);
    expect(results.every((result) => result.ok)).toBe(true);
    const exchanges = f.fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith("/oauth/token"),
    );
    expect(exchanges).toHaveLength(2);
    expect((exchanges[1]![1]!.body as URLSearchParams).get("grant_type")).toBe(
      "refresh_token",
    );
    expect(
      (exchanges[1]![1]!.body as URLSearchParams).get("refresh_token"),
    ).toBe("first-refresh");
    const stored = JSON.parse(
      await readFile(join(f.directory, "chatgpt.json"), "utf8"),
    );
    expect(stored.refreshToken).toBe("private-refresh");
    expect(stored.accessToken).toBe("private-access");
  });
  it("rejects other websites and invalid session tokens, including non-ASCII input", async () => {
    const f = await fixture();
    expect(
      (
        await fetch(`${f.base}/session`, {
          headers: { Origin: "https://other.test" },
        })
      ).status,
    ).toBe(403);
    expect((await f.call("/signin", "POST", undefined, "wrong")).status).toBe(
      403,
    );
    expect(
      (
        await f.call(
          "/signin",
          "POST",
          undefined,
          "é".repeat(f.session.csrf.length),
        )
      ).status,
    ).toBe(403);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("verifies PKCE and identity, keeps tokens local and streams only through the public endpoint", async () => {
    const f = await fixture();
    const { auth, callback } = await f.signIn();
    expect(auth.origin).toBe("https://auth.openai.com");
    expect(auth.searchParams.get("client_id")).toBe("dynamic_agent_client");
    const bad = new URL(callback);
    bad.searchParams.set("state", "bad");
    expect((await fetch(bad)).status).toBe(400);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await fetch(callback)).status).toBe(200);
    const tokenCall = f.fetcher.mock.calls[0]!;
    const tokenBody = tokenCall[1]!.body as URLSearchParams;
    expect(tokenBody.get("client_id")).toBe("issued-client");
    expect(
      createHash("sha256")
        .update(tokenBody.get("code_verifier")!)
        .digest("base64url"),
    ).toBe(auth.searchParams.get("code_challenge"));
    expect(f.verify).toHaveBeenCalledWith(
      "signed-identity",
      "issued-client",
      auth.searchParams.get("nonce"),
    );
    const sessionText = await (await f.call("/session")).text();
    expect(sessionText).toContain('"sharing":true');
    expect(sessionText).not.toMatch(
      /private-access|private-refresh|signed-identity/,
    );
    const response = await f.call("/responses", "POST", {
      model: "gpt-6.1-sol",
      input: [],
      max_output_tokens: 999,
      store: true,
    });
    expect(await response.text()).toContain("response.completed");
    const inference = f.fetcher.mock.calls.at(-1)!;
    expect(inference[0]).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(String(inference[1]!.body))).toEqual({
      model: "gpt-6.1-sol",
      input: [],
      store: false,
      stream: true,
    });
    expect(inference[1]!.headers).toMatchObject({
      Authorization: "Bearer private-access",
    });
    expect((await stat(join(f.directory, "chatgpt.json"))).mode & 0o777).toBe(
      0o600,
    );
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    await f.call("/signout", "POST");
    expect(
      await readFile(join(f.directory, "chatgpt.json"), "utf8"),
    ).not.toMatch(/private-access|private-refresh|signed-identity/);
    expect((await (await f.call("/session")).json()).connected).toBe(false);
  });
  it("requires the explicitly granted plan sharing scope", async () => {
    const f = await fixture("openid profile");
    const { callback } = await f.signIn();
    await fetch(callback);
    expect((await (await f.call("/session")).json()).sharing).toBe(false);
    expect(
      (await f.call("/responses", "POST", { model: "gpt-6.1-sol", input: [] }))
        .ok,
    ).toBe(false);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects an unverifiable identity without saving account tokens", async () => {
    const f = await fixture();
    f.verify.mockRejectedValueOnce(new Error("Invalid signature"));
    const { callback } = await f.signIn();
    expect((await fetch(callback)).status).toBe(400);
    expect(
      await readFile(join(f.directory, "chatgpt.json"), "utf8"),
    ).not.toContain("private-access");
  });
});
