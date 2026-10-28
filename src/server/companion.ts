import { safeProviderFailure } from "./provider-error";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

interface StoredAccount {
  hostId: string;
  clientId?: string;
  subject?: string;
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  scopes?: string[];
}
interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  redirect: string;
  clientId: string;
  expiresAt: number;
}
interface Options {
  directory?: string;
  port?: number;
  origins?: string[];
  fetcher?: typeof fetch;
  verify?: (
    token: string,
    audience: string,
    nonce: string,
  ) => Promise<JWTPayload>;
}
const ISSUER = "https://auth.openai.com";
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const random = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export async function createCompanion(options: Options = {}) {
  const directory = resolve(options.directory ?? ".itsalive-local");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, "chatgpt.json");
  let account: StoredAccount;
  try {
    account = JSON.parse(await readFile(path, "utf8")) as StoredAccount;
    if (!account.hostId?.startsWith("urn:uuid:"))
      throw new Error("Invalid connection state.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    account = { hostId: `urn:uuid:${randomUUID()}` };
  }
  const save = async () => {
    const temporary = join(directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(account), { mode: 0o600 });
    await rename(temporary, path);
  };
  await save();
  const fetcher = options.fetcher ?? fetch;
  const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
  const verify =
    options.verify ??
    (async (token, audience, nonce) => {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: ISSUER,
        audience,
        requiredClaims: ["exp", "sub", "nonce"],
      });
      if (payload.nonce !== nonce)
        throw new Error("The sign-in could not be verified.");
      return payload;
    });
  const allowed = new Set(
    options.origins ?? [
      "https://itsalive.org",
      "http://itsalive.localhost:4173",
    ],
  );
  const csrf = random();
  let pending: Pending | undefined;
  let authenticating = false;
  let lastError: string | undefined;
  let refreshing: Promise<string> | undefined;
  const sharing = () =>
    !!account.accessToken &&
    !!account.scopes?.includes("chatgpt.tokens.use.direct");
  const tokens = async (parameters: URLSearchParams) => {
    const result = await fetcher(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: parameters,
      signal: AbortSignal.timeout(30_000),
    });
    if (!result.ok)
      throw new Error(
        "ChatGPT sign-in expired or could not be completed. Please connect again.",
      );
    const data = (await result.json()) as Record<string, any>;
    if (
      typeof data.access_token !== "string" ||
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    )
      throw new Error("ChatGPT returned an incomplete sign-in.");
    return data;
  };
  const accessToken = async (): Promise<string> => {
    if (!sharing())
      throw new Error("Connect ChatGPT and enable plan usage first.");
    if ((account.expiresAt ?? 0) > Date.now() + 60_000)
      return account.accessToken!;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      if (!account.refreshToken || !account.clientId)
        throw new Error("Reconnect your ChatGPT account.");
      const data = await tokens(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: account.clientId,
          refresh_token: account.refreshToken,
          resource: RESOURCE,
        }),
      );
      account = {
        ...account,
        accessToken: data.access_token,
        refreshToken:
          typeof data.refresh_token === "string"
            ? data.refresh_token
            : account.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
        scopes:
          typeof data.scope === "string"
            ? data.scope.split(" ")
            : account.scopes,
      };
      await save();
      if (!sharing()) throw new Error("Enable ChatGPT plan usage to continue.");
      return account.accessToken!;
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status: number, data: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      response.statusCode = status;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(data));
    };
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 1456;
    if (request.headers.host !== `127.0.0.1:${port}`) {
      send(403, { error: "Unexpected host." });
      return;
    }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/auth/callback" && request.method === "GET") {
      const attempt = pending;
      if (
        !attempt ||
        attempt.expiresAt < Date.now() ||
        !equal(url.searchParams.get("state") ?? "", attempt.state)
      ) {
        send(400, {
          error:
            "This sign-in attempt is no longer valid. Start again in It’s Alive.",
        });
        return;
      }
      pending = undefined;
      authenticating = true;
      try {
        if (url.searchParams.has("error"))
          throw new Error("Sign-in was cancelled. You can try again.");
        const code = url.searchParams.get("code");
        const issued = url.searchParams.get("client_id") ?? attempt.clientId;
        if (
          !code ||
          issued === "dynamic_agent_client" ||
          (attempt.clientId !== "dynamic_agent_client" &&
            issued !== attempt.clientId)
        )
          throw new Error(
            "ChatGPT registration was incomplete. Please try again.",
          );
        // Retain the issued registration even if this one-use code expires.
        account.clientId = issued;
        await save();
        const data = await tokens(
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: issued,
            code,
            code_verifier: attempt.verifier,
            redirect_uri: attempt.redirect,
            resource: RESOURCE,
          }),
        );
        if (typeof data.id_token !== "string")
          throw new Error("ChatGPT did not return a verifiable identity.");
        const identity = await verify(data.id_token, issued, attempt.nonce);
        if (
          !identity.sub ||
          (account.subject && identity.sub !== account.subject)
        )
          throw new Error(
            "This connection belongs to another ChatGPT account.",
          );
        account = {
          ...account,
          clientId: issued,
          subject: identity.sub,
          email:
            typeof identity.email === "string" ? identity.email : undefined,
          idToken: data.id_token,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          scopes: typeof data.scope === "string" ? data.scope.split(" ") : [],
          expiresAt: Date.now() + data.expires_in * 1000,
        };
        await save();
        lastError = undefined;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; style-src 'unsafe-inline'",
        );
        response.end(
          '<!doctype html><title>Connected to It’s Alive</title><main style="font:18px system-ui;max-width:560px;margin:15vh auto;padding:24px"><h1>Connected to It’s Alive</h1><p>You can close this window and return to the application.</p></main>',
        );
      } catch (error) {
        lastError =
          error instanceof Error ? error.message : "Sign-in could not finish.";
        send(400, { error: lastError });
      } finally {
        authenticating = false;
      }
      return;
    }
    const origin = request.headers.origin;
    if (!origin || !allowed.has(origin)) {
      send(403, { error: "Unexpected application origin." });
      return;
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
    response.setHeader("Vary", "Origin");
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, X-Itsalive-Session, X-ItsAlive-Debug",
      );
      response.setHeader("Access-Control-Allow-Private-Network", "true");
      response.statusCode = 204;
      response.end();
      return;
    }
    if (pending && pending.expiresAt < Date.now()) {
      pending = undefined;
      lastError = "Sign-in timed out. Please try again.";
    }
    if (url.pathname === "/session" && request.method === "GET") {
      send(200, {
        connected: !!account.accessToken,
        sharing: sharing(),
        email: account.email,
        csrf,
        pending: !!pending || authenticating,
        error: lastError,
      });
      return;
    }
    if (
      !equal(
        typeof request.headers["x-itsalive-session"] === "string"
          ? request.headers["x-itsalive-session"]
          : "",
        csrf,
      )
    ) {
      send(403, { error: "Reconnect the application to its local helper." });
      return;
    }
    try {
      if (url.pathname === "/signin" && request.method === "POST") {
        if (authenticating) {
          send(409, { error: "Sign-in is already finishing." });
          return;
        }
        const verifier = random();
        const state = random();
        const nonce = random();
        const redirect = `http://127.0.0.1:${port}/auth/callback`;
        const clientId = account.clientId ?? "dynamic_agent_client";
        pending = {
          verifier,
          state,
          nonce,
          redirect,
          clientId,
          expiresAt: Date.now() + 5 * 60_000,
        };
        lastError = undefined;
        const parameters = new URLSearchParams({
          client_id: clientId,
          ext_agent_host_id: account.hostId,
          response_type: "code",
          redirect_uri: redirect,
          scope:
            "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
          resource: RESOURCE,
          state,
          nonce,
          code_challenge_method: "S256",
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
        });
        if (clientId === "dynamic_agent_client")
          parameters.set("agent_name_hint", "It's Alive");
        if (account.idToken) parameters.set("id_token_hint", account.idToken);
        send(200, { url: `${ISSUER}/api/accounts/authorize?${parameters}` });
        return;
      }
      if (url.pathname === "/signout" && request.method === "POST") {
        if (authenticating) {
          send(409, { error: "Wait for sign-in to finish." });
          return;
        }
        if (refreshing) await refreshing.catch(() => {});
        pending = undefined;
        let revoked = true;
        if (account.refreshToken && account.clientId) {
          try {
            const discovery = await fetcher(
              `${ISSUER}/.well-known/openid-configuration`,
              { signal: AbortSignal.timeout(5000) },
            );
            const info = (await discovery.json()) as {
              revocation_endpoint?: string;
            };
            if (
              !info.revocation_endpoint ||
              new URL(info.revocation_endpoint).origin !== ISSUER
            )
              throw new Error("No revocation endpoint");
            const result = await fetcher(info.revocation_endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                token: account.refreshToken,
                token_type_hint: "refresh_token",
                client_id: account.clientId,
              }),
              signal: AbortSignal.timeout(5000),
            });
            revoked = result.ok;
          } catch {
            revoked = false;
          }
        }
        account = {
          hostId: account.hostId,
          clientId: account.clientId,
          subject: account.subject,
          email: account.email,
        };
        await save();
        lastError = revoked
          ? undefined
          : "Signed out on this device. Remote sign-out could not be confirmed; you can disconnect the app in ChatGPT Settings.";
        send(200, { signedOut: true, revoked });
        return;
      }
      if (
        (url.pathname === "/responses" && request.method === "POST") ||
        (url.pathname === "/models" && request.method === "GET")
      ) {
        const token = await accessToken();
        const controller = new AbortController();
        response.on("close", () => {
          if (!response.writableEnded) controller.abort();
        });
        let body: Record<string, unknown> | undefined;
        if (request.method === "POST") {
          body = JSON.parse(await readBody(request));
          if (
            !body ||
            typeof body.model !== "string" ||
            !Array.isArray(body.input)
          ) {
            send(400, { error: "Invalid AI request." });
            return;
          }
          const allowedFields = [
            "model",
            "input",
            "instructions",
            "tools",
            "tool_choice",
            "parallel_tool_calls",
            "reasoning",
            "text",
            "service_tier",
            "include",
          ];
          body = {
            ...Object.fromEntries(
              Object.entries(body).filter(([key]) =>
                allowedFields.includes(key),
              ),
            ),
            store: false,
            stream: true,
          };
        }
        const result = await fetcher(`${RESOURCE}${url.pathname}`, {
          method: request.method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
        if (!result.ok) {
          const safe = safeProviderFailure(
            await result.json().catch(() => null),
            {
              includeContent: request.headers["x-itsalive-debug"] === "1",
              secrets: [token],
            },
          );
          if (result.headers.get("x-request-id"))
            response.setHeader(
              "X-Request-Id",
              result.headers.get("x-request-id")!,
            );
          send(result.status, {
            ...safe,
            error: {
              ...(safe.error as Record<string, unknown>),
              message:
                "ChatGPT could not complete the request. Check your connection, model access and plan allowance.",
            },
          });
          return;
        }
        response.statusCode = result.status;
        if (result.headers.get("x-request-id"))
          response.setHeader(
            "X-Request-Id",
            result.headers.get("x-request-id")!,
          );
        response.setHeader(
          "Content-Type",
          result.headers.get("content-type") ?? "application/json",
        );
        await copyBody(result, response);
        return;
      }
      send(404, { error: "Unknown action." });
    } catch {
      send(502, {
        error:
          "The ChatGPT connection could not complete this action. Reconnect your account and try again.",
      });
    }
  });
  return {
    server,
    listen: async () => {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 1456, "127.0.0.1", () => resolve());
      });
      return server;
    },
  };
}
async function readBody(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of request) {
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}
async function copyBody(result: Response, response: ServerResponse) {
  if (result.body) {
    const reader = result.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Honor the browser's backpressure instead of buffering an unbounded
        // model response in the local helper's memory.
        if (!response.write(value)) {
          const controller = new AbortController();
          const closed = () => controller.abort();
          response.once("close", closed);
          try {
            await once(response, "drain", { signal: controller.signal });
          } finally {
            response.off("close", closed);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  response.end();
}
