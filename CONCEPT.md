# Living Apps Runtime
## Implementation Specification — Subdomain Architecture

**Working concept:** apps that keep building themselves while you use them.

This document describes a deliberately small browser platform where every app is a persistent, self-modifying HTML application controlled by an AI agent.

The platform has two layers, shipped as **two separate static site builds from one repository**:

1. **Root shell site** — the fixed UI, AI configuration, prompts, history, and agent runner.
2. **App runtime site** — served on the wildcard subdomain; each hostname becomes one isolated living app origin.

Example:

```text
https://itsalive.org
https://violin.itsalive.org
https://renovation.itsalive.org
https://math.itsalive.org
```

The user always enters through the root shell. Apps run inside cross-origin iframes.

The key architectural rule is:

> **The root domain is the brain and shell. Each app subdomain is one isolated living application.**

---

# 1. Product goal

The product is not an AI app builder in the normal sense.

A normal AI builder follows:

```text
describe app
    ↓
generate code
    ↓
preview
    ↓
deploy
    ↓
use app
```

This runtime removes the boundary between building and using:

```text
use app
    ↓
agent is invoked
    ↓
agent inspects current app
    ↓
agent modifies it live
    ↓
continue using app
    ↓
repeat
```

The agent remains part of the running application.

It may:

- inspect the current DOM;
- execute arbitrary JavaScript;
- modify the app;
- create reusable Custom Elements;
- use Tailwind and Lucide;
- use browser APIs;
- store data;
- schedule future wake-ups;
- create reusable agent tools;
- inspect logs and errors;
- take screenshots to verify its output.

A violin coach, renovation manager, math tutor, personal CRM, research notebook, or completely different application should all run on the same runtime.

---

# 2. Deployment model

## 2.1 One repository, two static site builds

Use one repository, but produce **two separate static sites**:

```text
root site build
    → deployed to itsalive.org

app site build
    → deployed to *.itsalive.org
```

The root build contains the shell.

The app build contains the app bootstrap/runtime that is served identically for every app subdomain.

There is **no client-side hostname detection to choose between shell mode and app mode**. The two builds have different entry points and are deployed to different hostname bindings.

The root domain is hardcoded as `itsalive.org` in the shared domain module. Both builds use that constant when they construct or validate cross-origin URLs; no environment variable is required.

The repository may share source modules between the two builds, but their generated static sites are distinct artifacts.

## 2.2 Cloudflare deployment

Deployment target:

> **Cloudflare Workers Static Assets**

Deploy the two static builds separately:

```text
root static site
    itsalive.org

app static site
    *.itsalive.org
```

The intention is that normal page delivery is handled as static assets without request-time application Worker invocations.

The wildcard app-site binding means every app receives its own browser origin without requiring a separate build or deployment for that app.

## 2.3 App slug

The first hostname label is the app slug.

Example:

```text
violin.itsalive.org      → violin
house.itsalive.org       → house
math.itsalive.org        → math
```

Do not maintain an application-level reserved-slug list.

Any slug accepted by app creation and representable as the intended subdomain may be used.

---

# 3. Static root shell

The root shell is fixed and served from the CDN.

It is not generated or modified by app agents.

## 3.1 Visible UI

Use a compact control bar, for example on the right:

```text
┌──────────────────────────────────────────────┬──────────┐
│                                              │ Apps     │
│                                              │          │
│              Current app iframe              │ Chat     │
│                                              │          │
│                                              │ Settings │
└──────────────────────────────────────────────┴──────────┘
```

The shell owns only:

- **Apps**
- **Chat**
- **Settings**

Everything else belongs to the active app.

## 3.2 Shell responsibilities

The root shell owns:

- app list and app metadata;
- app switching;
- iframe lifecycle;
- immutable global system prompt;
- one app prompt per app;
- full chat/agent history per app;
- rolling conversation summary per app;
- LLM provider/model configuration;
- LLM credentials;
- model invocation;
- agent loop;
- context budgeting;
- cross-origin `postMessage` bridge;
- shell logs;
- user-facing log export.

The shell does **not** own the app DOM or app data.

---

# 4. One app = one browser origin

Every app runs at:

```text
https://<app-slug>.itsalive.org
```

That gives the app its own origin automatically.

