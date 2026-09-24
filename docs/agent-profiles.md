# Agent profiles

Agent profiles are the single configuration point for model route, compute, context policy, prompt identity, capability exposure, and default lifecycle budgets.

The registry lives in `src/shell/core/agent-profiles.ts`.

## Why profiles exist

Different LLM jobs have different needs. A user-facing intent classifier should not inherit a coding transcript. A component worker should not receive the manager's entire history. A runtime `application.generate()` call should be tiny. Model and compute choices should therefore follow the role rather than a global model configuration.

Provider-specific request options are constructed inside the profile layer. Orchestration code asks for a profile and receives a neutral `ModelConfig`; it does not know how OpenRouter represents reasoning effort.

## Beta defaults

These are testable hypotheses, not permanent policy:

| Profile | Compute | Context policy | History |
| --- | --- | --- | --- |
| user-intent | Medium | intent-minimal | 0 |
| coding-manager | High | manager-technical | Settings history budget |
| component-worker | Low | component-scoped | capped at 4k |
| repair-worker | Medium | repair-evidence | capped at 6k |
| runtime-llm | Low | runtime-minimal | 0 |
| behavior-summary | Low | behavior-curation | 0 |

All currently use `openrouter/auto`. The important change is that this is centralized; later experiments can move one role without editing orchestration code.

## Prompt and capability policy

Every profile declares a stable `promptId` and capability exposure policy.

- `index`: role may receive the compact capability index.
- `selected`: inject detailed help only for selected capabilities.
- `none`: do not inject platform capability documentation.

The actual manager/worker prompts are introduced with the orchestration issues; profile IDs already give them a stable lookup key.

## Budgets

Profiles declare default time, idle, failure, stall, and cost fields. The runner enforces these defaults through the shared run-budget controller introduced in #87.

`maxCostUsd` remains deliberately `null` until the product establishes an evidence-based dollar ceiling. Unknown provider cost is still tracked; when a dollar cap is enabled, unknown cost stops the run rather than being treated as zero. The 1000-turn ceiling is an emergency runaway guard only, not a normal work budget.

## Observability

Every provider trace includes the resolved profile ID and role. Model options are also recorded in sanitized request metadata, so beta exports can compare High/Medium/Low behavior and cost.

## Changing defaults

Edit the registry, not call sites. Tests cover:

- role separation;
- compute mapping;
- history policy;
- runtime zero-history behavior;
- explicit lifecycle budget fields.

This keeps #88/#89 free to focus on orchestration rather than provider configuration.
