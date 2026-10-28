import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { safeProviderFailure } from "./provider-error";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

export interface ChatGPTAccountOptions {
  /** A registered public client with the site's exact callback and plan permission. */
  clientId?: string;
  fetcher?: typeof fetch;
  verifyIdentity?: (
    token: string,
    audience: string,
    nonce?: string,
  ) => Promise<JWTPayload>;
}

/** Stateless OAuth boundary. Account tokens are returned to this browser, never persisted by the server. */
export async function handleChatGPTAccountAPI(
  request: Request,
  options: ChatGPTAccountOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/chatgpt".length);
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers });
  const fail = (
    message: string,
    status = 400,
    code = "account_request_failed",
  ) => json({ error: { message, code } }, status);
  const clientId = options.clientId?.trim();
  const redirectUri = `${url.origin}/auth/chatgpt/callback`;
  const origin = request.headers.get("origin");
  if (
    (origin && origin !== url.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return fail("Unexpected application origin.", 403, "origin_mismatch");
  if (path === "/config" && request.method === "GET")
    return json({
      configured: !!clientId,
      clientId: clientId ?? null,
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/api/accounts/authorize`,
      redirectUri,
      ...(!clientId
        ? {
            error:
              "ChatGPT sign-in has not been configured for this website yet.",
          }
        : {}),
    });
  if (request.method !== "GET" && origin !== url.origin)
    return fail("Unexpected application origin.", 403, "origin_mismatch");
  if (!clientId)
    return fail(
      "ChatGPT sign-in has not been configured for this website yet.",
      503,
      "client_not_configured",
    );
  if (clientId === "dynamic_agent_client")
    return fail(
      "This website needs its registered ChatGPT client ID.",
      503,
      "registered_client_required",
    );
  const fetcher = options.fetcher ?? fetch;
  const verify =
    options.verifyIdentity ??
    (async (token, audience, nonce) => {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: ISSUER,
        audience,
        requiredClaims: ["exp", "sub", ...(nonce ? ["nonce"] : [])],
      });
      if (nonce && payload.nonce !== nonce)
        throw new Error("Sign-in identity did not match this attempt.");
      return payload;
    });
  try {
    if (path === "/token" && request.method === "POST") {
      if (!request.headers.get("content-type")?.includes("application/json"))
        return fail("A JSON request is required.", 415);
      const body = (await request.json()) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body))
        return fail("A JSON object is required.");
      const parameters = new URLSearchParams({
        client_id: clientId,
        resource: RESOURCE,
      });
      let nonce: string | undefined;
      if (body.grantType === "authorization_code") {
        if (
          typeof body.code !== "string" ||
          !body.code ||
          typeof body.codeVerifier !== "string" ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(body.codeVerifier) ||
          typeof body.nonce !== "string" ||
          body.nonce.length < 32 ||
          body.redirectUri !== redirectUri
        )
          return fail(
            "This sign-in attempt is incomplete. Please start again.",
            400,
            "invalid_transaction",
          );
        nonce = body.nonce;
        parameters.set("grant_type", "authorization_code");
        parameters.set("code", body.code);
        parameters.set("code_verifier", body.codeVerifier);
        parameters.set("redirect_uri", redirectUri);
      } else if (
        body.grantType === "refresh_token" &&
        typeof body.refreshToken === "string" &&
        body.refreshToken
      ) {
        parameters.set("grant_type", "refresh_token");
        parameters.set("refresh_token", body.refreshToken);
      } else
        return fail("Reconnect your ChatGPT account.", 400, "invalid_grant");
      const response = await fetcher(TOKEN, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: parameters,
        signal: request.signal,
      });
      if (!response.ok) {
        const value = (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const known = new Set([
          "invalid_grant",
          "invalid_client",
          "invalid_scope",
          "unauthorized_client",
          "access_denied",
          "temporarily_unavailable",
        ]);
        const code =
          typeof value?.error === "string" && known.has(value.error)
            ? value.error
            : "token_exchange_failed";
        return fail(
          code === "invalid_grant"
            ? "Your ChatGPT sign-in expired. Please connect again."
            : "ChatGPT did not authorize this connection. Check the website's registered client and plan access.",
          response.status,
          code,
        );
      }
      const data = (await response.json()) as Record<string, unknown>;
      if (
        typeof data.access_token !== "string" ||
        !data.access_token ||
        typeof data.expires_in !== "number" ||
        !Number.isFinite(data.expires_in) ||
        data.expires_in <= 0
      )
        return fail(
          "ChatGPT returned an incomplete connection.",
          502,
          "invalid_token_response",
        );
      if (nonce && typeof data.id_token !== "string")
        return fail(
          "ChatGPT did not return a verifiable identity.",
          502,
          "missing_identity",
        );
      const identity =
        typeof data.id_token === "string"
          ? await verify(data.id_token, clientId, nonce)
          : undefined;
      if (
        identity &&
        (!identity.sub ||
          (typeof body.subject === "string" && identity.sub !== body.subject))
      )
        return fail(
          "The refreshed connection belongs to a different account. Please connect again.",
          401,
          "identity_mismatch",
        );
      return json({
        clientId,
        accessToken: data.access_token,
        ...(typeof data.refresh_token === "string"
          ? { refreshToken: data.refresh_token }
          : {}),
        ...(typeof data.id_token === "string"
          ? { idToken: data.id_token }
          : {}),
        expiresAt: Date.now() + data.expires_in * 1000,
        ...(typeof data.scope === "string"
          ? { scopes: data.scope.split(/\s+/).filter(Boolean) }
          : {}),
        ...(identity
          ? {
              subject: identity.sub,
              email:
                typeof identity.email === "string" ? identity.email : undefined,
            }
          : {}),
      });
    }
    if (path === "/signout" && request.method === "POST") {
      const body = (await request.json()) as { refreshToken?: string };
      if (!body || typeof body !== "object" || Array.isArray(body))
        return fail("A JSON object is required.");
      if (!body.refreshToken) return json({ signedOut: true, revoked: true });
      const discovery = await fetcher(
        `${ISSUER}/.well-known/openid-configuration`,
        { signal: request.signal },
      );
      const info = (await discovery.json()) as { revocation_endpoint?: string };
      if (
        !info.revocation_endpoint ||
        new URL(info.revocation_endpoint).origin !== ISSUER
      )
        return json({ signedOut: true, revoked: false });
      const response = await fetcher(info.revocation_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          token: body.refreshToken,
          token_type_hint: "refresh_token",
        }),
        signal: request.signal,
      });
      return json({ signedOut: true, revoked: response.ok });
    }
    if (
      (path === "/models" && request.method === "GET") ||
      (path === "/responses" && request.method === "POST")
    ) {
      const authorization = request.headers.get("authorization") ?? "";
      if (!/^Bearer [^\s]+$/.test(authorization))
        return fail("Connect your ChatGPT account.", 401, "missing_token");
      let body: Record<string, unknown> | undefined;
      if (path === "/responses") {
        const input = (await request.json()) as Record<string, unknown>;
        if (!input || typeof input !== "object" || Array.isArray(input))
          return fail("A JSON object is required.");
        if (typeof input.model !== "string" || !Array.isArray(input.input))
          return fail("Invalid application request.");
        const allowed = new Set([
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
        ]);
        body = {
          ...Object.fromEntries(
            Object.entries(input).filter(([key]) => allowed.has(key)),
          ),
          store: false,
          stream: true,
        };
      }
      const response = await fetcher(`${RESOURCE}${path}`, {
        method: request.method,
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: request.signal,
      });
      if (!response.ok)
        return Response.json(
          safeProviderFailure(await response.json().catch(() => null), {
            includeContent: request.headers.get("x-itsalive-debug") === "1",
            secrets: [authorization.slice(7)],
          }),
          {
            status: response.status,
            headers: {
              ...headers,
              "X-Request-Id": response.headers.get("x-request-id") ?? "",
            },
          },
        );
      return new Response(response.body, {
        status: response.status,
        headers: {
          ...headers,
          "Content-Type":
            response.headers.get("content-type") ?? "application/json",
          "X-Request-Id": response.headers.get("x-request-id") ?? "",
        },
      });
    }
    return fail("Unknown ChatGPT action.", 404);
  } catch (error) {
    if (path === "/signout") return json({ signedOut: true, revoked: false });
    return fail(
      error instanceof SyntaxError
        ? "The connection request was incomplete."
        : "The ChatGPT connection could not be verified. Please connect again.",
      502,
      "connection_failed",
    );
  }
}
