# Component-scoped build-state UX validation

Issue #90 changes unfinished-app feedback from the previous full/frosted **Building…** treatment to shell-owned component lifecycle states. This checklist is the human validation step; automated tests cover state wiring, accessibility attributes, partial readiness, failure localization, and reduced-motion CSS.

Keep these constants for the round:

- same current `main` build and browser/environment;
- History budget: 12,000 tokens;
- coding-manager profile: High compute;
- component-worker profile: Low compute;
- no manual DOM edits during a run;
- export logs after each test.

## Test 1 — Independent regions reveal as they finish

**Scenario:** Create an app with at least three visibly distinct regions, where two can be built independently and a third depends on both. A dashboard with controls, visualization, and history is suitable.

**Probe:** Partial readiness and localized build treatment.

**Observe:**

- unfinished regions alone have the quiet lifecycle treatment;
- a verified region becomes fully visible and interactive while another region is still working;
- no whole-page frosted overlay or technical **Building…** label appears;
- shell progress reports a partial count such as “1/3 regions ready” rather than implying the whole app is blocked;
- final completion waits for manager integration verification.

**Informative result:** We should be able to use a finished region before the entire app is complete without mistaking unfinished controls for usable controls.

## Test 2 — One component fails while a sibling succeeds

**Scenario:** Use a task likely to exercise two independent components, then deliberately provoke or retain a failure in one component while another completes.

**Probe:** Failure localization and mental model.

**Observe:**

- the successful region stays usable;
- only the affected scope remains inert and visually unfinished/failed;
- shell progress says one region needs attention instead of presenting a whole-app failure;
- follow-up repair work is scoped to the failed region where practical;
- final manager verification does not declare the app complete while that region remains unresolved.

**Informative result:** A local worker failure should feel like a local unfinished part, not a reset or failure of already-good work.

## Test 3 — Reduced motion and readiness clarity

**Scenario:** Repeat a multi-region build with the OS/browser reduced-motion preference enabled.

**Probe:** Accessibility and visual quietness.

**Observe:**

- unfinished regions remain distinguishable without motion;
- no pulse/shimmer/frost animation is required to understand readiness;
- `inert` and `aria-busy` prevent unfinished interaction while work is active;
- ready regions lose the shell lifecycle attributes and become interactive immediately;
- failed/blocked regions remain non-interactive but are not reported as still busy.

**Informative result:** The treatment should communicate “not ready yet” through structure/state rather than animation.

## Comparison baseline

Compare these runs against the 2026-09-23 test evidence that motivated #90: the old global frosted **Building…** treatment made substantially complete-looking UI appear blocked and did not communicate which region was actually unfinished.

Do not close #90 based on automated tests alone. Close it after this human pass confirms the revised treatment is clearer in the real shell/app composition, or file focused follow-up issues for any remaining visual/copy problems.
