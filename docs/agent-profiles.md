# Agent profiles

Agent profiles are the single configuration point for model route, compute, context policy, prompt identity, API-documentation exposure, and default lifecycle budgets.

The registry lives in `src/shell/core/agent-profiles.ts`.

## Why profiles exist

Different LLM jobs have different needs. A user-facing intent classifier should not inherit a coding transcript. A component worker should not receive the manager's entire history. A runtime `application.ai.text()` call should be tiny. Model and compute choices should therefore follow the role rather than a global model configuration.

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

## Prompt and API-documentation policy

Every profile declares a stable `promptId` and API-documentation exposure policy.

- `index`: role may receive the compact platform API index.
- `selected`: inject detailed help only for selected API groups.
- `none`: do not inject platform API documentation.

Role-owned prompts live under `src/shell/core/prompts/`. The user-intent and coding-manager profiles receive the compact API index; component/repair workers receive only selected detailed API help. The component and repair profiles share the same console-execution prompt identity because the task/profile context, not duplicated system prose, distinguishes repair work.

## Budgets

Profiles declare default time, idle, failure, stall, and cost fields. The runner enforces these defaults through the shared run-budget controller introduced in #87.

`maxCostUsd` remains deliberately `null` until the product establishes an evidence-based dollar ceiling. Unknown provider cost is still tracked; when a dollar cap is enabled, unknown cost stops the run rather than being treated as zero. The 1000-turn ceiling is an emergency runaway guard only, not a normal work budget.

## Observability

Settings includes a **Beta details** table derived from this registry. It shows the role/profile, `openrouter/auto` routing target, compute level, context policy, history rule, and effective history tokens for the current History budget. The route and compute columns are intentionally separate so testers do not mistake Auto routing for one global compute setting.

The History budget is role-specific: coding-manager uses the Settings value directly, component-worker caps it at 4k, repair-worker caps it at 6k, and user-intent/runtime-llm/behavior-summary use zero prior technical history.

Every provider trace includes the resolved profile ID and role. Sanitized model options, full context-selection telemetry, provider token usage, and elapsed time are retained in the in-memory trace snapshot. Diagnostic export writes both the exact trace events and aggregate rollups, plus the effective profile configuration used for the session.

## Changing defaults

Edit the registry, not call sites. Tests cover:

- role separation;
- compute mapping;
- history policy;
- runtime zero-history behavior;
- explicit lifecycle budget fields.

This keeps #88/#89 free to focus on orchestration rather than provider configuration.
