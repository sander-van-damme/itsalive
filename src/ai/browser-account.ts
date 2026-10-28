import { redactCredentials } from "../shared/redaction";
/** Browser-owned ChatGPT plan credentials. This store is intentionally outside app backups. */
export const ACCOUNT_STORAGE_KEY = "itsalive.chatgpt.account";
export const ACCOUNT_HOST_KEY = "itsalive.chatgpt.host";
export const ACCOUNT_PENDING_KEY = "itsalive.chatgpt.pending";
export const ACCOUNT_RESULT_KEY = "itsalive.chatgpt.result";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const TRANSACTION_LIFETIME = 10 * 60 * 1000;
export class AccountConnectionError extends Error {
  constructor(
    message: string,
    readonly kind: "credentials" | "access" | "connection" = "credentials",
    readonly code?: string,
  ) {
    super(message);
    this.name = "AccountConnectionError";
  }
}

export interface BrowserAccountConfiguration {
  configured: boolean;
  clientId: string | null;
  issuer: string;
  authorizationEndpoint: string;
  redirectUri: string;
  error?: string;
}
interface AccountTokens {
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  scopes: string[];
  subject: string;
  email?: string;
}
interface Transaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
  exchanging?: boolean;
}
interface AccountDependencies {
  storage: Storage;
  origin: string;
  fetcher?: typeof fetch;
  crypto?: Crypto;
  now?: () => number;
  locks?: Pick<LockManager, "request">;
}
function encoded(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export class BrowserAccount {
  private readonly fetcher: typeof fetch;
  private readonly random: Crypto;
  private readonly now: () => number;
  private refreshing?: Promise<AccountTokens>;
  constructor(private readonly dependencies: AccountDependencies) {
    this.fetcher = dependencies.fetcher ?? fetch;
    this.random = dependencies.crypto ?? crypto;
    this.now = dependencies.now ?? Date.now;
  }
  private read<T>(key: string): T | undefined {
    try {
      return (
        JSON.parse(this.dependencies.storage.getItem(key) ?? "null") ??
        undefined
      );
    } catch {
      return undefined;
    }
  }
  private write(key: string, value: unknown) {
    this.dependencies.storage.setItem(key, JSON.stringify(value));
  }
  /** Redact accidental credential pastes without exposing credentials to diagnostic consumers. */
  redactDiagnostic(value: unknown): unknown {
    const tokens = this.read<AccountTokens>(ACCOUNT_STORAGE_KEY);
    const pending = this.read<Transaction>(ACCOUNT_PENDING_KEY);
    return redactCredentials(value, {
      secrets: [
        tokens?.accessToken,
        tokens?.refreshToken,
        tokens?.idToken,
        pending?.codeVerifier,
        pending?.nonce,
        pending?.state,
      ].filter((item): item is string => !!item),
    });
  }
  private async api(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const fetcher = this.fetcher;
    return fetcher(`${this.dependencies.origin}/api/chatgpt${path}`, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
      signal,
    });
  }
  private async result<T>(response: Response): Promise<T> {
    const result = (await response.json()) as T & {
      error?: { message?: string; code?: string };
    };
    if (!response.ok)
      throw new AccountConnectionError(
        result.error?.message ?? "ChatGPT could not complete this connection.",
        response.status >= 500
          ? "connection"
          : response.status === 403
            ? "access"
            : "credentials",
        result.error?.code,
      );
    return result;
  }
  async configuration(
    signal?: AbortSignal,
  ): Promise<BrowserAccountConfiguration> {
    const config = await this.result<BrowserAccountConfiguration>(
      await this.api("/config", undefined, signal),
    );
    if (
      config.issuer !== "https://auth.openai.com" ||
      config.authorizationEndpoint !==
        "https://auth.openai.com/api/accounts/authorize" ||
      config.redirectUri !== `${this.dependencies.origin}/auth/chatgpt/callback`
    )
      throw new Error(
        "The website's ChatGPT connection is not configured correctly.",
      );
    return config;
  }
  async session(signal?: AbortSignal) {
    const config = await this.configuration(signal);
    const tokens = this.read<AccountTokens>(ACCOUNT_STORAGE_KEY);
    const pending = this.read<Transaction>(ACCOUNT_PENDING_KEY);
    const result = this.read<{ error: string; expiresAt: number }>(
      ACCOUNT_RESULT_KEY,
    );
    const connected =
      !!tokens?.accessToken &&
      tokens.clientId === config.clientId &&
      (tokens.expiresAt > this.now() || !!tokens.refreshToken);
    return {
      connected,
      sharing:
        connected &&
        Array.isArray(tokens?.scopes) &&
        tokens.scopes.includes(PLAN_SCOPE),
      csrf: "",
      email: connected ? tokens?.email : undefined,
      pending: !!pending && pending.expiresAt > this.now(),
      error: !config.configured
        ? config.error
        : result && result.expiresAt > this.now()
          ? result.error
          : undefined,
    };
  }
  async begin(signal?: AbortSignal): Promise<string> {
    const config = await this.configuration(signal);
    if (!config.configured || !config.clientId)
      throw new Error(
        config.error ??
          "ChatGPT sign-in has not been configured for this website yet.",
      );
    if (config.clientId === "dynamic_agent_client")
      throw new Error("This website needs its registered ChatGPT client ID.");
    const random = () =>
      encoded(this.random.getRandomValues(new Uint8Array(32)));
    const transaction: Transaction = {
      state: random(),
      nonce: random(),
      codeVerifier: random(),
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      expiresAt: this.now() + TRANSACTION_LIFETIME,
    };
    const challenge = encoded(
      new Uint8Array(
        await this.random.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(transaction.codeVerifier),
        ),
      ),
    );
    let host = this.dependencies.storage.getItem(ACCOUNT_HOST_KEY);
    if (!host) {
      host = `urn:uuid:${this.random.randomUUID()}`;
      this.dependencies.storage.setItem(ACCOUNT_HOST_KEY, host);
    }
    this.write(ACCOUNT_PENDING_KEY, transaction);
    this.dependencies.storage.removeItem(ACCOUNT_RESULT_KEY);
    const url = new URL(config.authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope:
        "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1",
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ext_agent_host_id: host,
    }).toString();
    return url.href;
  }
  /** The callback consumes the transaction before exchanging, so reload/replay cannot reuse a code. */
  async complete(callback: URL, signal?: AbortSignal): Promise<void> {
    if (this.dependencies.locks) {
      await this.dependencies.locks.request(
        "itsalive-chatgpt-callback",
        async () => this.completeTransaction(callback, signal),
      );
      return;
    }
    await this.completeTransaction(callback, signal);
  }
  private async completeTransaction(
    callback: URL,
    signal?: AbortSignal,
  ): Promise<void> {
    const pending = this.read<Transaction>(ACCOUNT_PENDING_KEY);
    if (
      !pending ||
      pending.exchanging ||
      pending.expiresAt <= this.now() ||
      callback.origin + callback.pathname !== pending.redirectUri ||
      callback.searchParams.get("state") !== pending.state
    )
      throw new Error(
        "This sign-in attempt expired or did not match. Start again from It's Alive.",
      );
    this.write(ACCOUNT_PENDING_KEY, { ...pending, exchanging: true });
    try {
      if (callback.searchParams.has("error"))
        throw new Error(
          "ChatGPT sign-in was cancelled or denied. You can try again.",
        );
      const code = callback.searchParams.get("code");
      const issuedClient = callback.searchParams.get("client_id");
      if (!code || (issuedClient && issuedClient !== pending.clientId))
        throw new Error(
          "ChatGPT returned an unexpected sign-in response. Please try again.",
        );
      const tokens = await this.result<AccountTokens>(
        await this.api(
          "/token",
          {
            grantType: "authorization_code",
            code,
            codeVerifier: pending.codeVerifier,
            nonce: pending.nonce,
            redirectUri: pending.redirectUri,
          },
          signal,
        ),
      );
      if (
        !tokens.accessToken ||
        !tokens.subject ||
        tokens.clientId !== pending.clientId ||
        !Number.isFinite(tokens.expiresAt)
      )
        throw new Error(
          "ChatGPT returned an incomplete connection. Please try again.",
        );
      // Identity alone does not authorize allowance use. Keep the identity so the user can sign out.
      if (this.read<Transaction>(ACCOUNT_PENDING_KEY)?.state !== pending.state)
        throw new Error("The sign-in was cancelled. Please start again.");
      this.write(ACCOUNT_STORAGE_KEY, {
        ...tokens,
        scopes: tokens.scopes ?? [],
      });
      this.dependencies.storage.removeItem(ACCOUNT_RESULT_KEY);
    } catch (error) {
      if (this.read<Transaction>(ACCOUNT_PENDING_KEY)?.state === pending.state)
        this.write(ACCOUNT_RESULT_KEY, {
          error:
            error instanceof Error ? error.message : "ChatGPT sign-in failed.",
          expiresAt: this.now() + TRANSACTION_LIFETIME,
        });
      throw error;
    } finally {
      const current = this.read<Transaction>(ACCOUNT_PENDING_KEY);
      if (current?.state === pending.state)
        this.dependencies.storage.removeItem(ACCOUNT_PENDING_KEY);
    }
  }
  private async token(force = false): Promise<AccountTokens> {
    if (this.refreshing) return this.refreshing;
    const refresh = async () => {
      const stored = this.dependencies.storage.getItem(ACCOUNT_STORAGE_KEY);
      const current = this.read<AccountTokens>(ACCOUNT_STORAGE_KEY);
      if (!current?.accessToken)
        throw new AccountConnectionError("Connect your ChatGPT account.");
      if (
        !Array.isArray(current.scopes) ||
        !current.scopes.includes(PLAN_SCOPE)
      )
        throw new AccountConnectionError(
          "This account is signed in, but ChatGPT has not granted plan usage. Enable plan usage and reconnect.",
          "access",
        );
      if (!force && current.expiresAt > this.now() + 60_000) return current;
      if (!current.refreshToken)
        throw new AccountConnectionError(
          "Your ChatGPT sign-in expired. Please connect again.",
        );
      let result: Partial<AccountTokens>;
      try {
        result = await this.result<Partial<AccountTokens>>(
          await this.api("/token", {
            grantType: "refresh_token",
            refreshToken: current.refreshToken,
            subject: current.subject,
          }),
        );
      } catch (error) {
        if (
          error instanceof AccountConnectionError &&
          ["invalid_grant", "identity_mismatch"].includes(error.code ?? "") &&
          stored === this.dependencies.storage.getItem(ACCOUNT_STORAGE_KEY)
        )
          this.dependencies.storage.removeItem(ACCOUNT_STORAGE_KEY);
        throw error;
      }
      if (
        !result.accessToken ||
        result.clientId !== current.clientId ||
        !Number.isFinite(result.expiresAt)
      )
        throw new AccountConnectionError(
          "ChatGPT could not refresh this connection. Please connect again.",
        );
      if (stored !== this.dependencies.storage.getItem(ACCOUNT_STORAGE_KEY))
        throw new AccountConnectionError(
          "The ChatGPT connection changed. Please try again.",
        );
      const next = { ...current, ...result } as AccountTokens;
      this.write(ACCOUNT_STORAGE_KEY, next);
      // Refresh may explicitly narrow the grant. Preserve that updated identity
      // for sign-out, but never dispatch a request using its previous allowance.
      if (!Array.isArray(next.scopes) || !next.scopes.includes(PLAN_SCOPE))
        throw new AccountConnectionError(
          "ChatGPT no longer grants plan usage to this connection. Enable plan usage and reconnect.",
          "access",
          "plan_access_revoked",
        );
      return next;
    };
    const operation = (async () =>
      this.dependencies.locks
        ? await this.dependencies.locks.request(
            "itsalive-chatgpt-refresh",
            refresh,
          )
        : await refresh())();
    this.refreshing = operation;
    try {
      return await operation;
    } finally {
      this.refreshing = undefined;
    }
  }
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (path !== "/models" && path !== "/responses")
      throw new Error("Unknown ChatGPT action.");
    const send = async (force = false) => {
      const signal = init.signal;
      signal?.throwIfAborted();
      // One caller can stop waiting while another still needs the same refresh.
      // Cancelling the shared exchange would cancel unrelated application work.
      const account = signal
        ? await new Promise<AccountTokens>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            this.token(force).then(
              (value) => {
                signal.removeEventListener("abort", abort);
                resolve(value);
              },
              (error) => {
                signal.removeEventListener("abort", abort);
                reject(error);
              },
            );
          })
        : await this.token(force);
      signal?.throwIfAborted();
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${account.accessToken}`);
      const fetcher = this.fetcher;
      return fetcher(`${this.dependencies.origin}/api/chatgpt${path}`, {
        ...init,
        headers,
        cache: "no-store",
      });
    };
    const response = await send();
    if (response.status !== 401) return response;
    await response.body?.cancel();
    return send(true);
  }
  async signout(): Promise<Response> {
    const account = this.read<AccountTokens>(ACCOUNT_STORAGE_KEY);
    this.dependencies.storage.removeItem(ACCOUNT_STORAGE_KEY);
    this.dependencies.storage.removeItem(ACCOUNT_PENDING_KEY);
    this.dependencies.storage.removeItem(ACCOUNT_RESULT_KEY);
    // Local sign-out completes even if the optional provider revocation is unavailable.
    try {
      const response = await this.api(
        "/signout",
        { refreshToken: account?.refreshToken },
        AbortSignal.timeout(10_000),
      );
      return response.ok
        ? response
        : Response.json({ signedOut: true, revoked: false });
    } catch {
      return Response.json({ signedOut: true, revoked: false });
    }
  }
}