This is important because browser storage is origin-scoped.

Every app can therefore use the same simple names:

```js
indexedDB.open("app");
localStorage.getItem(...);
navigator.storage.getDirectory();
```

without needing:

```text
appId
database prefixes
storage namespaces
per-app path prefixes
```

The browser performs the isolation.

Conceptually:

```text
violin.itsalive.org
├── its own DOM
├── its own IndexedDB
├── its own localStorage
├── its own Cache Storage
└── its own OPFS

math.itsalive.org
├── its own DOM
├── its own IndexedDB
├── its own localStorage
├── its own Cache Storage
└── its own OPFS
```

The root shell still uses the app slug to associate shell-owned metadata such as app prompts and chat histories.

---

# 5. Apps always run inside the shell

The supported execution environment is:

```text
itsalive.org
    ↓
iframe
    ↓
<app>.itsalive.org
```

The app subdomain should not be treated as a standalone product UI.

If a user navigates directly to:

```text
https://violin.itsalive.org
```

the bootstrap may redirect to:

```text
https://itsalive.org/?app=violin
```

The shell then opens:

```text
https://violin.itsalive.org
```

inside its iframe.

This guarantees that the shell is available for:

- AI requests;
- chat;
- model configuration;
- credentials;
- agent history;
- app switching.

---

# 6. Cross-origin iframe boundary

The root shell and app iframe are intentionally different origins.

The root shell cannot directly access:

```text
iframe.contentDocument
iframe DOM
iframe IndexedDB
iframe OPFS
```

The app cannot directly access shell storage or DOM.

All communication goes through a small `postMessage` bridge.

## 6.1 Shell → app messages

The shell needs only a few operations:

```text
execute JavaScript
request app readiness
request app metadata if needed
reload app
```

Most inspection functions execute *inside* the app rather than being implemented by the shell.

Example:

```text
shell receives JS from model
    ↓
postMessage({ type: "execute", code })
    ↓
app runtime executes it
    ↓
postMessage({ type: "result", result })
```

## 6.2 App → shell messages

The app runtime may send:

```text
execution result
execution error
agent wake request
AI request
logs
cron registration
screenshot result
runtime status
```

## 6.3 Validate messages

Both sides must validate:

- `event.origin`;
- message type;
- expected app slug;
- request/response ID.

Do not use `targetOrigin: "*"` for normal bridge traffic.

---

# 7. LLM credentials stay on the root origin

Generated app code should not receive raw LLM credentials.

The root shell owns:

```text
provider credentials
provider configuration
model selection
```

The app may call:

```js
await app.ai.ask(...);
```

but internally this becomes:

```text
app iframe
    ↓ postMessage
root shell
    ↓
configured LLM provider
    ↓
root shell
    ↓ postMessage
app iframe
```

The provider request is made by JavaScript running on the root origin.

No application proxy is required.

## 7.1 Credential storage

Credentials should be root-origin only.

Recommended:

```text
root-origin IndexedDB
```

A JavaScript-readable cookie is also possible for compact credentials, but if cookies are used they should be **host-only**:

```text
Set cookie on itsalive.org
Do NOT set Domain=itsalive.org
```

Omitting the `Domain` attribute prevents the credential cookie from being shared with generated app subdomains.

Do not use a parent-domain cookie intentionally shared with:

```text
*. itsalive.org
```

because every generated app would then receive the same credentials.

---

# 8. What an app is

The durable generated application is primarily **one persistent HTML document**.

AI-written CSS and JavaScript belong inside that document, normally in `<style>` and `<script>` elements. Custom Element definitions, cron declarations, helpers, and other generated behavior are therefore part of the saved HTML rather than separate generated source files.

Conceptually:

```text
App subdomain
├── persistent HTML document
│   ├── markup / UI
│   ├── <style> AI-written CSS
│   ├── <script> AI-written JavaScript
│   ├── Custom Element definitions
│   ├── cron declarations
│   ├── small durable app data/context
│   └── other generated app behavior
│
├── injected static app runtime
│   ├── postMessage bridge
│   ├── inspectDom / refs
│   ├── screenshot support
│   ├── app.ai / history bridge
│   ├── custom-tool runtime
│   └── persistence helpers
│
├── app IndexedDB
├── optional OPFS/files
└── custom agent tools
```

