# itsalive.org

A browser-native platform for applications that keep building themselves while they are used. The root-domain shell owns the AI agent, history, configuration, and credentials. Every app runs as a persistent HTML document on its own wildcard subdomain and browser origin.

## Architecture

This repository produces two independent static builds:

| Build | Output | Deployment binding | Responsibility |
| --- | --- | --- | --- |
| Root shell | `dist-root/` | `itsalive.org` | Apps, Chat, Settings, histories, provider calls, agent loop |
| App runtime | `dist-app/` | `*.itsalive.org` | Persistent document, execution bridge, tools, database, screenshots |

The only connection between the two origins is a versioned `postMessage` protocol. Every message is checked for its exact origin, source window, immutable app UUID, direction, request ID, and payload shape. Each app UUID is also its permanent wildcard subdomain; display names can be changed independently. Provider credentials remain in root-origin storage and are never sent into app frames.

## Included capabilities

- Per-app origin isolation with no storage namespaces or shared app database.
- IndexedDB shell repositories for app metadata, full history, model settings, schedules, and logs.
- Persistent app HTML with debounced autosave, live form-control normalization, restore, and script re-execution.
- JavaScript agent loop with `itsalive.done()`, bounded observations, turn/time limits, errors, and repair turns.
- Context budgeting that always retains the immutable system prompt, app prompt, current trigger, and complete compact tool inventory.
- OpenRouter-only provider registry for the product runtime, backed by a generic HTTP adapter that can support additional providers later.
- Compact DOM inspection with temporary references, literal history search, in-frame screenshots, and app log retrieval.
- Durable app database helpers and agent-created custom tools.
- App-to-shell LLM requests and agent wake-ups.
- Stable cron registrations and callback dispatch protocol. Cron callbacks run only while the relevant app runtime and shell are active; this is not server-side or background scheduling.
- Tailwind's browser runtime and Lucide availability in itsalive apps without imposing a generated framework. Runtime Tailwind deliberately supports utility classes introduced by the LLM after load rather than relying on build-time source scanning.
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

Open **Settings** in the shell, add your OpenRouter API key, and press **Save**. The shell tests the key before saving it. All product LLM requests use OpenRouter's `openrouter/auto` model; provider, model, endpoint, and token-limit controls are intentionally not user-configurable.

OpenRouter requests happen directly from root-origin browser JavaScript. Credentials are saved only in root-origin `localStorage`; use the runtime only on a trusted device and origin.

## Cloudflare Workers Static Assets

Two Wrangler configurations are included:

```bash
npx wrangler deploy
npx wrangler deploy --config wrangler.app.toml
```

Configure the first Worker route/custom domain for the exact root host and the second for the wildcard host. Configure DNS and certificates for both. The generated assets use SPA fallback so UUID app subdomains serve the same runtime bootstrap.

## Runtime API

Agent JavaScript executes inside the active app and can use ordinary browser APIs plus the single, versioned `itsalive` runtime namespace (`itsalive.apiVersion === 1`):

```js
itsalive.dom.inspect({ ref, search, detail })
itsalive.dom.ref("@12")
itsalive.dom.screenshot({ ref })
itsalive.logs.get({ level, limit })
itsalive.history.search({ query, limit })
itsalive.tools.search(query)
itsalive.tools.get(name)
itsalive.tools.create({ name, description, parameters, code })
itsalive.tools.call(name, args)
itsalive.tools.delete(name)
itsalive.cron(id, expression, callback)
itsalive.agent.wake(reason)
itsalive.db.get(key)
itsalive.db.set(key, value)
itsalive.db.delete(key)
itsalive.db.query(options)
itsalive.llm.ask(prompt, options)
itsalive.reload()
itsalive.done(message)
```

The platform uses one branded browser global because persisted generated scripts execute independently of an individual agent invocation. Keeping every platform capability under `window.itsalive` minimizes global namespace pollution and leaves ordinary browser APIs—including `window.history`—untouched. The namespace reference and its stable groups are frozen for correctness, not as a security boundary. Custom tools receive the same API object as `env.itsalive` alongside `document`, `window`, and `fetch`.

Generated apps should keep natural, reasonably sized state in persistent semantic HTML and use `itsalive.db` for large, binary, or query-heavy data. The system prompt strongly requires meaningful application UI to use idempotent native Custom Elements because documents and scripts may be restored at any time. Components should preserve restored light DOM and normally use it so global Tailwind utilities—including utilities added dynamically at runtime—continue to apply. This is a generation contract rather than runtime output validation.

## Security notes

Generated app JavaScript intentionally has broad control over its own origin and can use browser/device/network APIs. Origin isolation prevents direct access to other apps and the shell. The runtime does not provide a fine-grained capability sandbox. Protect the root origin, avoid parent-domain cookies, and remember that provider credentials belong only to the shell origin and are never passed to generated app code.
