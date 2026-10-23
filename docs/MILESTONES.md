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
