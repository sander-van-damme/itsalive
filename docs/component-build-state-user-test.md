# Component-scoped build-state UX validation

Issue #90 moved unfinished-app feedback away from the old full-page frosted **Building…** treatment. #141 later simplified the lifecycle further: shell progress is component-scoped, but lifecycle state must not make already-rendered controls inert or block pointer/keyboard interaction.

This checklist validates the current behavior. Automated tests cover lifecycle wiring, partial readiness, failure localization, copy, and reduced-motion CSS.

Keep these constants for the round:

- same current `main` build and browser/environment;
- History budget: 12,000 tokens;
- coding-manager profile: High compute;
- component-worker profile: Low compute;
- no manual DOM edits during a run;
- export logs after each test.

## Test 1 — Independent parts become ready progressively

**Scenario:** Create an app with at least three visibly distinct parts, where two can be built independently and a third depends on both. A dashboard with controls, visualization, and history is suitable.

**Probe:** Partial readiness and localized build treatment.

**Observe:**

- unfinished parts alone have the quiet lifecycle treatment;
- a completed part remains visible and interactive while another part is still working;
- no whole-page frosted overlay or technical **Building…** label appears;
- shell progress uses product-facing copy such as “1 of 3 parts complete” and does not expose “regions”, workers, handoffs, or verification jargon;
- final completion is reported only after current integration evidence and semantic acceptance criteria are reconciled.

**Informative result:** Finished UI should remain usable while other parts continue, without making the whole app look blocked.

## Test 2 — One part fails while a sibling succeeds

**Scenario:** Use a task likely to exercise two independent components, then deliberately provoke or retain a failure in one component while another completes.

**Probe:** Failure localization and mental model.

**Observe:**

- the successful part stays usable;
- the affected scope may retain shell lifecycle styling, but the shell does not add `inert` to disable it;
- shell progress says that a part needs attention instead of presenting a whole-app failure;
- follow-up repair work is scoped to the affected part where practical;
- unhealthy deterministic integration evidence prevents the app from being declared complete.

**Informative result:** A local failure should feel like a local problem, not a reset or lockout of already-good work.

## Test 3 — Reduced motion and readiness clarity

**Scenario:** Repeat a multi-part build with the OS/browser reduced-motion preference enabled.

**Probe:** Accessibility and visual quietness.

**Observe:**

- unfinished parts remain distinguishable without motion;
- no pulse/shimmer/frost animation is required to understand readiness;
- lifecycle overlays do not intercept pointer input;
- `aria-busy`/build-state attributes describe shell lifecycle without being treated as worker-owned unfinished work;
- completed parts lose shell lifecycle treatment promptly;
- failed/blocked parts are reported as needing attention rather than as perpetually “still building”.

**Informative result:** Readiness should be communicated through state and copy, not animation or disabled controls.

## Comparison baseline

Compare against the 2026-09-23 evidence that motivated #90 and the 2026-09-26 reliability run that motivated #141. The old global/inert treatment made substantially complete-looking UI appear unusable and exposed internal “region” language.

When this checklist finds a mismatch, file a focused follow-up issue with the current build, browser, lifecycle/log evidence, and visible user impact.