The **injected static app runtime is platform code**, delivered by the app-site build. It is not AI-generated and is not serialized as part of the living HTML document.

Shell-owned state associated with that app:

```text
app slug
app name
app prompt
full chat/agent history
rolling summary
```

There is deliberately no required:

- widget manifest;
- component registry;
- UI schema;
- universal state object;
- TypeScript build system;
- generated frontend framework.

---

# 9. HTML is the app's primary source of truth

The default rule:

> **If information naturally belongs in the app document, keep it in the HTML. Use IndexedDB when HTML becomes awkward, too large, binary, or query-heavy.**

The app HTML may contain:

- current UI;
- current form values;
- user data;
- user instructions;
- app-specific instructions/context;
- small datasets;
- visible records;
- plans;
- notes;
- AI-written CSS in `<style>` elements;
- AI-written JavaScript in `<script>` elements;
- Custom Element definitions;
- cron declarations.

Generated CSS and JavaScript are part of the persistent HTML document. Platform runtime code supplied by the app-site build is injected separately and is not persisted into the generated document.

## 9.1 Good HTML state

Examples:

```text
current exercise
current view
expanded/collapsed sections
form values
notes
small tables
user instructions
current plan
Custom Element attributes
Custom Element child content
```

## 9.2 Good IndexedDB state

Examples:

```text
thousands of records
large histories
large imported datasets
binary data
query-heavy data
large structured collections
```

Do not impose a global `state.json`.

---

# 10. Persistent app HTML

The app runtime automatically saves the current application document into the app origin's storage.

A simple implementation can use the app's IndexedDB:

```text
database: app
store: document
key: html
```

The same database may contain other app-specific stores if needed.

Because each app has a separate origin, every app can use exactly the same database and store names.

## 10.1 Autosave

Use a `MutationObserver` with debouncing.

Before serialization, normalize live browser state that may not naturally appear in HTML:

- input values;
- textarea values;
- selected options;
- checkbox/radio state;
- `<details>` state.

Conceptually:

```text
DOM changes
    ↓
debounce
    ↓
normalize live controls
    ↓
serialize app HTML
    ↓
save locally
```

## 10.2 Restore

The subdomain serves a static app bootstrap.

The bootstrap:

1. initializes the app bridge;
2. loads the saved app HTML;
3. restores it;
4. explicitly re-executes saved app scripts;
5. lets Custom Elements upgrade/reconnect.

The runtime itself is static infrastructure and is not part of the generated application HTML.

## 10.3 Restartability

The agent must assume:

> The app can restart at any time.

Important persistent state should live in:

```text
HTML
or
app IndexedDB
```

Do not rely on:

```text
closures
object references
timers
in-memory maps
old event listeners
```

surviving reload.

---

# 11. Reusable UI uses Custom Elements

Reusable or meaningful interactive UI should prefer native **Custom Elements**.

Example:

```html
<invoice-card contractor="Janssens" amount="4200"></invoice-card>

<invoice-card contractor="Acme" amount="18500"></invoice-card>
```

Definition:

```js
class InvoiceCard extends HTMLElement {
  connectedCallback() {
    this.render();
    this.bind();
  }

  render() {
    if (!this.querySelector("[data-card-body]")) {
      this.innerHTML = `
        <article data-card-body class="rounded-xl border p-4">
          <strong data-contractor></strong>
          <span data-amount></span>
        </article>
      `;
    }

    this.querySelector("[data-contractor]").textContent =
      this.getAttribute("contractor") ?? "";

    this.querySelector("[data-amount]").textContent =
      this.getAttribute("amount") ?? "";
  }

  bind() {
    // reconnect event behaviour when needed
  }
}

if (!customElements.get("invoice-card")) {
  customElements.define("invoice-card", InvoiceCard);
}
```

The browser itself provides the reusable component model.

## 11.1 Custom Element rules

The global system prompt should tell the agent:

- prefer Custom Elements for reusable or meaningful interactive UI;
- use clear semantic names;
- keep important instance state in attributes or child content when practical;
- make `connectedCallback()` idempotent;
- do not blindly recreate child markup that already survived reload;
- reconnect event behavior after reload;
- reuse an existing suitable Custom Element before creating another;
- do not create Custom Elements for trivial one-off markup.

