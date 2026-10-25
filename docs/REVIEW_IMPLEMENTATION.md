# Owner review implementation — 22 October 2026

This is a historical report. The 25 October recovery changes supersede its token limits, reservation accounting, small agent ceilings, first-run settings flow and limited live probe. Current contracts are in [providers.md](providers.md), [PRODUCT_VISION.md](PRODUCT_VISION.md) and [acceptance.md](acceptance.md); [MILESTONES.md](MILESTONES.md) records the recovery scope and evidence boundary.

The approved redesign is implemented in this repository. It replaces the developer-oriented controls and legacy AI integration with OpenAI Responses, eligible local ChatGPT-plan access, four model categories, automatic task routing, live voice and simpler settings. The existing compile/verify/commit safeguards, isolated app origins and full backups remain in place.

This is an implemented and locally validated change, not a claim that the deployed application or a real provider account has been verified. No API credentials were available during validation. The owner authorized committing the implementation to main and pushing to the remote on 23 October 2026; deployment verification remains outstanding. Validation base: `37e0a11`; application version: `2.0.0-beta.2`.

## Feedback translated into changes

| Feedback theme                                    | Need                                   | Implemented behavior                                                                                                                                                                                                                                        |
| ------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “It says connected, but nothing works”            | Reliable operation and truthful status | The badge follows checks and request results. Setup probes structured replies and function tools for each configured text route. Failures show actionable messages, retain the working app and restore the typed draft.                                     |
| Failed application creation/change                | Useful failure recovery                | Responses transport supports modern models, streamed terminal errors and encrypted reasoning/tool continuation. Candidate builds still compile and render in disposable origins before committing; failed candidates never replace the working revision.    |
| Too many provider and model options, old defaults | A capable default setup                | OpenRouter is removed. OpenAI API key and eligible ChatGPT-plan access remain. Low defaults to GPT-6 Luna; Medium to GPT-6.1 Sol; High to Sol with higher reasoning; Live voice to GPT-Live 1. Astra is an optional model choice.                           |
| “Users shouldn't choose Think deeper”             | Automatic quality decisions            | That chat control and its separate handler are removed. Conversation assigns small, ordinary and complex work to the corresponding configured category; unresolved repairs use High automatically.                                                          |
| Responsive service without technical terms        | A clear speed/cost choice              | Standard/Faster/Fastest changes supported service priority. Short explanations describe higher API cost or plan allowance, without exposing service-tier identifiers. Unsupported choices fail validation instead of quietly changing the selection.        |
| Spending limit should be optional                 | Budget control without mandatory setup | The monthly API estimate limit starts off. Enabling it reveals the amount. Internal queuing handles ordinary bursts, prioritizes conversation and retains runaway safeguards without exposing RPM/concurrency fields.                                       |
| Settings plus another menu is confusing           | One obvious navigation entry           | The footer has one three-dot menu. It contains Settings and Restore this app to a previous version.                                                                                                                                                         |
| Backup and restore versus previous version        | Clear scope before recovery            | Full backup/restore lives inside Settings and explicitly covers all apps. App version recovery is labeled as belonging to the current app and retains its saved data. Existing backup validation, cancellation and destructive restore confirmation remain. |
| Developer tools don't belong here                 | An ordinary-user application           | Developer toolbar, source editor, source handlers and related styles are removed. Internal compilation and file tools remain private to the application workflow.                                                                                           |
| Diagnostic logs cannot be retrieved               | Support evidence during failures       | Settings → Help and diagnostics has one Debug logging switch and Download diagnostic logs. Saving debug settings and downloading logs work without successful AI setup. Exports contain safe error/request context, app/browser version, health and usage.  |
| Suggestions shouldn't require configuration       | Helpful defaults                       | Concise suggestions are normal conversational behavior. Their acceptance is still required before making a suggested change. Removing the setting does not turn on passive click tracking.                                                                  |
| Test provider exposed to ordinary users           | Keep test machinery out of the product | Scripted mode is available only through the explicit development URL `?test-provider=scripted`; it is absent from settings and never an error fallback.                                                                                                     |
| Speak is inadequate                               | Natural AI conversation                | Voice uses OpenAI GPT-Live 1 over WebRTC. Native browser speech recognition is removed. Delegated requests use the ordinary intent and application-change workflow.                                                                                         |
| Keep talking while work happens                   | Conversation and work can overlap      | A question can complete during an ongoing build. Further requested edits wait safely and recheck their app. Spoken follow-ups carry the preceding live dialogue, so “yes, add that” has context.                                                            |
| Talk without hearing the model                    | An actual silent-reply mode            | Spoken replies can be turned off; audio playback is hard-muted while transcripts remain visible. The preference persists. Microphone mute and End conversation release/control media separately. Voice generation is still metered when playback is muted.  |
| Enter does not send                               | Familiar chat behavior                 | Enter submits, Shift+Enter adds a line, held Enter does not duplicate submission and IME composition does not submit early.                                                                                                                                 |

