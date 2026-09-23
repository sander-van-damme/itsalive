# Agent prompt and context architecture

This note captures the design decision from issue #84. It is intentionally narrower than the manager/worker implementation in #88: this document defines what information each role should receive, what should remain stable/cached, and how we will measure whether a shorter prompt is actually better.

## Goal

Optimize for **successful useful work per dollar and second**, with token count as an input metric rather than the objective.

A shorter prompt is not automatically better. A prompt change is a win only when task success and robustness are preserved or improved.

## Evidence used

### Stable prefixes matter for caching

OpenAI's prompt-caching examples describe exact-prefix matching as the important property for cache hits. The Codex-oriented guidance in the cookbook keeps system instructions, tool definitions, sandbox configuration, and environment context stable and consistently ordered, and appends changing state later instead of rewriting the existing prefix.

Source: <https://github.com/openai/openai-cookbook/blob/main/examples/Prompt_Caching_201.ipynb>

Implication for itsalive:

- keep the small role contract stable and first;
- keep schema/tool ordering deterministic;
- put app/task/component/error state after the stable prefix;
- do not mutate stable prompt text just to inject current state.

### Measure quality, tokens, cost, caching, and latency together

OpenAI's agent-optimization examples evaluate variants with quality alongside input tokens, cacheable/cached tokens, output tokens, cost, and latency rather than optimizing one dimension in isolation.

Source: <https://github.com/openai/openai-cookbook/blob/main/examples/agent_optimization/optimizing_agents_for_cost_and_quality.ipynb>

Implication for itsalive:

- acceptance-criteria success and regressions are primary;
- tokens/cost/latency explain efficiency;
- cache hits matter separately from raw prompt length;
- a smaller prompt that increases repair loops can be more expensive overall.

### Prompt compression can work, but it is not the same as "caveman language"

LLMLingua reports large prompt-compression ratios on its evaluated tasks by using a learned model to identify less-important prompt tokens. Its own tooling distinguishes instruction, context, and question components and exposes different compression goals.

Source: <https://github.com/microsoft/LLMLingua>

Implication for itsalive:

- compression is worth testing for retrieved/history context;
- the result does **not** establish that manually removing grammar from critical instructions is reliable;
- execution protocol, safety boundaries, ownership rules, and completion rules should not be aggressively compressed without direct eval evidence.

## Current baseline

The production coding turn currently contains:

1. one large stable `SYSTEM_PROMPT`;
2. mandatory app purpose + curated behavior + current technical intent;
3. latest execution/environment observation when present;
4. recent technical history up to the configured history budget.

Raw user/assistant chat is already excluded from coding history after #78.

Issue #84 adds explicit token composition to `BuiltContext.tokenBreakdown`:

- `system`
- `mandatory`
- `observation`
- `environmentObservation`
- `history`
- `total`

This is deliberately provider-independent. #85 will add provider-reported cached/reasoning/cost attribution.

## Decision: default prompt style

### Use concise structured natural language

Default role prompts should use:

- short declarative sentences;
- explicit headings only where they disambiguate sections;
- concrete invariants;
- stable terminology;
- observable acceptance criteria;
- native API names/signatures when precision matters.

Avoid filler, motivational prose, duplicated examples, and repeated explanation of rules already encoded by the runtime.

### Do not adopt telegraphic/"caveman" language by default

The benchmark includes a telegraphic candidate because it is cheap to test, not because it is recommended.

Risks to measure:

- weakened instruction hierarchy;
- ambiguous negation or scope;
- worse tool/API selection;
- more repair turns;
- more accidental cross-component edits;
- weaker behavior on cheaper/low-compute models.

A telegraphic prompt only wins if end-to-end task quality stays equivalent while total cost/latency improves.

## Stable versus dynamic versus JIT context

The canonical role contracts live in `src/shell/core/agent-context.ts`.

### User-facing intent agent

Stable:

- interpret meaning before coding;
- explanation/question/preference/telemetry are not authorization;
- structured intent output contract.

Dynamic:

- current app purpose;
- current user input/source;
- selected behavior/telemetry when relevant.

JIT:

- compact capability index if request classification needs it.

Never repeat:

- coding transcript;
- full app HTML;
- unrelated interaction logs.

### Coding manager

Stable:

- decomposition/orchestration responsibility;
- scope ownership;
- technical intent, not raw conversation;
- final integration verification responsibility.

Dynamic:

- current technical intent and acceptance criteria;
- compact app/work-state summary;
- shared design/state contracts;
- dependency graph and worker handoffs.

JIT:

- focused DOM inspection;
- relevant capability help;
- relevant error/log summaries.

Never repeat:

- raw chat;
- full worker transcripts;
- full document snapshots when a compact work-state summary is sufficient;
- the full capability manual.

### Component implementation worker

Stable:

- modify assigned scope only;
- use supplied component/native DOM;
- verify assigned acceptance criteria.

Dynamic:

- one task;
- one scope/component;
- shared design/state contracts relevant to that component;
- interfaces/dependencies.

JIT:

- selected capability documentation;
- focused DOM inspection;
- relevant runtime evidence.

Never repeat:

