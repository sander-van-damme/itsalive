# itsalive.org

A browser-native platform for applications that keep building themselves while they are used. The root-domain shell owns the AI agent, history, configuration, and credentials. Every app runs as a persistent HTML document on its own wildcard subdomain and browser origin.

## Beta compatibility policy

itsalive.org is currently in beta. Until the project owner explicitly declares that the product is out of beta and ready for release, breaking changes are expected and preferred over compatibility layers. Beta app data, history, settings, database schemas, URLs, bridge messages, and runtime APIs may be reset or changed without migration. Do not add migration code, deprecated aliases, fallback readers, or other backward-compatibility shims unless they are specifically requested for a current product need.

Once the project owner explicitly declares the product release-ready, compatibility and migration requirements must be reconsidered before making breaking changes.

## Architecture

This repository produces two independent static builds:

| Build | Output | Deployment binding | Responsibility |
| --- | --- | --- | --- |
| Root shell | `dist-root/` | `itsalive.org` | Platform state and policy: apps, persistent documents, Chat, Settings, histories, provider calls, runtime API definition, agent loop |
| App runtime | `dist-app/` | `*.itsalive.org` | Minimal execution kernel: bridge, DOM execution/observation, serialization/restoration, screenshots, app-origin operations |

The only connection between the two origins is a versioned `postMessage` protocol. Every message is checked for its exact origin, source window, immutable app UUID, direction, request ID, and payload shape. Each app UUID is also its permanent wildcard subdomain; display names can be changed independently. Provider credentials remain in root-origin storage and are never sent into app frames.

### Thin app-runtime invariant

Keep `src/app` as small and replaceable as possible. The root shell owns platform state, persistence, policy, prompts, API contracts and implementations, configuration, catalogs, and other product logic whenever those responsibilities do not require the app origin. Code belongs in the app runtime only when it must execute there, such as DOM access, generated-code execution, interaction capture, screenshots, validated bridge transport, or operations against the app origin's own browser storage.

The shell initializes the app runtime over the validated `postMessage` bridge. Persistent app HTML is shell-owned: the shell loads it from root-origin storage and sends it to the runtime for restoration, while the runtime serializes live DOM state and sends snapshots back for shell-owned persistence. Do not add a platform-private database to the app origin.

The `window.itsalive` namespace follows the same ownership rule. Its contract and platform behavior are shell-owned. Because the iframe is cross-origin, the app runtime may install a small local facade/proxy from shell-provided initialization data and forward shell capabilities over the bridge. Capabilities that inherently require the app origin may execute locally behind that facade; exposing a capability inside the app does not make its policy, durable state, or catalog app-owned.

## Included capabilities

- Per-app origin isolation with no storage namespaces or shared app database.
- IndexedDB shell repositories for app metadata, persistent app HTML, full history, schedules, and logs.
- Bridge-based persistent app HTML initialization and saving, with app-side form-control normalization, serialization/restoration, and script re-execution.
- JavaScript agent loop with `itsalive.done()`, bounded observations, turn/time limits, errors, repair turns, and streamed multi-command responses whose completed commands execute immediately while generation continues.
- Context budgeting that always retains the immutable system prompt, app prompt, and current trigger.
- OpenRouter-only provider registry and OpenAI-style HTTP/SSE adapter.
- Native DOM inspection through ordinary browser APIs and execution results, plus literal history search, in-frame screenshots, and app log retrieval.
- App-to-shell LLM requests and agent wake-ups.
- Stable cron registrations and callback dispatch protocol. Cron callbacks run only while the relevant app runtime and shell are active; this is not server-side or background scheduling.
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

Open **Settings** in the shell, add your OpenRouter API key, and press **Save**. The shell tests the key before saving it. All product LLM requests use OpenRouter's `openrouter/auto` model. The shell does not send a client-side generation-token ceiling; OpenRouter and the routed model determine generation length. The shell loads Auto Router's current context capacity from OpenRouter's authenticated user model catalogue instead of hardcoding it.\n\nFor context experiments, Settings exposes a **History budget (tokens)** value. It controls only how many tokens of prior shell history may be included in an agent turn; the system prompt, app prompt, current trigger, and current observations are separate. The effective request remains bounded by the live model context capacity. Diagnostic logs record the configured history budget, selected history tokens, estimated total input, omitted-history count, model capacity, and provider-reported token usage so test runs can be compared.

OpenRouter requests happen directly from root-origin browser JavaScript. Credentials are saved only in root-origin `localStorage`; use the runtime only on a trusted device and origin.

## Cloudflare Workers Static Assets

Two Wrangler configurations are included:

```bash
npx wrangler deploy
npx wrangler deploy --config wrangler.app.toml
```

Configure the first Worker route/custom domain for the exact root host and the second for the wildcard host. Configure DNS and certificates for both. The generated assets use SPA fallback so UUID app subdomains serve the same runtime bootstrap.

## Runtime API

Agent JavaScript executes inside the active app and can use ordinary browser APIs plus the single, versioned `itsalive` runtime namespace (`itsalive.apiVersion === 2`):

```js
itsalive.dom.screenshot()
itsalive.logs.get({ level, limit })
itsalive.history.search({ query, limit })
itsalive.components.modal // Pines Alpine + Tailwind component recipes
itsalive.cron(id, expression, callback)
itsalive.agent.wake(reason)
itsalive.llm.ask(prompt)
itsalive.done(message)
```

The platform uses one branded browser global because persisted generated scripts execute independently of an individual agent invocation. Keeping every platform capability under `window.itsalive` minimizes global namespace pollution and leaves ordinary browser APIs—including `window.history`—untouched. The namespace reference and its stable groups are frozen for correctness, not as a security boundary. The shell owns the API contract and platform behavior; the cross-origin app runtime exposes only the local facade/proxies and app-origin implementations needed to make that contract available to generated code. Generated code otherwise uses ordinary browser APIs directly, including the native DOM.

Generated apps should keep reasonably sized durable state in persistent semantic HTML. Larger, binary, or query-heavy structured state may use native browser IndexedDB directly; each app has its own browser origin, so that generated-app storage is naturally isolated. Platform persistence of the saved HTML belongs to the root shell database, not to runtime-private app-origin IndexedDB. The system prompt treats the document as a live drawing board: ordinary semantic HTML and browser DOM APIs are the default, native Custom Elements are optional rather than mandatory, and substantial work can be emitted as multiple independently executable commands in one streamed response. The shell applies each complete command as soon as its delimiter arrives, so users can see the app take shape before the model finishes generating the response. Native DOM values returned by generated code are serialized into readable observations, so no custom inspector/ref protocol is needed. Raw interaction events remain ephemeral in memory; only an LLM-rewritten behavioral summary is persisted inside the HTML.

Deleting an app always removes its shell-owned metadata, history, logs, and schedules. If that app is active, the shell also asks its mounted runtime to unregister service workers and clear origin-owned IndexedDB, Web Storage, and Cache Storage before removal. Inactive apps have no mounted cross-origin frame, so their origin-owned browser storage cannot be cleared by this small best-effort path.

## Security notes

Generated app JavaScript intentionally has broad control over its own origin and can use browser/device/network APIs. Origin isolation prevents direct access to other apps and the shell. The runtime does not provide a fine-grained capability sandbox. Protect the root origin, avoid parent-domain cookies, and remember that provider credentials belong only to the shell origin and are never passed to generated app code.
