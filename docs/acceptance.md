# Browser acceptance evidence

Run `npm run test:e2e` after `npm install` and `npx playwright install chromium`.
Playwright starts the shell on `http://itsalive.localhost:4173` and the wildcard
bootstrap on `http://<UUID>.itsalive.localhost:4174`. Chromium maps these hostnames
to loopback. Each application therefore has a real, distinct browser origin;
these tests do not substitute same-origin frames or a DOM emulator.

The tests interact with the creation, conversation and suggestion UI. A development
only `window.__itsalive` API supplies source edits and backup operations without
requiring an external AI credential. It calls the same workspace, compiler,
verification, bridge and repository operations as the UI.

## Required scenarios

| Requirement                                | Browser coverage                                                                                                                                                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Functional multi-file React creation    | UI creates the starter; counter is clicked in its UUID frame; project has multiple source files.                                                                                                                                                         |
| 2. Fast source hot update                  | Source changes through the real compiler and frame, with the frame URL unchanged; benchmark suite records latency separately.                                                                                                                            |
| 3. Transient and durable state retention   | React hook counter and Zustand durable counter survive a compatible edit; durable counter survives reload.                                                                                                                                               |
| 4. Broken source leaves the old app usable | Invalid TSX is rejected; revision ID and live counter remain intact and interactive.                                                                                                                                                                     |
| 5. Repair applies successfully             | Broken source is repaired and a visible heading change applies without losing state.                                                                                                                                                                     |
| 6. Add and cache an npm dependency         | Pinned `clsx@2.1.1` resolves a gateway entry and implementation module; hashes are recorded.                                                                                                                                                             |
| 7. Reuse across application origins        | Second UUID application imports the same package without further module fetches; shell reload also reuses Cache Storage.                                                                                                                                 |
| 8. Incompatible dependency diagnostics     | `node:fs` import is rejected with a Node/browser diagnostic and no revision change.                                                                                                                                                                      |
| 9. App text and decision AI                | Generated TSX imports `@itsalive/ai`; user clicks invoke text and bounded boolean calls through the shell's demo provider.                                                                                                                               |
| 10. Conversation and authorized coding     | Conversation proposes work; source stays unchanged until Apply change; actual coding harness produces a running revision.                                                                                                                                |
| 11. Meaningful behavior suggestion         | Real iframe clicks generate no suggestion before consent. After enabling observation in Settings, four repeated clicks travel through the runtime collector and bridge to the advisor and display a dismissible suggestion; existing app remains usable. |
| 12. Rejected/ignored suggestion            | Revision stays unchanged while the suggestion is ignored and after Dismiss.                                                                                                                                                                              |
| 13. Reload with source and data            | Updated heading and durable counter reappear after shell reload.                                                                                                                                                                                         |
| 14. Backup and restore in clean context    | Archive is imported into an empty browser context with dependency network requests denied; source, cached npm dependency, shell durable state, localStorage, IndexedDB schema/index/version/typed data, Cache Storage and OPFS are verified.             |
| 15. Multiple storage origins               | App A's localStorage is absent in B; switching back restores A's value.                                                                                                                                                                                  |
| 16. Credential/capability boundary         | App frame cannot access shell localStorage due to browser same-origin enforcement; credential sentinel is absent locally; retired privileged globals are absent. Bridge unit tests cover protocol validation.                                            |
| 17. Useful failure diagnostics             | Deliberately invalid source produces file-specific diagnostics with correlation identity and timestamp; the UI downloads a JSON export containing that failure.                                                                                          |

Additional browser checks reject a runtime-crashing candidate before it reaches
the active app or writes to its origin, and verify state preservation when the
component module itself changes and when source is rolled back.

A controlled scheduling test pauses an actual compiler invocation, switches to
another application, and then releases compilation. The stale edit must be
rejected, with both applications' revision pointers and durable state unchanged.
An empty-archive test restores an empty workspace over an active app and verifies
that frame, source pointers and app list remain empty after reload. A narrow-screen
UI test opens settings and backup, accesses provider price inputs, and downloads
diagnostics at a 390-pixel viewport width.

Speech tests inject scripted browser recognition events to exercise the actual
Speak button, transcription-to-composer path and normal conversation approval.
Another test removes recognition support and verifies the typing fallback. These
test UI wiring and capability handling, not microphone capture or the browser
vendor's remote speech-recognition service.

## Deterministic versus external tests

The normal suite makes no paid provider calls. It exercises the explicit local
demo provider through the real orchestration and app bridge. Provider HTTP unit
tests validate request and response contracts separately; neither substitutes for
an authenticated live-provider compatibility test.

The npm acceptance test intercepts only the dependency gateway HTTP responses.
It supplies the real `clsx@2.1.1` ESM implementation captured from esm.sh on
2026-10-21 plus a deterministic re-export wrapper. Download accounting, transitive
module traversal, transformation, SHA-256 locking, shell cache persistence and
app-origin execution remain real. This keeps the default suite independent of
gateway uptime; it does not establish availability of the live CDN.

Playwright retains failure traces and screenshots under `test-results/` and writes
an HTML report to `playwright-report/`. Compiler comparison results are recorded by
`e2e/benchmark.spec.ts`; see `docs/compiler.md` for architecture tradeoffs.

## Execution status

On 2026-10-21, `npx playwright test e2e/platform.spec.ts --workers=1` passed all
17 tests in 26.5 seconds using Chromium 141 / Playwright 1.56.1 in the Linux cloud
workspace. `npm run typecheck` also passed. No external AI credentials
were available or used. Firefox, WebKit, production TLS deployment and real
microphone recognition were not tested.

The browser tests discovered an unbound `fetch` receiver in the compiler worker;
fixing it enabled actual dependency downloads. They also caught a test assumption:
the HTML mount's `id="application"` creates a named Window DOM property, which is
not the retired privileged application API. Tests now verify the absence of its
old capabilities explicitly.

Playwright sets `ITSALIVE_E2E=1` to suppress Vite's shell-development hot reload
during acceptance. The platform's generated-application refresh mechanism remains
active and is exercised by the state-retention tests. Desktop (1440×960) and mobile
(390×844) screenshots were inspected; the narrow viewport had no horizontal page
overflow. Mobile access to settings, backup, provider pricing and diagnostic export
was corrected and then verified in both the browser test and an updated screenshot.
