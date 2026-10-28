# V2 implementation milestones

V1 preserved at `archive/v1` and tag `archive-v1-2026-10-21`. V2 is now on main. The earlier recovery report covers `fix/product-experience-recovery`. The 2026-10-22 review implementation was validated from base `37e0a11`; the owner authorized committing it to main and pushing to the remote on 2026-10-23. Production deployment remains a separate verification step.

- [x] Read V1 architecture, invariants, and issues #168 and #149.
- [x] Preserve V1 and establish a clean implementation branch.
- [x] Compare browser compiler strategies with reproducible measurements.
- [x] Integrate shell, authenticated origins, source projects, compilation and state-preserving updates.
- [x] Integrate bounded providers, conversation, file tools, repair and optional behavior suggestions.
- [x] Implement shell-owned portable backup and restore, including app-origin storage.
- [x] Run deterministic tests, real multi-origin browser acceptance and benchmarks.
- [x] Document evidence, limitations and reviewable Git changes.

Design invariants: source is authoritative; failed candidates keep the active app; credentials and platform authority remain in the shell; wildcard deployment is bootstrap only; deterministic checks decide technical success. Verification must not mutate live app data. No V1 compatibility machinery.

Owner authorization to publish to main does not establish live-provider compatibility, real live voice quality or successful production deployment. See [the original V2 implementation report](V2-REPORT.md) and the latest review report below for measured evidence and limitations.

## Product experience recovery

The authoritative contract is [PRODUCT_VISION.md](PRODUCT_VISION.md), enforced by root AGENTS.md and product acceptance scenarios. Recovery replaces the developer-oriented default with the running application and one assistant/navigation rail, explicit provider onboarding, private coding delegation and an unresolved-feedback conversation. The later owner review removes developer tools and source editing entirely.

Validation and reviewed screenshot evidence are recorded in [PRODUCT_RECOVERY.md](PRODUCT_RECOVERY.md). Live-provider response quality and live microphone performance remain separate from deterministic browser evidence.

## Owner review implementation — 2026-10-22

- [x] Replace OpenRouter/legacy chat transport with OpenAI Responses and preserved reasoning/tool continuation.
- [x] Add local ChatGPT-plan connection, model catalog and protected credential lifecycle.
- [x] Configure Low, Medium, High and Live voice defaults with automatic task routing.
- [x] Add familiar speed controls, optional monthly API spending limits and internal burst queuing.
- [x] Base connection health on actual results and preserve working apps and drafts after failure.
- [x] Consolidate the three-dot menu; separate all-app backups from current-app version recovery.
- [x] Remove source/developer tools, Think deeper, native browser speech and testing options from ordinary settings.
- [x] Provide independent debug logging and visible diagnostic downloads.
- [x] Add Enter/Shift+Enter/IME behavior and ordinary conversational suggestions.
- [x] Add AI live voice with silent playback, conversation context, concurrent questions and safely queued changes.
- [x] Validate TypeScript, unit/regression cases, Chromium workflows, production builds and Worker dispatch.
- [ ] Validate real OpenAI credentials, eligible account access, live microphone quality and billed speed/cost.
- [x] Obtain owner authorization to commit the implementation to main and push to the remote.
- [ ] Deploy and verify the root Worker/assets through the normal release process.

See [REVIEW_IMPLEMENTATION.md](REVIEW_IMPLEMENTATION.md) for the requirement mapping and exact evidence boundaries.

## Real-world failure recovery — 2026-10-25

- [x] Remove application token/input/workflow caps and obsolete stored output allowances; preserve selected model reasoning.
- [x] Replace reservations with reported usage and explicitly estimated/unknown costs, cached-token pricing and optional after-request spending thresholds.
- [x] Persist private candidate checkpoints, safe continuation/operation receipts and original goals; resume after interruption without overwriting working revisions.
- [x] Distinguish actual compilation/runtime-check results from successful tool execution; add correlation, timing, recovery and privacy-safe DEBUG evidence.
- [x] Separate onboarding from Settings; reuse exact validation on Save; add naming, real progress, cancellation, retry, keyboard behavior and concise connection/menu controls.
- [x] Use OpenAI Decisions for supported bounded judgments and retain Responses for text, tools and arbitrary structured generation.
- [x] Add realistic incomplete-output, reload, cancellation, long-context, accounting and actual Chromium regression coverage.
- [x] Extend CI to main and development branches; preserve pull-request checks.
- [ ] Complete real-provider creation/update and Decisions latency/cost comparison with securely supplied credentials. Both opt-in commands were attempted; this environment has no `OPENAI_API_KEY`.
- [ ] Verify the deployed site, real Windows Chrome and physical voice devices through the release process.

The matched deterministic violin workflow used Node 24.19.0 and Chromium 141 on Linux at 1440×900. Baseline/after request counts were 18/13 (the latter includes a new Decisions capability probe); unchanged Save repeated 6/0 probes. Connection plus creation took 1176/1155 ms, which establishes no meaningful latency improvement. These fixtures measure local integration overhead, not OpenAI latency or actual billed cost. [providers.md](providers.md) defines the new contracts and [acceptance.md](acceptance.md) describes executable coverage.

Validation completed: `npm ci`, `npm run typecheck`, `npm test` (157 tests across 18 files), `npm run build`, `npm run test:e2e` (39 passed, opt-in live-provider/live-CDN cases skipped), `npm run test:production`, `npm run benchmark` (3 passed), and `git diff --check`. `npx playwright install --with-deps chromium` could not elevate to install OS packages; `npx playwright install chromium` succeeded and Chromium ran with the existing libraries. The root bundle-size advisory remains. Real-provider commands were attempted and explicitly reported the missing key. Before/after screenshots were captured and inspected in ignored `work/screenshots/before/` and `work/screenshots/after/`; paired workflow measurements are in `work/workflow-latency-before.json` and `work/workflow-latency-after.json`.

## Detailed usability review — 26 October, validated 28 October 2026

- [x] Preserve all 161 feedback records and 35 technical findings in a 196-ID coverage matrix and 12 implementation tickets.
- [x] Implement the confirmed left sidebar, collapsed daily controls, focused welcome/onboarding, grouped settings and system/light/dark appearance.
- [x] Add actual app inspection, discovery questions, structured choices, scoped memory/general instructions, named-app references and live voice context.
- [x] Add generated design policy and measured rendered contrast/name checks that require repair before publication.
- [x] Preserve successful work through live-apply recovery, durable retry, truthful progress/precise overlays, coherent cancellation/feedback and version restoration.
- [x] Preserve complete backup ledgers/settings/drafts; add full opt-in debug evidence, credential redaction, snapshot/retention metadata and build/operation identity.
- [x] Implement browser OAuth credentials, PKCE/OIDC, refresh and sign-out; reject missing/narrowed allowance grants and preserve local installation support.
- [x] Pass TypeScript, 241 unit tests, both production builds, 68 browser scenarios (2 opt-in skips), production asset smoke and patch checks.
- [ ] Obtain the provider-issued hosted client/plan grant and verify real allowance login/inference/revocation.
- [ ] Complete real-provider quality/cost/audio and Windows incognito acceptance with supplied credentials/hardware.
- [ ] Review, merge and deploy through the release process.

The [review implementation report](review-2026-10-26/README.md) contains per-ticket criteria, screenshots, verification limits and the complete ID-to-evidence matrix. Deterministic success is not a claim that production access, model empathy or all generated accessibility behavior is already verified.
