> Historical V2 implementation report. Its Demo-default and source-editing/approval workflow descriptions are superseded by [PRODUCT_VISION.md](PRODUCT_VISION.md), [PRODUCT_RECOVERY.md](PRODUCT_RECOVERY.md) and current acceptance coverage. Technical measurements below remain historical evidence, not the current product contract.

# It's Alive V2 implementation report

21 October 2026. V2 is implemented on `v2/browser-native` as a clean, reviewable beta rewrite. Main has not been replaced or deployed. V1 is preserved at `archive/v1` and tag `archive-v1-2026-10-21`, both pointing to the original V1 history (`00f1053b278e079ff8172c9f5df1e7949ac87207`).

## Implemented architecture

The root shell owns ordinary multi-file TypeScript/React source projects, immutable revision history, IndexedDB persistence, compiler infrastructure, dependency caching, AI policy and credentials, conversations, diagnostics, and backup orchestration. Applications execute on immutable UUID subdomains with independent browser origins. The permanent wildcard build is approximately 2.2 kB of JavaScript; substantive runtime code is built and delivered by the shell through an authenticated, versioned MessageChannel handshake.

A persistent SWC/WASM worker transforms changed modules to CommonJS with React Refresh instrumentation. Stable React, ReactDOM and Zustand instances live outside generated modules. Compatible edits retain local React state, while durable JSON state persists in shell IndexedDB. Generated applications can independently use ordinary browser storage and APIs. Small typed `@itsalive/ai` and `@itsalive/store` declarations are included in new projects.

Candidates compile and render on disposable verification origins before reaching the active application. Syntax, dependency and initial runtime failures leave the working revision intact. Expected-revision checks reject stale edits; short live-apply operations prevent unsafe application switching. Revision history supports undo through a new restoration revision. Verification never probes the active app's storage.

The shell provides conversation, explicitly requested deeper reasoning, optional behavior suggestions, and a bounded file-editing agent loop with list/read/write/patch/delete/dependency/check/inspect/finish tools. Deterministic checks authorize technical completion. User-approved changes pass through the same pipeline as direct source edits. Demo mode is explicitly scripted and exercises the real tools/runtime. OpenAI and OpenRouter adapters, role-specific models, usage accounting and shell-enforced limits are implemented. Speech input uses browser recognition with capability and permission handling.

Backups capture source/revisions, manifests/locks, cached dependency bytes, managed state, conversations, settings, diagnostics and supported storage from each app origin. Backup-only frames never execute generated source. Restoration validates archive integrity before writes and restores application-origin data before committing shell records. Supported data includes IndexedDB schemas/indexes and structured values, localStorage, readable Cache Storage responses and OPFS files. Progress, cancellation and explicit skipped/failed-storage reports are included. Provider keys are excluded.

Diagnostics contain session, correlation, application and revision identities; compile/verification results; coding tool activity; provider roles, token use, cost and latency; runtime failures; backup/restore activity; and adaptation feedback. INFO/DEBUG levels, opt-in prompt capture, redaction and bounded retention are implemented. Browser test failures retain Playwright traces and screenshots.

## Measured decisions and performance

Measurements are reproducible fixtures from this environment's Chromium 141, not general device or network guarantees. Raw samples and scope are committed under `docs/benchmark-*.json`.

| Measurement                               | SWC modules | esbuild-wasm bundle |
| ----------------------------------------- | ----------: | ------------------: |
| Compiler initialization                   |     89.6 ms |            114.2 ms |
| Cold three-file graph                     |     88.2 ms |            220.5 ms |
| Median one-file compilation               |      2.0 ms |             11.9 ms |
| Median two-file compilation               |     3.35 ms |             13.3 ms |
| Compile → React commit + two frames       |    33.25 ms |             33.3 ms |
| Local React state across comparison edits |   Preserved |           Remounted |

SWC was chosen for incremental transforms and working Refresh instrumentation. Paint scheduling dominated the small fixture, so the measurements do not support claiming a large visible-update advantage over esbuild.

