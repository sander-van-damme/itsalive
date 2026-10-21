# Browser compilation and dependency policy

V2 uses SWC/WASM in one long-lived shell-owned worker. The compiler does not run on a server. Each changed TS/TSX module is transformed to CommonJS with SWC's React Refresh registrations and hook signatures. A parsed JavaScript AST resolves each literal import to its canonical module identity; string rewriting is not used for JavaScript imports. The runtime supplies React, ReactDOM, Refresh, Zustand and the two small platform modules. Unchanged source modules retain their compiled output. Source revisions are never executed by the compiler.

## Measured compiler choice

Run `npm run benchmark` to reproduce the Chromium benchmark. The test writes `docs/benchmark-results.json` and attaches the same raw evidence to the Playwright report. The fixture contains three TypeScript/React files, twelve single-file edits and twelve two-file edits. Both engines execute their actual browser WASM implementations.

On the first measured run (2026-10-21, Chromium 141, this execution environment):

| Pipeline                        | Initialization | Cold graph | Median single-file edit | Median two-file edit |
| ------------------------------- | -------------: | ---------: | ----------------------: | -------------------: |
| SWC cached modules              |        89.6 ms |    88.2 ms |                  2.0 ms |              3.35 ms |
| esbuild-wasm incremental bundle |       114.2 ms |   220.5 ms |                 11.9 ms |              13.3 ms |

Every SWC single-file sample transformed exactly one source module. This supports choosing SWC for this small live-edit workload. It also emits established React Refresh signatures without an additional transform. esbuild's incremental browser bundler works, but its output alone supplies no React Refresh instrumentation. A larger-package/application workload could change the comparison.

These numbers include dependency-graph resolution and transformation; they exclude React commit/paint and worker-message transport. They are not advertised as end-to-end user-visible latency. Integrated acceptance measurements cover the update pipeline separately. Cold initialization is affected by machine, WASM compilation and HTTP caches. The fixture is intentionally small, and there is no universal performance claim.

A second actual-browser comparison (`docs/benchmark-visible-results.json`) mounted both strategies on separate UUID app origins and ran twelve edits through the compiler worker, authenticated bridge, React commit and two animation frames. Median compile-to-visible acknowledgement was 33.25 ms for SWC and 33.3 ms for esbuild. The frame boundary dominated these small changes. SWC preserved a clicked local-state counter through every edit; the uninstrumented esbuild bundle remounted it. That correctness difference, not an exaggerated paint-latency advantage, favors SWC.

The complete production edit lifecycle has a separate thirty-edit fixture (`docs/benchmark-lifecycle-results.json`). It includes candidate verification on a disposable isolated origin, cleanup, state flushing and revision persistence. The recorded run created its first app in 370.6 ms, accepted warm edits in a median 282.4 ms (maximum 516.7 ms), and reloaded persisted source to a ready app in 190.2 ms. Chromium's coarse `performance.memory` report was 11.2 MB before and after thirty edits; this is neither total browser memory nor evidence that there are no leaks. No forced garbage collection was used. These measurements cover browser/platform work, not external AI generation latency.

SWC is Apache-2.0 licensed; esbuild is MIT licensed. Their packages, versions and licenses remain in the repository dependency lock.

## npm and shared cache

Generated projects declare exact package versions in `project.dependencies`. The browser downloads ESM from esm.sh using pinned versions and `target=es2022`, canonicalizes framework-package URLs to the stable runtime (rejecting incompatible exact major versions), follows its transitive module graph, then compiles those modules locally. The gateway may transform dependencies server-side; it never receives generated application source. This is a gateway dependency, not a local full npm/Node runtime.

The shell's `itsalive-dependencies-v2` Cache Storage holds downloaded bytes for reuse across app origins and browser reloads. A bounded 48 MiB/256-entry memory cache avoids repeated Cache Storage reads within the compiler worker. SHA-256 content digests for every fetched URL are saved in the project's lock. A different response for a locked URL fails the candidate rather than silently changing dependencies. Cached locked resources work offline; uncached resources require network access. Gateway availability and browser quotas remain real constraints.

The opt-in `ITSALIVE_LIVE_PACKAGES=1 npx playwright test e2e/live-dependencies.spec.ts` check fetched fresh nanoid 5.1.6 responses, compiled them with browser SWC and rendered random IDs on two isolated application origins. With distinct compiler workers, the first app downloaded two resources (648 bytes); the second downloaded none and read both from shell Cache Storage. The recorded compile totals were 663.0 ms cold and 166.2 ms with the shared resource cache, including fresh compiler initialization in each worker. `docs/live-dependency-results.json` contains raw evidence. Because this environment's browser proxy also intercepted local development origins, the optional test forwards fresh gateway responses through curl's configured proxy/CA trust into browser fetch. It does not claim to verify an unmodified browser-to-gateway connection. Deterministic browser acceptance uses recorded package bytes and also verifies offline restoration into a clean context.

Supported imports include TypeScript/TSX, JavaScript/JSX, ESM packages (including gateway-transformed CommonJS packages), JSON, ordinary CSS and URL-exporting assets. Relative CSS assets are embedded as data URLs. WASM resources imported as URLs can be fetched and instantiated with ordinary browser APIs. For binary project resources use a remote package resource; the current source-file representation is UTF-8 text. SVG and text assets work directly. The system has no Node process, filesystem or native extension runtime.

Computed module imports, Node builtins/polyfills, CSS modules, conditional CSS `@import`, and arbitrary remote module origins are rejected with diagnostics. Literal dynamic imports are eagerly collected into the candidate graph. Asset URLs resolve within project files or the esm.sh dependency graph. Modules that expect special bundler plugins, top-level await, a Node environment, or special import-meta machinery may require an alternative browser package. This is broad compatible npm support, not a promise that every npm package works.

SWC erases TypeScript types; it performs syntax/module validation, not full semantic `tsc` checking of generated projects. The platform's own code is checked with strict TypeScript. Candidate execution checks provide a further runtime gate, but cannot prove correctness of every future interaction.

## Safety and bounded work

The compiler clones candidate input and returns the resolved lock alongside immutable compiled output. Failures produce file-scoped diagnostics and never mutate a running revision. Limits currently allow 512 project files, 1024 resolved modules, 2 MiB per source file and 8 MiB per downloaded resource. Fetches time out after 30 seconds and compiler requests after 120 seconds. Source and package caches are shell-owned; credentials are never passed to this worker or package requests.