Native `<template>` remains available, but it is not the preferred convention.

---

# 12. Styling

Make these available in the app runtime:

```text
Tailwind CSS
Lucide icons
```

The agent is told:

> Tailwind and Lucide are available. Use them when they make the job easier. You are not required to use them.

Do not initially add:

- a custom design system;
- shadcn/ui;
- a component library;
- predefined templates;
- a mandatory base stylesheet.

The browser, Tailwind, Lucide, and Custom Elements are enough for V1.

---

# 13. JavaScript is the agent protocol

The model does not need provider-native tool calls.

Every model response in an agent run is executable JavaScript.

The root shell:

1. sends context to the model;
2. receives JavaScript;
3. posts it to the active app iframe;
4. the app runtime executes it;
5. the app returns a result;
6. the shell either finishes or invokes the model again.

## 13.1 Execution loop

```text
model
    ↓ JavaScript
root shell
    ↓ postMessage
app iframe
    ↓ execute
result / screenshot / error / done
    ↓ postMessage
root shell
    ↓
model again if needed
```

## 13.2 Completion

Expose:

```js
done()
done("Optional chat message")
```

Calling/returning `done(...)` ends the current agent run.

## 13.3 Errors

If generated JavaScript throws, the app runtime returns:

```text
message
stack
recent relevant logs
```

The shell sends this observation into the next model turn.

The agent can then repair the problem.

## 13.4 Guardrails

Use simple operational limits:

- maximum agent turns per invocation;
- maximum wall-clock time;
- maximum execution-result size;
- maximum model context size.

These prevent accidental loops without introducing a capability permission system.

---

# 14. Runtime API inside each app

Keep the runtime small.

Recommended globals:

```js
inspectDom(...)
screenshot(...)
getLogs(...)

ref("@12")

history.search(...)

tools.search(...)
tools.get(...)
tools.create(...)
tools.call(...)
tools.delete(...)

cron(...)
agent.wake(...)

app.db.get(...)
app.db.set(...)
app.db.delete(...)
app.db.query(...)

app.ai.ask(...)
app.reload()

done(...)
```

Normal browser APIs remain available:

```js
document
window
fetch
navigator
IndexedDB
DOM APIs
Web Audio
getUserMedia
setTimeout
setInterval
...
```

Do not wrap browser functionality unless there is a concrete reason.

---

# 15. Token-efficient DOM inspection

The model should not receive the full app HTML automatically.

`inspectDom()` gives it a compact navigational view.

Example:

```text
@1 body
├─ @2 header
│  └─ @3 h1 "Renovation"
├─ @4 main
│  ├─ @5 budget-summary
│  ├─ @6 section#quotes
│  │  └─ @7 contractor-quote [6 instances]
│  ├─ @8 section#invoices
│  │  └─ @9 invoice-card [42 instances]
│  └─ @10 section#notes [18 KB]
└─ @11 script [9 KB]
```

The inspector should:

- truncate long text;
- hide script/style source by default;
- summarize repeated collections;
- preserve semantic element names;
- preserve useful IDs/classes;
- show counts and approximate sizes;
- assign temporary refs.

Custom Elements make the tree easier for both humans and models to understand.

## 15.1 Progressive inspection

Examples:

```js
return await inspectDom({ ref: "@8" });
```

```js
return await inspectDom({ search: "Janssens" });
```

```js
return await inspectDom({
  ref: "@11",
  detail: "source"
});
```

## 15.2 Temporary refs

Refs exist only inside the app runtime.

```js
const node = ref("@8");
```

returns the actual DOM node.

Refs are not written into the HTML.

They may become invalid after reload or major DOM changes. The agent can simply inspect again.

---

# 16. Screenshot

The app runtime provides:

```js
return await screenshot();
```

or:

```js
return await screenshot({ ref: "@8" });
```

Because the iframe is cross-origin, screenshot capture happens **inside the app runtime**, not from the parent shell.

The app sends the resulting image data back to the shell through `postMessage`.

The shell attaches it to the next model turn.

This gives:

```text
inspect
    ↓
change
    ↓
screenshot
    ↓
verify
    ↓
correct if needed
```

---

# 17. Agent-created tools

The agent can turn repeated complex work into reusable tools.