- raw conversation;
- unrelated components;
- other worker transcripts;
- full capability manual;
- whole-app HTML by default.

### Repair/debug worker

Stable:

- diagnose from evidence before editing;
- preserve working behavior;
- verify the observed failure disappears.

Dynamic:

- assigned scope;
- latest error/observation;
- expected behavior/regression constraints;
- relevant shared state contract.

JIT:

- bounded logs;
- focused DOM/state inspection;
- selected capability help.

### Runtime LLM callback

Stable:

- answer only the runtime request;
- do not inherit coding-agent context.

Dynamic:

- runtime prompt.

Never repeat:

- coding transcript;
- app HTML;
- shell behavioral history;
- platform capability documentation.

## Capability documentation strategy

`src/shell/core/capabilities.ts` remains the canonical source.

The full capability catalog should **not** be repeated in every coding worker prompt. The intended pattern is:

1. stable role prompt knows that selected capability help may be supplied;
2. manager/intent layer selects capability IDs;
3. detailed help for those IDs is appended in dynamic/JIT context;
4. worker can request/receive additional capability help only when needed.

This keeps one source of truth without paying for every API description on every worker call.

## Context compression strategy

Treat instruction compression and history compression as separate experiments.

### Instructions

Do not automatically run critical stable instructions through a compressor.

Prefer manual removal of duplication while preserving grammatical, explicit rules. Evaluate any more aggressive compression with the same tasks and models.

### Retrieved/history context

This is the better candidate for aggressive reduction:

- prefer current work state over replaying how that state was reached;
- keep latest relevant failure/evidence;
- summarize repeated observations;
- retrieve logs/capabilities only when relevant;
- replace completed worker trajectories with compact handoffs;
- avoid replaying superseded code if current DOM/state already contains the result.

## Worker handoff

Workers return durable coordination state, not their transcript.

Canonical shape:

```json
{
  "status": "done | blocked | failed",
  "scope": "#component-or-description",
  "changed": ["short durable outcome"],
  "verified": ["observable check"],
  "unresolved": ["only if relevant"],
  "sharedContractChanges": ["only if manager coordination is required"]
}
```

`compactWorkerHandoff()` serializes this contract.

## Prompt caching layout

Within a role/model/profile, order context as:

1. stable role system prompt;
2. stable tool/schema definitions in deterministic order;
3. shared run contract that is genuinely common to many workers;
4. worker/task-specific dynamic context;
5. latest observation/error;
6. retrieved/JIT material;
7. new turn content.

Do not rewrite earlier stable content to reflect a new error or component. Append/change the suffix.

Whether a repeated shared manager contract is economically useful depends on provider cache behavior and will be measured by #85.

## Benchmark harness

`src/shell/core/prompt-benchmark.ts` defines five fixed scenarios:

1. simple initial build;
2. multi-component initial build;
3. targeted runtime repair;
4. modification of an existing app;
5. runtime LLM callback.

It compares the same dynamic task context against:

- `baseline`: current production `SYSTEM_PROMPT`;
- `concise-natural`: candidate shorter structured prompt;
- `telegraphic`: deliberately aggressive "caveman" candidate.

The static matrix changes **only prompt wording**. History-budget/context-selection experiments must be run separately so prompt compression and context compression are not conflated.

Run:

```sh
npm run benchmark:prompts
```

The CI test verifies:

- all scenarios are present;
- all variants see the same dynamic context/history;
- token composition adds up exactly;
- concise/telegraphic variants are actually shorter;
- telegraphic wording remains labeled experimental;
- role contracts exclude known pollution sources.

## Live eval protocol after #85

For each scenario + variant, record:

- acceptance criteria passed/failed;
- regressions;
- repair/model-call count;
- input tokens;
- cached input tokens;
- cache-write tokens if exposed;
- output tokens;
- reasoning tokens if exposed;
- provider cost;
- time to first useful execution;
- total wall time;
- stop reason;
- qualitative failure mode.

Use the same app starting state, model route, compute level, browser/build, and action sequence for comparisons.

Recommended first pass:

- same model + High compute for prompt-style comparison;
- repeat the strongest two prompt variants at Low compute as a robustness probe;
- only then vary history budget.

## Decision threshold

Do not replace the production prompt just because a candidate uses fewer estimated tokens.

Promote a candidate only if:

1. acceptance-criteria success is not worse;
2. regression/repair frequency is not worse in a meaningful way;
3. total provider cost and/or wall time improves;
4. Low-compute robustness does not collapse;
5. failures are understandable and recoverable.

If two prompts perform equivalently, prefer the simpler stable prefix.

## Implications for #85–#90

- **#85:** record provider-reported cache/token/cost data per request and context-source measurements.
- **#86:** profiles should reference role prompt/context policies, not duplicate prompt text ad hoc.
- **#87:** budget total work/cost/time; a shorter prompt that causes extra turns is not a win.
- **#88:** manager/worker isolation should use the contracts and compact handoff defined here.
- **#89:** parallel workers should share stable cached contracts but keep task-specific suffixes isolated.
- **#90:** build-state UI should be driven by worker/component lifecycle, not by prompt narration.
