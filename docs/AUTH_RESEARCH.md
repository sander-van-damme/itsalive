# ChatGPT allowance connection

Researched 26 October 2026 and checked again 28 October 2026 against OpenAI documentation and the official Codex source. This document distinguishes account identity from permission to use the ChatGPT/Codex allowance.

## What the provider actually supports

OpenAI's [ChatGPT plan usage documentation](https://developers.openai.com/siwc/token-sharing-open-source) describes a third-party allowance integration, separate from ordinary account identity. Its public open-source registration flow is for local installations. Remotely hosted or paid applications are directed to the provider's interest process. An ordinary website identity client is not evidence of allowance permission.

The [registration reference](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) specifies authorization code with PKCE, state and OIDC nonce. The `dynamic_agent_client` entry point issues a client for a user's account/workspace, uses a stable host identifier and an HTTP `127.0.0.1` callback. It does **not** document registering an arbitrary hosted HTTPS callback with that entry point. Reusing it with `https://itsalive.org` would be an unverified flow, not completed hosted support.

The [website documentation](https://developers.openai.com/siwc/website) supports registered public clients without a client secret, with exact callback URLs and signed identity validation. It currently describes a limited partner trial and identity scopes. [Request a client ID](https://developers.openai.com/siwc/request-client-id) links to the provider's interest form. A hosted client must separately be provisioned for the plan scopes before it can fulfill this feature.

We also checked Codex itself, rather than assuming that identity login answered the request. The [official authentication guide](https://learn.chatgpt.com/docs/auth) documents `codex login --device-auth` for the Codex CLI, including headless environments. The [official device-login source](https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs) requests a code for the configured Codex client, polls `/api/accounts/deviceauth/token`, exchanges the resulting authorization code, and persists Codex credentials. Its login prompt specifically distinguishes a login initiated in Codex from a code supplied by a website. Neither source documents borrowing Codex's first-party client identity as a registration-free third-party hosted-app contract. The repository therefore does not impersonate that client. The device flow is technically composed of HTTP requests, polling and a token exchange; the source does not establish a browser-storage or fundamental transport impossibility. What is missing is a documented, provisioned allowance grant for this independent hosted application. This implementation uses the registered-client route; it does not claim that every possible device-flow integration is technically impossible or that a generic browser-security objection settles the request.

## Implemented

- Hosted ChatGPT remains selectable. Only selecting it reveals setup/connection information.
- A browser-owned OAuth transaction generates independent cryptographic state, nonce and PKCE verifier; the callback validates state, exact URL and expiry, and consumes the transaction before exchange.
- A stateless same-origin boundary exchanges and refreshes tokens with the documented OpenAI endpoint. `jose` validates signature, issuer, audience, expiry, subject and the initial nonce. It stores no account credentials on the server.
- Credentials persist in this browser as requested. Refresh rotation is serialized, including across tabs where Web Locks is available. Signing out clears the local credentials before attempting provider revocation and cannot be undone by an outstanding refresh.
- Identity-only sign-in remains distinguishable from plan authorization. Catalog and inference requests require the granted `chatgpt.tokens.use.direct` scope, including after refresh. A narrowed grant is persisted for accurate account status/sign-out and blocks dispatch immediately; there is no API-key billing fallback. Revoked refresh credentials clear the browser connection and stale model choices. Cancelling a request during shared refresh stops that caller without interrupting another caller’s refresh.
- Plan requests stream through the public Responses endpoint, with `store:false`, no output cap and no unsupported `truncation` parameter. See the [provider's preview restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
- Local open-source installations retain their existing documented loopback helper and account registration.
- The first-run UI has connection and optional spending steps. Model choices remain in advanced settings; speed lives in the workspace controls. Normal settings groups connection, usage, preferences, backup and diagnostics. Debug mode captures prompts and responses with credentials redacted.

## Deployment values still required

1. Obtain a public client registered for It's Alive, token-endpoint authentication method `none`, **with hosted ChatGPT plan usage explicitly enabled**. Identity access alone is insufficient.
2. Register the exact production callback `https://itsalive.org/auth/chatgpt/callback`. Register any preview/local callback separately; origins cannot be substituted.
3. Set the Worker variable `CHATGPT_CLIENT_ID` to that public client ID. No client secret is sent to the browser or required by this implementation. For local Vite testing of the hosted flow, set the same environment variable before starting the server.
4. The requested scopes are `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, with resource `https://api.openai.com/v1`. Confirm those plan grants with the provider when provisioning the hosted client.
5. Verify the authorized live login, refresh, model catalog, a small streamed request against the account allowance, and revocation with the actual provisioned client. A mock login is not evidence of those provider-side permissions.

`GET /api/chatgpt/config` returns only public connection configuration. Missing registration produces an actionable connection status; it never pretends to sign in. Browser local storage keys use the `itsalive.chatgpt.*` prefix and are excluded from backups and restore. API credentials remain in their separate excluded credential store. Live voice requires a separately disclosed OpenAI API key because the documented plan API does not provide its audio session route.

## Validation and remaining limit

Automated tests cover PKCE construction, state rejection and callback replay, provider origin boundaries, signature-validation invocation with audience/nonce, identity without plan scope, refresh rotation/concurrency, sign-out versus refresh races, exact callback enforcement, missing configuration, supported plan request parameters, and the retained local helper. Browser acceptance tests exercise the popup/callback and settings steps with explicit provider fixtures.

No registered hosted public client or live provider credential was available in the execution environment. The implementation is reviewable and configurable; production hosted allowance access remains unverified until the provider issues the required client/grant and the live checks above pass. Browser storage is implemented, not deferred.