Example:

```js
await tools.create({
  name: "invoiceTotals",
  description: "Calculate paid and outstanding invoice totals.",
  parameters: {
    type: "object",
    properties: {}
  },
  code: `
    return async function(args, env) {
      // implementation
    }
  `
});

return done();
```

Later:

```js
const totals = await tools.call("invoiceTotals", {});
return totals;
```

Custom tools should be stored inside the app origin, for example in its IndexedDB.

Because each app is a separate origin, the tool registry requires no app namespace.

## 17.1 Compact tool inventory is always in model context

Every model request for the app must include **every custom tool name plus a very short description**.

Example:

```text
CUSTOM TOOLS

invoiceTotals — Calculate paid and outstanding invoice totals.
findContractor — Find contractor records by literal name or company.
normalizeQuote — Normalize an imported quote into the app's record shape.
```

This inventory is intentionally compact and is essential: the model should know which reusable capabilities already exist before writing new JavaScript.

Do **not** inject the full implementation, parameter schema, or source code of every tool into every request.

When the model needs more detail, it can retrieve one tool:

```js
return await tools.get("invoiceTotals");
```

It can also search the registry when useful:

```js
return await tools.search("invoice");
```

The short description stored for each tool should therefore be concise and useful enough for discovery.

---

# 18. Cron and agent wake-ups

App JavaScript may schedule future work:

```js
cron("daily-practice-review", "0 8 * * *", async () => {
  await agent.wake("Review today's practice plan.");
});
```

The cron declaration lives in persisted app JavaScript.

Registration is sent to the root shell through the bridge.

Use a stable callback ID so registration is idempotent:

```text
app slug + callback ID
```

The shell may keep a small derived schedule cache:

```text
callback ID
schedule
last-fired
next-run
```

The app HTML/script remains the source of truth.

When an app loads, its cron declarations register/update the shell cache.

## 18.1 Shell restart

On shell startup, existing app schedules may be reconstructed by briefly loading app runtimes in hidden iframes, or by using the last derived schedule cache and refreshing it when each app next loads.

Keep this simple in V1.

## 18.2 Browser closed

A browser-only implementation cannot guarantee agent wake-ups while the browser is fully closed.

That would require separate background/PWA/server infrastructure and is outside the minimal architecture.

---

# 19. App prompts and conversation history

The root shell owns conversation context.

Each app has:

```text
app prompt
full history
rolling summary
```

These are stored on the root origin, keyed by app slug.

## 19.1 Global system prompt

The global system prompt is:

- immutable;
- shell-owned;
- always included.

It explains:

- runtime behavior;
- JavaScript-only responses;
- HTML persistence;
- Custom Elements;
- inspection;
- screenshots;
- Tailwind/Lucide;
- custom tools;
- cron;
- history;
- restartability;
- shell/app boundaries.

The agent cannot edit it.

## 19.2 App prompt

Each app has a short shell-owned app prompt.

It answers:

> What is this app for?

Example:

```text
This app is a personal violin-practice environment.

Its goal is to help the user improve through focused,
adaptive practice based on their observations and results.
```

The app prompt is always included.

The shell should let the user view and edit it.

Detailed user data should normally live in the app itself rather than turning the app prompt into a database.

## 19.3 Full history

The shell stores the complete per-app history:

- user chat;
- final assistant replies;
- generated JavaScript turns;
- execution observations;
- relevant errors;
- compaction events.

Stored history does not mean it is all sent to the model.

---

# 20. Context budgeting

The request builder must know the **maximum context size of the selected model** and must never send a request that exceeds it.

Do not use a fixed rule such as:

```text
last 10 messages
```

Budget by tokens/size.

Conceptually:

```text
selected model max context
- reserved maximum output
- reserved execution-observation headroom
= maximum request input
```

Every request has a mandatory context block:

1. global system prompt;
2. app prompt;
3. current trigger;
4. compact custom-tool inventory containing every tool name and very short description.

Then add conversation context:

5. rolling summary;
6. newest verbatim history backwards while it fits.

## 20.1 Trimming rule

When a request would exceed the selected model's maximum context:

> **Cut conversation history. Never cut the global system prompt.**

Remove old verbatim history first and keep the newest useful history.

If more space is needed, reduce conversation-derived context further, including the rolling summary if necessary.

