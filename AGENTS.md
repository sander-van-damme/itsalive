# It's Alive V2

## Product contract — required for every change

Read [docs/PRODUCT_VISION.md](docs/PRODUCT_VISION.md) before architectural or interface decisions. User experience is a correctness requirement: a technically functioning change that violates this contract is not complete.

- **Product identity:** It's Alive is a continuously adaptive AI interface for ordinary users, not an AI code editor or development environment.
- **Application-first:** The generated application occupies the main workspace; one compact, collapsible right rail contains assistance and navigation.
- **Natural interaction:** Users express goals, questions and feedback through conversation, voice and interaction. Implementation details remain internal.
- **Explicit requests are authorization:** Create, change or repair when clearly requested, without a generic second confirmation. Clarify ambiguity and confirm destructive, expensive or high-risk actions.
- **Feedback leads to assistance:** Negative feedback continues the unresolved conversation and can lead to repair; recording telemetry alone is insufficient.
- **Do not assume intent:** Behavior is evidence, not certainty. Offer subtle, dismissible assistance; inferred needs never authorize structural changes.
- **Engineering stays behind the scenes:** Coding agents, compilation, source files and tool calls remain internal. There is no developer-tools or source-editor interface. Support logs are downloadable in Settings → Help and diagnostics.
- **Real product, not a demo:** Provide functional AI behavior or clear provider setup. Never silently substitute scripted responses. Scripted responses require the development URL ?test-provider=scripted and never appear in settings.
- **Clean, usable design:** Prioritize readable type, accessibility, useful information, restrained chrome and efficient screen space. Avoid redundant copy and navigation.
- **Enforce the experience:** Preserve executable user-outcome acceptance tests, including onboarding, goal creation, automatic changes, negative-feedback repair, dialogs, mobile state, accurate connection health, keyboard submission and AI live voice.

The product is beta. Prefer clean current contracts over V1 compatibility layers or data migrations. V1 is preserved on `archive/v1`; do not rewrite its history or merge V2 to main without the owner's instruction.

## AI capacity and resource policy

- Do not impose arbitrary limits on model input tokens, output tokens, usable context, conversation length, or source/tool content. Allow the selected model to use its actual capabilities.
- Omit `max_output_tokens` when the provider permits omission. Never substitute a small fixed allowance or reduce reasoning to fit one. Obsolete stored configuration must not reactivate a cap.
- Keep cost control separate from model capacity. Record provider-reported usage after every request, including incomplete and failed responses when usage is available. Monetary estimates and unknown usage must remain distinguishable from reported charges.
- Spending limits are optional and disabled by default. They may prevent starting additional requests once recorded spending reaches the threshold; they do not truncate requests already running or guarantee a hard financial cap.
- Preserve recoverable candidate work, the original goal, tool results and continuation state. Retry useful progress safely instead of repeating expensive successful work. Never apply an unverified candidate.
- A legitimate application-generation request must not fail solely because of an arbitrary turn or tool-call ceiling. Stop on completion, cancellation, a genuine obstacle, the spending policy, or demonstrated lack of progress.
- Retain only documented provider constraints and justified technical/security protections. Do not disguise a token budget as input validation or silently discard context.
- **A successful provider connection is not sufficient. Validate the complete real-provider creation, verification, commit, interaction and update workflow when securely supplied credentials are available. Clearly report when it remains unverified.**
- **Long-running operations must report truthful, user-relevant progress**, remain cancellable, and keep the last working application safe. Diagnostics distinguish successful tool execution from successful compilation and runtime verification.

## Boundaries

- `src/app` is only the permanent wildcard bootstrap: immutable UUID, exact parent origin/source, versioned envelope, one transferred MessagePort, execution of shell-supplied runtime. Everything else belongs to the shell build.
- `src/runtime` is shell-owned source executed in the app origin. It owns stable React/Refresh/Zustand instances, generated module execution, app-origin storage operations, observation and diagnostics. Never add private platform persistence there.
- The shell owns multi-file TS/TSX source, immutable revisions, compilation, shared dependency cache, credentials, AI policy/limits, conversations, diagnostics and backup orchestration. The DOM is generated output.
- Generated applications use ordinary browser APIs and typed `@itsalive/ai` / `@itsalive/store` modules. They receive neither provider keys nor coding tools.
- Compile and check candidates in disposable UUID origins before live application. Failed candidates keep the working revision. Do not use AI to overrule deterministic checks. Check expected revision IDs on commit.
- Verification cannot make arbitrary external network effects transactional. Backup cannot export inaccessible browser state. Keep limitations explicit and preserve per-storage reports.

## Work and validation

Use `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e`. Browser tests require `npx playwright install --with-deps chromium`. Root development origin is `http://itsalive.localhost:4173`; apps use UUID subdomains on port 4174. `npm run dev` and `npm run dev:app` serve both sites in separate terminals.

`src/shell/runtime-source.generated.ts` is generated by `npm run build:runtime` and is not committed. After changing runtime/bridge/storage code, rebuild it before browser testing. Never edit the generated bundle. Browser E2E disables Vite shell HMR; generated application hot updates remain real and tested.

Keep test-provider simulation visibly separate from external-provider tests. Normal tests use no credentials. `npm run test:live -- --live` is opt-in and requires a provider key in the environment. Never commit or print keys.

Update `docs/MILESTONES.md` and relevant architecture/acceptance docs when behavior changes. Record benchmarks with fixture, environment and scope; compilation-only timings are not full edit latency. Use concise typed modules and ordinary libraries; do not rebuild a general Node runtime or custom AI framework.
