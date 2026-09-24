# itsalive.org

A browser-native platform for applications that keep building themselves while they are used. The root-domain shell owns the AI agent, history, configuration, and credentials. Every app runs as a persistent HTML document on its own wildcard subdomain and browser origin.

## Beta compatibility policy

itsalive.org is currently in beta. Until the project owner explicitly declares that the product is out of beta and ready for release, breaking changes are expected and preferred over compatibility layers. Beta app data, history, settings, database schemas, URLs, bridge messages, and runtime APIs may be reset or changed without migration. Do not add migration code, deprecated aliases, fallback readers, or other backward-compatibility shims unless they are specifically requested for a current product need.

Once the project owner explicitly declares the product release-ready, compatibility and migration requirements must be reconsidered before making breaking changes.

## Architecture

This repository produces two independent static builds:

| Build | Output | Deployment binding | Responsibility |
| --- | --- | --- | --- |
| Root shell | `dist-root/` | `itsalive.org` | Platform state, policy, and runtime source: apps, persistent documents, Chat, Settings, histories, provider calls, runtime API, injected app runtime, agent loop |
| App bootstrap | `dist-app/` | `*.itsalive.org` | Stable cross-origin bootstrap only: authenticate the shell, establish the bridge/channel, execute the shell-supplied runtime |

The only connection between the two origins is a versioned `postMessage` protocol. Every message is checked for its exact origin, source window, immutable app UUID, direction, request ID, and payload shape. Each app UUID is also its permanent wildcard subdomain; display names can be changed independently. Provider credentials remain in root-origin storage and are never sent into app frames.

### Thin app-bootstrap invariant

Keep the wildcard app deployment as close to a dumb puppet as possible. `src/app` should contain only the small, stable bootstrap needed to identify its UUID origin, authenticate/validate the root shell, establish the cross-origin communication channel, and execute a shell-supplied runtime payload. Substantive runtime code is owned, built, and versioned by the root shell even when that code must execute inside the app origin.

This distinction is fundamental: **where code executes does not determine who owns or deploys that code**. DOM access, generated-code execution, interaction capture, screenshots, document serialization/restoration, logging hooks, durability checks, runtime API installation, and app-origin browser operations may execute in the wildcard frame, but their implementation should normally be delivered by the shell at initialization rather than baked into `dist-app`.

The shell initializes each app over the validated bootstrap handshake, transferring a dedicated `MessagePort` for subsequent runtime traffic and supplying only the current runtime payload through the bootstrap. After platform assets/APIs and the authenticated bridge are active, the injected runtime requests the shell-owned saved document, restores app-authored setup before reactive hydration, starts the required observers/handlers, and reports readiness. A newly mounted app therefore runs the runtime version belonging to the currently loaded shell; changing ordinary runtime behavior should not require redeploying the wildcard app.

Persistent app state remains shell-owned as separate markup and app-authored setup-script snapshots: the injected runtime may normalize/serialize and restore the live DOM because those operations require app-origin document access, but snapshots are sent back for root-origin persistence. Platform/bootstrap assets are excluded from saved markup. Do not add platform-private durable storage to the app origin.

The `window.application` and `window.agent` globals follow the same rule. Their contracts and implementations are shell-owned and delivered by the injected runtime rather than baked into the permanent app bootstrap. `application` is for durable/generated-app capabilities; `agent` is for coding/inspection capabilities. Generated apps otherwise use ordinary browser APIs directly.

## Included capabilities

- Per-app origin isolation with no storage namespaces or shared app database.
- IndexedDB shell repositories for app metadata, persistent app HTML/state, full history, and logs.
- Shell-injected runtime initialization over the cross-origin bridge, including persistent HTML restoration/saving, form-control normalization, script re-execution, observation, screenshots, logging, and runtime API installation.
- JavaScript agent loop with `agent.done()`, bounded observations, time/cost/progress budgets, explicit failure/stall stop reasons, and streamed multi-command responses whose completed commands execute immediately while generation continues.
- A user-facing intent layer that separates explanation/question/preference handling from explicit change requests and translates authorized changes into compact technical intents.
- Coding-context budgeting that always retains the immutable system prompt, app prompt, and current technical intent while excluding raw user/assistant chat from automatic worker history.
- OpenRouter-only provider registry and OpenAI-style HTTP/SSE adapter.
- Native DOM inspection through ordinary browser APIs and execution results, plus coding-agent screenshot and curated-memory capabilities.
- App-to-shell generation requests and explicit escalation to the external coding agent, with canonical capability metadata used for agent help.
- Tailwind's browser runtime, Alpine.js with common plugins, Feather Icons, and preloaded browser libraries for charts, visualization, 3D, diagrams, math, dates, sliders, maps, animation, CSV, fuzzy search, and code highlighting. Runtime Tailwind deliberately supports utility classes introduced by the LLM after load rather than relying on build-time source scanning.
- Responsive, accessible shell UI for app creation/switching, chat, prompts, provider setup, reload, deletion, and log export.