The system prompt is never truncated to make a request fit.

The app prompt and custom-tool descriptions should be kept deliberately compact so they remain cheap mandatory context.

Execution observations should also be bounded before they enter context so an unexpectedly large DOM inspection, log result, or tool result cannot crowd out the mandatory prompt.

Prefer actual token counting for the selected provider/model.

If exact token counting is unavailable, use a conservative character/byte estimate with safety margin.

---

# 21. Rolling summary

Older context is compacted into a rolling summary when needed.

The summary should preserve:

- durable user goals;
- preferences;
- important decisions;
- constraints;
- unresolved issues;
- important conclusions;
- information not already obvious in the current app.

Do not duplicate large datasets already present in the app HTML/database.

The complete original history remains stored.

---

# 22. Literal history search

V1 does not need embeddings or semantic retrieval.

Expose literal text search:

```js
return await history.search({
  query: "electrician",
  limit: 20
});
```

The app-side helper sends the request to the root shell, which searches that app's stored history.

Implementation may use:

- case-insensitive substring search;
- word/token matching;
- a small inverted index.

Return:

```text
timestamp
role
matching snippet
```

Do not pretend this is semantic search.

---

# 23. Logging

The app runtime intercepts app console/error output and forwards it to the root shell.

Suggested labels:

```text
[shell]
[agent:violin]
[app:violin]
[tool:violin:tool-name]
```

Capture:

- `console.log`;
- `console.info`;
- `console.warn`;
- `console.error`;
- uncaught exceptions;
- unhandled promise rejections;
- agent-JavaScript errors;
- provider errors;
- tool errors;
- cron errors;
- bridge errors.

Expose inside the app runtime:

```js
return await getLogs({
  level: "error",
  limit: 30
});
```

The shell provides a user-facing:

```text
Export logs
```

action for the current/most recent session.

---

# 24. LLM provider abstraction

The root shell must not depend on one LLM vendor.

Use a provider-neutral JavaScript abstraction such as:

```text
Vercel AI SDK
```

or an equivalent library.

Wrap it behind a tiny shell-owned provider registry.

Keep separate:

```text
provider
model
authentication method
provider options
```

Conceptually:

```js
{
  provider: "openai",
  model: "...",
  auth: {
    type: "api-key",
    credentialId: "..."
  }
}
```

The rest of the shell should depend on one internal operation:

```js
await llm.generate({
  model,
  system,
  messages,
  maxOutputTokens
});
```

The model only needs to return JavaScript text.

The runtime does not depend on vendor-native tool calling.

## 24.1 Providers

Adapters may include:

- OpenAI;
- Anthropic;
- Google;
- DeepSeek;
- OpenRouter;
- OpenAI-compatible endpoints;
- other/custom providers.

Adding another provider should not change the app runtime.

## 24.2 Authentication

Authentication is separate from provider/model choice.

Allow adapter types such as:

```text
api-key
bearer-token
oauth
custom
```

## 24.3 Codex / ChatGPT authentication

Support Codex through an official integration path when possible.

Do not make ChatGPT/Codex account authentication a dependency of the runtime.

If a supported browser integration becomes available, it should be another root-shell authentication adapter.

Normal OpenAI API authentication remains separate.

---

# 25. Security model

This design intentionally accepts significant capability in generated app code.

## 25.1 Risks accepted

- generated JavaScript may contain bugs;
- app code may corrupt its own data;
- app code may make arbitrary network requests;
- app code may use device/browser APIs;
- custom agent tools may be buggy;
- generated code has broad access to its own origin.

## 25.2 Risks mitigated naturally by subdomains

Each app gets a separate browser origin.

Therefore one app cannot directly access another app's:

- DOM;
- IndexedDB;
- localStorage;
- OPFS;
- Cache Storage.

Generated apps also cannot directly access the root shell DOM or root-origin storage because the shell is cross-origin.

## 25.3 Credentials

LLM credentials remain on the root origin.

Do not deliberately share them with app subdomains.

The app requests AI operations through the bridge.

This is a major advantage of the subdomain architecture.

---

# 26. Initial global system prompt

Recommended starting point:

