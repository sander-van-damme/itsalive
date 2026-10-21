# Product and UX recovery

This change restores It's Alive as an adaptive interface for ordinary users. The running application fills the left side and one compact, collapsible right rail contains app switching, creation, conversation, speech and platform actions. Mobile Application/Assistant views retain the mounted app. Source editing and technical identifiers are available only in optional Developer tools.

## Permanent mandate

`docs/PRODUCT_VISION.md` is authoritative. The prominent product contract in root `AGENTS.md` requires future changes to preserve application-first use, natural interaction, authorization through explicit requests, helpful feedback, uncertainty-aware suggestions, private engineering workflows and executable UX acceptance. README, provider and acceptance documentation now describe the actual product journey. The old V2 report is marked historical where its Demo and approval workflow conflicts with this contract.

## New journey

1. Describe a goal in the composer or New app dialog, using text or browser speech.
2. If AI is unconnected, select OpenAI or OpenRouter, use the suggested model, enter a key and connect. A bounded provider request validates text access and records its usage. The original goal resumes after success. Cancel restores the request text and prevents a later unrelated Save from starting it.
3. The companion distinguishes discussion, clarification, ordinary change and high-risk confirmation. Explicit creation, modification and repair flow directly into private coding. Questions receive answers without editing the app.
4. The coding harness reads and edits a bounded candidate, compiles it, checks it in a disposable origin and applies it through the existing expected-version and rollback safeguards. User-facing progress describes work and results; worker summaries, source and tool details stay in diagnostics.
5. Try the application. Compatible component state and durable data survive ordinary updates. Restore previous version remains available in ordinary language.
6. Not yet records the unresolved request/app/version and continues the conversation. Deterministic runtime errors can initiate investigation; otherwise the companion asks what is still wrong. Specific clarification authorizes another repair. Vague dissatisfaction alone does not cause rewriting.

## Engineering changes and findings

- Split the shell view, settings controller and orchestration into modules while retaining the existing compiler, runtime, origins, persistence and backup architecture.
- Replaced automatic Demo defaults with unconnected external-provider defaults. Scripted operation requires an explicit Advanced opt-in, including for a previously saved Demo configuration.
- Added provider setup drafts, connection checks, retained accounting on failed probes, actionable key/quota/network errors and request resumption. Advanced routes/prices/limits remain configurable.
- Added strict structured intent validation and bounded per-app feedback-attempt records with original request and version associations.
- Removed the public counter starter. Domain-specific violin and knot content exists only in deterministic test fixtures; the product creates goal-specific content through AI.
- Updated observation consent through the authenticated bridge without remounting the app. Dismissed and ignored suggestions cannot authorize changes.
- Fixed speech listening/error recovery and kept browser transcription separate from AI configuration.
- Used named native modal dialogs, visible close controls, keyboard focus containment/return, progressive disclosure and responsive sizing.
- Fixed the HTTP adapter calling native `fetch` with an invalid receiver. Real browser provider testing exposed this failure, which mocked fetch unit tests did not.
- Separated root/app Vite optimization caches after real browser testing exposed one server invalidating the other's dependencies.

## Research applied

Reviewed Nielsen Norman Group's [usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) and [progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/), [WCAG 2.2](https://www.w3.org/TR/WCAG22/), the [WAI modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), and Google's [People + AI feedback/control guidance](https://pair.withgoogle.com/guidebook/chapters/feedback-and-controls/). Concrete applications include minimal default controls, clear recovery, status without focus theft, keyboard-accessible exits, predictable cancellation, dismissible assistance and immediate clarification after unsuccessful results. This is not a claim of a formal WCAG audit.

## Validation

Completed on 2026-10-21 in the Linux cloud workspace. See `docs/acceptance.md` for scenario and invariant coverage. Browser tests use real isolated Chromium origins and the real compiler, checks and runtime; provider HTTP responses are deterministic test replays.

| Check                     | Result                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`       | Passed                                                                                                                                                                                                |
| `npm test`                | 74 tests passed across 11 files                                                                                                                                                                       |
| `npm run build`           | Both static builds passed                                                                                                                                                                             |
| `npx playwright test`     | 30 passed: 10 product journeys, 17 platform regressions and 3 browser benchmarks; 1 opt-in external dependency test skipped                                                                           |
| `npm run test:production` | Passed built-asset setup/resumption, violin generation, automatic change, hidden source editor, same UUID frame, transient state, durable reload, no development hooks and no uncaught browser errors |
| `git diff --check`        | Passed                                                                                                                                                                                                |

Playwright 1.56.1 uses Chromium 141. Desktop and mobile screenshots were manually reviewed, not only captured. Additional manual keyboard tests covered 280 Tab/Shift+Tab steps across basic and long Advanced settings. The production build still reports its bundle-size advisory for the shell-owned runtime/WASM foundation; no build failure occurs.

## Reviewed screenshots

Before captures use the unchanged V2 baseline `daf671e`. After captures exercise deterministic provider replay through the actual app workflow; they are not claims of live-provider generation.

| View                    | Before                                                                   | After                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Desktop, 1440 × 900     | [V2 counter and three-column shell](product-recovery/before-desktop.png) | [Violin practice and companion](product-recovery/after-desktop.png)                                                     |
| Mobile, 390 pixels wide | [Stacked V2 workspace](product-recovery/before-mobile.png)               | [Application](product-recovery/after-mobile-application.png) · [Assistant](product-recovery/after-mobile-assistant.png) |
| Settings, 390 × 844     | —                                                                        | [Primary AI setup](product-recovery/after-mobile-settings.png)                                                          |

The lead and visual/QA specialists inspected these images. The desktop app occupies 1080 of 1440 pixels, with a 360-pixel assistant rail; collapsing leaves a 56-pixel rail. Mobile app and chat use separate full-width views. Settings' close control stays visible in long Advanced forms. Browser checks found no horizontal page overflow. Long goal-derived app names are truncated in the compact switcher; its expanded list displays them.

## Remaining limits

No live OpenAI/OpenRouter key was available. The connection check implementation, HTTP contracts and replayed end-to-end workflows are verified, but live authorization, account/model availability, response quality, latency and billed cost are not. The connection probe establishes text access, not universal structured-output/tool compatibility for arbitrary custom models. Browser speech events are simulated; physical microphone recognition and vendor services are unverified. Only Chromium is tested. No deployment, DNS/TLS validation or merge is performed.

Candidate verification compiles and renders; it cannot establish every semantic behavior of arbitrary generated software. The browser acceptance scenarios exercise actual controls for the generated fixtures, including a semantic Start-button bug that render checks alone cannot detect. TypeScript is transpiled, not semantically typechecked. Existing limits for broad app-origin capabilities, external network effects, backup coverage and client-side spending estimates continue to apply. Native app origins and credentials remain separated.