## Local development

Requirements: Node.js 20 or newer and npm.

```bash
npm install
npm run dev
```

The root domain is fixed to `itsalive.org`. Local wildcard-origin testing therefore requires local DNS overrides for `itsalive.org` and its app subdomains. `npm run dev` serves the shell on port 4173, while `npm run dev:app` serves the app build separately on port 4174 for isolated runtime development.

## Commands

```bash
npm run dev          # root shell development server
npm run dev:app      # app runtime development server
npm run build        # both production static builds
npm run build:root   # root shell only
npm run build:app    # wildcard app site only
npm run typecheck    # strict TypeScript validation
npm test             # Vitest suite
npm run lint         # ESLint
```

## Provider configuration

Open **Settings** in the shell, add your OpenRouter API key, and press **Save**. The shell tests the key before saving it. All product LLM requests use OpenRouter's `openrouter/auto` model. The shell does not send a client-side generation-token ceiling; OpenRouter and the routed model determine generation length. The shell loads Auto Router's current context capacity from OpenRouter's authenticated user model catalogue instead of hardcoding it.\n\nFor context experiments, Settings exposes a **History budget (tokens)** value. It controls only how many tokens of prior technical agent history (generated JavaScript, execution observations, and errors) may be included in a coding turn. Raw user/assistant chat is kept for the user-facing conversation but is not automatically inherited by coding sessions. The system prompt, app prompt, current technical intent, and current observations are separate. The effective request remains bounded by the live model context capacity. Diagnostic logs record the configured history budget, selected technical-history tokens, estimated total input, omitted-history count, model capacity, and provider-reported token usage so test runs can be compared.

OpenRouter requests happen directly from root-origin browser JavaScript. Credentials are saved only in root-origin `localStorage`; use the runtime only on a trusted device and origin.

## Cloudflare Workers Static Assets

Two Wrangler configurations are included:

```bash
npx wrangler deploy
npx wrangler deploy --config wrangler.app.toml
```

Configure the first Worker route/custom domain for the exact root host and the second for the wildcard host. Configure DNS and certificates for both. The generated assets use SPA fallback so UUID app subdomains serve the same runtime bootstrap.

## Runtime API

Generated application code uses native browser APIs plus a deliberately small shell-owned `application` global:

```js
application.store
application.generate(prompt)
application.escalate(reason)
```

`application.store` is a durable JSON-like object tree persisted atomically with the app document. Ordinary app state can use normal JavaScript property access and initialization such as `application.store.counter ??= { count: 0 }`. Larger, binary, or query-heavy data may still use native IndexedDB directly.

`application.generate(prompt)` returns model-generated content to the running app. `application.escalate(reason)` instead hands a problem to the external coding agent; it is not a content-generation call and does not return the agent's work product.

Coding commands also receive a small `agent` global:

```js
await agent.memory()
await agent.screenshot()
return agent.done(message)
```

`agent.memory()` exposes curated shell-owned context rather than raw history records. `agent.screenshot()` is best-effort visual verification, while `agent.done()` signals that the current coding task is complete. The naming is intentionally a semantic nudge: persist `application.*` behavior into the app when appropriate; use `agent.*` for coding and inspection.

The shell may internally retain richer histories, behavioral summaries, logs, and diagnostics without making those internal schemas part of the generated-app API. Generated code otherwise uses ordinary browser APIs directly, including the native DOM.

Deleting an app removes its shell-owned metadata, persistent document/store, behavioral summary, and history and then forgets the immutable UUID. Diagnostic logs may outlive app deletion for export/debugging. App-origin browser data is cleanup hygiene rather than part of deletion correctness. The shell may make a best-effort request to a protected wildcard cleanup endpoint that responds with `Clear-Site-Data: "storage", "cache"`; cleanup failure must not block deletion, and UUIDs are never reused.

## Security notes

Generated app JavaScript intentionally has broad control over its own origin and can use browser/device/network APIs. Origin isolation prevents direct access to other apps and the shell. The runtime does not provide a fine-grained capability sandbox. Protect the root origin, avoid parent-domain cookies, and remember that provider credentials belong only to the shell origin and are never passed to generated app code.