```text
You are the autonomous agent responsible for the current app.

RESPONSE FORMAT

Every response in this agent loop must be executable JavaScript only.

Do not use Markdown fences.
Do not explain the JavaScript outside the JavaScript.

The shell will execute your JavaScript inside the current app environment.

When your work is complete:

return done();

or:

return done("A short message to show the user in chat");

If you need information first, call an available runtime function and return its result. The result will be provided to you on the next turn.

CORE MODEL

You control one live application.

The application is primarily a persistent HTML document containing HTML, CSS and JavaScript.

The app runs inside its own browser origin.

The shell automatically persists the current app document and restores it after reload.

Scripts run again when the app is restored.

In-memory JavaScript state, closures, old object references and timers are not guaranteed to survive reload.

The root shell separately owns the global system prompt, app prompt, chat history, rolling summary, model configuration and LLM credentials.

HTML AS SOURCE OF TRUTH

Prefer storing durable app information in the HTML when that is natural and reasonably sized.

This includes useful user data, durable user instructions, app-specific context, visible records, plans, notes and component state.

Keep the document semantically organized with clear headings, meaningful Custom Elements and stable IDs where useful.

Do not create a separate state model merely out of habit.

If important state naturally belongs to the document, keep it in the document.

Use app.db when data is large, non-visual, binary, query-heavy or awkward to represent in HTML.

CUSTOM ELEMENTS

For reusable or meaningful interactive UI, prefer native Custom Elements.

Use clear semantic custom-element names.

Keep important instance state in attributes or child content when practical.

Custom Element code must be safe after reload.

Make connectedCallback() idempotent:
- do not duplicate child markup that already exists;
- recreate missing structure only when necessary;
- reconnect runtime behavior and event handlers;
- reuse restored HTML rather than assuming an empty element.

Reuse an existing suitable Custom Element before creating an equivalent one.

Do not create Custom Elements for trivial one-off markup.

STYLING

Tailwind CSS and Lucide icons are available.

Use them when they make implementation simpler or clearer.
You are not required to use them.

Do not add unnecessary UI frameworks or dependencies when normal HTML, CSS, JavaScript, Tailwind and Lucide are sufficient.

INSPECT SPARSELY

Do not read or rewrite the full HTML document without a real reason.

Use inspectDom() to get a compact tree, search relevant content, or inspect one region.

Request source detail only for nodes you need.

inspectDom() may return temporary refs such as @12.

Inside your JavaScript:

ref("@12")

returns the corresponding current DOM node.

Refs are temporary and may become invalid after reload or major DOM replacement.

EDIT WITH JAVASCRIPT

Use ordinary JavaScript and browser APIs.

Prefer precise changes over large rewrites.

Preserve useful user work.

After meaningful visual changes, use screenshot() when visual verification helps.

RESTARTABILITY

Assume the app may restart at any time.

Persist important state in the HTML or app database.

Do not depend on old closures, timers, object graphs or runtime-only state.

CALLBACKS

You may schedule future work with cron(...).

Prefer stable callback IDs.

Application code may call agent.wake(...) whenever another agent run is useful.

CUSTOM TOOLS

Every model request includes a compact inventory of all custom tools for this app: each tool's name and a very short description.

Use that inventory before creating new code or new tools.

You may search, inspect, create and call reusable custom tools.

Use tools.get(...) when you need the full details of one existing tool.

Create a custom tool when a complex operation is likely to recur.

Do not create tools for trivial one-off operations.

HISTORY AND CONTEXT

The shell builds every request against the selected model's maximum context size.

The global system prompt is never truncated.

When context must be reduced, conversation history is removed to make the request fit.

Recent context and the rolling summary are therefore bounded by available token/character budget, not message count.

If you need an older exact statement, use literal history.search(...) with useful keywords.

History search is literal text retrieval, not semantic retrieval.

ERRORS AND LOGS

If code fails, inspect the exception and getLogs(...) when useful.

Fix the smallest relevant piece and retry.

Runtime failures are normal.

SHELL BOUNDARY

The root shell owns:
- app switching;
- Chat;
- Settings;
- model/provider/auth configuration;
- global system prompt;
- app prompt;
- conversation history;
- LLM credentials.

Do not try to modify or access shell internals.

Keep app-specific behavior inside the current app origin.

WORKING STYLE

Keep implementations simple.

Prefer browser primitives over new abstractions.

Prefer targeted changes over rewrites.

Prefer interactive UI over prose when interaction is the better answer.

Reuse existing HTML, Custom Elements, code and custom tools where useful.

Do not build infrastructure speculatively.

USER CONTROL

The user's request and app prompt define the goal.

Do not silently discard meaningful user-created data.

If the app's fundamental purpose changes, continue helping and point out that the shell-owned app prompt may need updating.
```

