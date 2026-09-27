# Reliability regression suite

This suite locks in the platform reliability work from issues #139 through #145 using the user workflows that exposed the failures in the September 2026 test round.

## CI

Run:

    npm run test:reliability

The deterministic CI scenarios live in `tests/reliability-scenarios.test.ts`.

They intentionally use fake model responses while exercising the real coding orchestrator, AgentRunner completion rules, DOM execution contract, canonical app contract, application.store persistence, and document snapshot/restore behavior.

The five scenarios are:

1. **Simple initial interactive build**
   - rejects malformed generated output before any partial mutation executes;
   - accepts deterministic completion when the semantic completion assessor is merely uncertain;
   - reaches usable, non-blocked UI;
   - proves the primary control changes durable state.

2. **Movie Night Planner**
   - uses the original multi-component workflow;
   - adds a real movie, renders the shortlist, chooses Tonight, and removes the movie;
   - asserts known verification-probe names never appear in DOM or application.store;
   - requires the initial manager/worker run to finish with the canonical shared contract intact.

3. **Explicit repair**
   - deliberately breaks the movie form interaction after real user data exists;
   - runs the repair-worker path for “the app buttons don't work”;
   - verifies existing data remains;
   - verifies the established technical contract is preserved rather than silently renaming shared fields.

4. **Runtime AI / Word Decider**
   - uses the original “it decides whether the word is in English” wording;
   - verifies the intent layer discovers the AI capability;
   - verifies the manager always receives the typed `application.ai.decide` API;
   - verifies selected worker help contains the same API;
   - exercises true, false, and null UI outcomes.

5. **Reload, restore, then modify**
   - builds an interactive app and writes real durable state;
   - snapshots the document/store and restores them;
   - reconstructs persisted setup behavior;
   - verifies state and interaction still work;
   - performs an existing-app modification while preserving the original technical contract.

The suite is outcome-focused. It should not grow into a duplicate unit-test matrix. Add a scenario only when it protects a cross-layer user workflow that unit tests do not adequately cover.

## Live Auto Router eval

Run:

    npm run eval:reliability

The command prints the fixed prompts, action checks, and telemetry checklist.

Use a clean browser session and keep these constants for the normal reliability run:

- same deployed build;
- Chrome incognito (or an equivalent clean state);
- OpenRouter route `openrouter/auto`;
- History budget 12,000 tokens;
- cross-app preferences off;
- identical prompt wording and user action sequence.

Before each run, capture the **Settings → Agent profiles** table. After each run, export diagnostics.

Record:

- acceptance-criteria outcome and final lifecycle state;
- manager/worker calls and repair loops;
- role, profile, model route, and compute;
- first useful execution and total wall time;
- completion and JEV decisions;
- configured/effective/selected/omitted history;
- model context capacity;
- provider input/output/reasoning tokens;
- JEV request/token usage.

Quality and reliability are the gate. Do not add token, latency, or dollar thresholds until repeated measurements justify them.

## Compute robustness probe

Compute is a robustness variable, not a quality target.

When a scenario is important or fails unexpectedly, repeat that same scenario with component-worker compute:

1. Low;
2. Medium;
3. High.

Use a temporary controlled test configuration/branch that changes only the component-worker profile in `src/shell/core/agent-profiles.ts`. Keep the manager profile, model route, history budget, build, browser state, prompt, and action sequence unchanged.

Do not use Extra High or Max for this protocol.

If Low alone fails, investigate whether the platform contract is unnecessarily difficult or ambiguous before treating the model as the sole cause. If all compute levels fail the same way, stop varying compute and investigate the shared platform failure.

## History experiments are separate

Do not vary History budget during the baseline reliability suite. The reliability gate answers “does the pipeline work?” Context experiments answer a different question: “what is the minimum sufficient history for this workload?”

Only vary history after the reliability scenarios are stable, and compare quality before optimizing tokens.