## What the investigation established

The source confirmed that the old badge relied on configuration, speech used browser recognition, diagnostic download was hidden behind developer controls, debug saving could depend on a successful provider check, the model defaults were old and the composer lacked normal Enter submission.

The new integration uses the documented public Responses endpoint, rather than treating all “OpenAI-compatible” interfaces as interchangeable. A small same-origin server boundary forwards the user's API key without storing it; it is implemented for Vite development and the Cloudflare root Worker. It also creates live-voice sessions. The wildcard application's immutable bootstrap was not changed.

The exact deployed failure described in the recording was not reproduced with a real account or original logs. These changes address confirmed code defects and improve diagnosis, but they do not establish that a particular deployed network or credential failure has disappeared.

## Account access and voice setup

For local API-key use, start the shell and app development servers and open `http://itsalive.localhost:4173`. Settings accepts an OpenAI API key, tests it and resumes the pending goal.

For eligible ChatGPT-plan use, also run `npm run connection`, choose ChatGPT plan and Continue with ChatGPT. The local helper performs official OpenAI sign-in, loads account-specific models and keeps OAuth tokens out of browser storage. It uses eligible plan allowance shared with Codex; it is not GitHub OAuth. Identity, PKCE, state/nonce, rotating tokens, granted scopes and sign-out are handled in the helper.

OpenAI currently documents this plan-sharing integration for eligible local open-source/personal tools. Paid/remote offerings require OpenAI access. The hosted account option stays disabled unless an approved installation enables `VITE_CHATGPT_PLAN_ENABLED=1` when building. A one-click packaged desktop helper is not included; local setup currently requires the documented command. One account registration is supported per helper directory.

Live voice requires an OpenAI API key even when app work uses the ChatGPT plan. It has separate usage. Turning off Spoken replies mutes playback rather than switching to a free text service. Browser microphone permission, network support and model access still apply.

## Validation evidence

Validation used Linux, Node, Chromium and the actual local app origins. Provider HTTP replies and WebRTC events were controlled fixtures; application compilation, verification, storage and state-preserving updates were real.

- Dependency installation and TypeScript checks passed.
- All 78 unit cases passed across the full run and the focused voice rerun. Coverage includes Responses serialization/SSE, late errors, encrypted reasoning continuation, optional budgets, queued work, OAuth/PKCE/identity/scopes, atomic refresh, token isolation, same-origin forwarding and voice cleanup/context.
- All 33 required browser scenarios passed across the regression run and focused reruns. One optional live-CDN scenario remained disabled. The final rerun corrected an account-test selector and verified account setup plus live voice; the last full regression run had passed the other scenarios. No unresolved product failure remained in these tests.
- Browser coverage includes goal creation, automatic changes, stronger routing for unresolved repair, working-app retention, connection health recovery, keyboard/IME, offline diagnostics, mobile settings, app storage isolation, all-app backup/restore and current-app rollback.
- The live-voice browser test holds an app build open, answers a question during it, queues another change, verifies the resulting application, checks silent playback and releases media at the end.
- `npm run test:production` passed: both production builds, first-run setup/resumption, actual WASM compiler and UUID bootstrap, goal generation, subsequent change, retained React and saved state, reload, absent development hooks and no uncaught browser errors.
- The bundled root Worker passed API/asset dispatch checks. The local account helper bundled successfully and its real HTTP server is exercised by unit tests.
- Desktop and mobile screenshots were inspected. The app occupies the main workspace; settings fit the mobile viewport; source controls and the redundant settings button are absent.
- `git diff --check` passed. The existing root bundle-size advisory remains; builds succeeded.

Screenshots from deterministic browser scenarios are in `work/screenshots/`. Historical screenshots in the earlier product recovery report describe that earlier iteration.

## Release checks still outstanding

1. Use a real OpenAI account to verify model access, structured/tool generation, selected speed and actual billed usage. The opt-in `npm run test:live -- --live --provider=openai` probe is available and defaults to a small estimated cap.
2. Complete a real eligible ChatGPT account sign-in and verify allowance behavior. Hosted plan access needs the separate provider approval described above.
3. Try a physical microphone and speaker/headset: full-duplex timing, interruptions, silent replies and live task delegation. Automated media fixtures cannot establish recognition quality or network latency.
4. Deploy and verify the root Worker with the built shell assets and the existing wildcard bootstrap through the normal release process. Static shell hosting alone does not provide the new `/api/*` routes. Publishing to main alone does not verify the live site.

Spending controls remain browser estimates rather than account-wide hard caps. Voice fragments are displayed live; this implementation does not add durable storage for every spoken transcript fragment. Existing limits on arbitrary generated-app semantics and inaccessible browser backup data still apply. Detailed protocol references and setup are in `docs/providers.md`.