---

# 27. Example app prompt

```text
This app is a personal violin-practice environment.

Its purpose is to help the user improve their violin playing through focused, adaptive practice.

Use the user's observations, history and results to decide what is useful next.

Prefer interactive practice tools over long explanations when interaction is more effective.
```

The shell always includes the active app's prompt.

---

# 28. Model invocation context

A normal model request is assembled as:

```text
GLOBAL SYSTEM PROMPT
<mandatory; never truncated>

APP PROMPT
<mandatory>

CUSTOM TOOL INVENTORY
<mandatory; every tool name + very short description>

CURRENT TRIGGER
<mandatory current user/app/cron event>

LAST EXECUTION OBSERVATION
<only during a multi-turn run; bounded in size>

ROLLING SUMMARY
<conversation-derived; include only if it fits>

RECENT VERBATIM HISTORY
<newest backwards; trim to fit model max context>
```

The request builder uses the selected model's configured maximum context before every request.

If the request is too large, conversation history is removed until it fits. The immutable global system prompt is never sacrificed.

The full app HTML is not automatically inserted. The agent retrieves app detail through `inspectDom()`.

---

# 29. Example agent run

User in root-shell Chat:

> Add the new Janssens quote and compare it to the existing quotes.

The root shell builds model context and invokes the model.

The model returns:

```js
return await inspectDom({ search: "quote" });
```

The root shell posts this JavaScript to:

```text
house.itsalive.org
```

The app runtime executes it and returns:

```text
@4 section#quotes
└─ @5 contractor-quote [4 instances]

@12 script [defines contractor-quote]
```

The shell sends that observation to the model.

The model returns:

```js
const quotes = ref("@4");

const quote = document.createElement("contractor-quote");
quote.setAttribute("contractor", "Janssens");
quote.setAttribute("amount", "18450");

quotes.append(quote);

return await screenshot({ ref: "@4" });
```

The app executes it and returns the screenshot.

The model verifies the result and returns:

```js
return done("Added the Janssens quote and updated the comparison.");
```

The shell displays that message in Chat.

---

# 30. Architecture summary

```text
ROOT DOMAIN
┌──────────────────────────────────────────────┐
│ Static shell                                 │
│                                              │
│ Apps          Chat          Settings         │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │ iframe                                   │ │
│ │                                          │ │
│ │ violin.itsalive.org                      │ │
│ │                                          │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ system prompt                                │
│ app prompts                                  │
│ histories / summaries                        │
│ LLM credentials                              │
│ provider/model adapters                      │
│ agent runner                                 │
└──────────────────────────────────────────────┘
                     ↕
                postMessage
                     ↕
┌──────────────────────────────────────────────┐
│ APP SUBDOMAIN                                │
│                                              │
│ persistent HTML                              │
│   ├─ markup / UI                             │
│   ├─ AI-written <style> CSS                  │
│   ├─ AI-written <script> JavaScript          │
│   ├─ Custom Element definitions              │
│   └─ cron declarations                       │
│ injected static app runtime                  │
│ Tailwind / Lucide                            │
│ IndexedDB                                    │
│ OPFS                                         │
│ custom tools                                 │
│ inspectDom / refs / screenshot runtime       │
└──────────────────────────────────────────────┘
```

The core architectural rules are:

> **One app = one subdomain = one browser origin.**

> **The root domain is the brain and shell.**

> **The app's HTML is its primary source of truth.**

> **JavaScript is the agent's command language.**

> **Custom Elements are the reusable UI primitive.**

> **The browser performs app data isolation for us.**

> **The iframe + `postMessage` bridge is the only connection between shell and app.**

> **The root site and wildcard app site are separate static builds from one repository.**

> **Every model request includes the compact custom-tool inventory and is trimmed to the selected model's maximum context by sacrificing conversation history, never the global system prompt.**