The full accepted-edit lifecycle, including isolated verification, cleanup and persistence, measured **282.4 ms median** over 30 edits, with a 516.7 ms maximum. First application creation measured 370.6 ms; restoring persisted source to a ready runtime after reload measured 190.2 ms. Chromium's coarse JavaScript heap report remained 11.2 MB before/after those edits; this is not a leak proof or total-memory measurement.

A separate live `nanoid@5.1.6` experiment fetched current gateway responses through the configured environment proxy and forwarded those fresh bytes into browser requests. The first application needed two network resources; a second isolated origin, using a separate compiler instance, required **zero downloads and two shared-cache hits**. This verifies current package compatibility and cache reuse, not unmodified browser-to-CDN networking in every deployment.

## Verification executed

- Strict platform TypeScript checks passed. Vite and Vitest were updated after the registry audit; `npm audit` reports zero known vulnerabilities at verification time.
- **57 deterministic tests passed**, covering actual SWC transforms, providers/limits, agent repair and authorization, bridge validation, transactional storage, safe restoration, cancellation and asynchronous workspace ownership.
- **17 real Chromium acceptance tests passed**, including all 17 requested scenario categories, desktop/mobile controls, speech-interface simulations, concurrent app switching, and empty-archive restoration.
- The final combined browser run passed 20 tests (17 acceptance plus three benchmarks), with the optional live npm test skipped by default. Three browser benchmark scenarios passed: compiler comparison, visible updates/state retention, and the complete lifecycle/memory fixture.
- The optional live npm compatibility/cache test passed using fresh gateway responses.
- A separate **production-build smoke test passed** using only `dist-root` and `dist-app`: actual WASM worker, UUID bootstrap, UI source edit, React state retention, durable reload, no development hooks and no uncaught browser errors.

The normal suite uses no AI credentials. Provider request/response protocols and speech events were adapter-tested; no real paid AI call or microphone recognition session was performed. Optional tightly bounded live-provider probes are available separately.

## Significant tradeoffs and remaining limits

- Generated TypeScript is transpiled and checked for syntax/module/runtime failures; full semantic typechecking is not implemented.
- Dependency acquisition relies on an ESM gateway. Generated source stays in the browser, but the gateway may transform package dependencies. Node-only packages and unsupported import/plugin forms receive diagnostics. Full offline shell boot is not implemented, although cached dependency restoration/reuse is tested.
- Verification checks initial execution. It cannot prove every later interaction or make arbitrary external network effects transactional. Some render-time recovery paths remount components. Apps have broad control over their own origin, rather than a fine-grained capability sandbox against their local runtime.
- A preexisting malicious app-origin service worker can undermine bootstrap trust. Controlled frames are detected/refused where observable, but ordinary browser JavaScript cannot establish universal trust against a counterfeit bootstrap.
- Backups use an unencrypted in-memory archive capped at 128 MiB. Streaming, encryption, cloud destinations and multi-device synchronization are not implemented. Cookies, HttpOnly data, permissions, protected credentials and other inaccessible browser state are not restored. Concurrent tabs/service workers prevent universal cross-origin atomicity; partial failures are reported.
- Spending limits are client-side controls based on configured prices and provider usage. They are not an account-wide financial guarantee across browser tabs or altered storage.
- Live OpenAI/OpenRouter account compatibility, real model quality/latency/cost, real microphone recognition, and production DNS/TLS/Cloudflare deployment remain unverified. The bootstrap/runtime's large WASM assets make initial network conditions relevant.

The implementation is ready for code review as a beta foundation. Main replacement and deployment remain separate owner decisions after review and the applicable live checks.

## Git and reproduction

The rewrite removes the V1 persistent-HTML runtime, custom DOM-oriented orchestration, obsolete tests and documentation. New modules separate compiler, runtime/bootstrap, providers/harness, storage/backup and shell integration. Current architecture instructions, CI, deterministic/browser tests and measured evidence are included. V1 history is retained without force-pushing.

```sh
npm ci
npm run typecheck
npm test
npm run test:e2e
npm run test:production
npm run benchmark
```

Install Chromium with `npx playwright install --with-deps chromium` before browser tests. See README and the focused compiler, provider, acceptance and backup documents for operating details.
