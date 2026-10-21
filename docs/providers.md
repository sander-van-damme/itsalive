# AI orchestration and provider boundaries

The shell owns `AIService`, credentials, model routes, accounting and the coding harness. Generated application code receives only `text`, `decide`, `choose` and `score` functions over its authenticated app bridge. App requests cannot choose a role, URL, provider, API key or coding tool. Model output and tool arguments are untrusted input.

`demo` is the initial provider. It is a deterministic demonstration, clearly labeled in the UI, with heading edits and task-list creation. It still runs the actual file tools, compiler, isolated verification, revision commit and runtime. It is not evidence of external model quality. `ScriptedProvider` supplies precise tool calls/errors for deterministic repair, authorization and limit tests.

## External providers

OpenAI uses `https://api.openai.com/v1/chat/completions`; OpenRouter uses `https://openrouter.ai/api/v1/chat/completions`. Both adapters support text, non-streaming function tools and strict JSON-schema outputs. The OpenRouter adapter additionally requires parameter-capable upstream providers and requests usage accounting. Provider credentials are added directly to the shell's fixed-endpoint fetch request and are never serialized into app configuration or tool messages. Raw error bodies are deliberately omitted because they can echo sensitive data.

The small registry describes known API/capability combinations and includes `gpt-4.1-mini` and its OpenRouter model ID. Users can choose another model, but it must support the configured tools/structured output. A name alone is not evidence of compatibility. These are generic structured-output decisions, not an invented specialized OpenAI decision endpoint. There is no claim that all provider/model combinations implement the same capabilities. Non-streaming responses make candidate source edits atomic; streaming dialogue remains future work.

API references checked during implementation on 2026-10-21:

- [OpenAI create chat completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create): tools, `max_completion_tokens`, structured outputs and parallel tool control.
- [OpenRouter parameters](https://openrouter.ai/docs/api/reference/parameters): completion limits, structured outputs and parallel tool calls.
- [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection): `require_parameters`.
- [OpenRouter API overview](https://openrouter.ai/docs/api/reference/overview): messages, function tools and response shape.

No live provider credential was supplied. HTTP behavior is verified through fetch mocks; provider authorization, current account access, actual latency, cost and response quality have not been live-tested.

## Accounting and limits

All roles share a shell-level requests-per-minute limit, concurrent-request limit and USD budget. Usage records distinguish conversation, deeper reasoning, behavioral decisions, three coding capabilities and generated-app AI. Settings include a speech role for configuration, but the implemented speech path uses browser recognition, described below.

A request reserves its worst-case configured cost _before_ contacting the provider. UTF-8 input bytes plus framing provide a conservative token allowance; output tokens are capped. External models require explicit nonzero input/output prices. Completed requests use provider cost when reported; otherwise token counts times configured prices are marked estimated. Cached input tokens are reported but do not get an assumed discount. Failed/aborted requests retain a conservative reservation because the provider may still bill them. The ledger contains pending records before the request, can be persisted by the shell, and is restored on reload. Unknown usage stays reserved rather than being reported as free.

These are useful client-side controls, not a provider-enforced financial guarantee. Prices may be outdated, token accounting can differ, parallel browser tabs do not share an atomic server quota, and a user can clear or modify browser storage. Set provider-side spending limits for a hard account boundary. A server credential proxy is outside this implementation. Ledger persistence failure is reported in diagnostics; retained in-memory accounting remains in force.

## Coding workflow

The conversation agent can propose a technical change request, but the shell requires the user's Apply action before invoking coding. Accepted behavior suggestions follow the same path. No behavior signal invokes a coding tool by itself.

`CodingHarness` receives an immutable project snapshot and base revision. Its bounded tools are `list_files`, `read_files`, `write_file`, `patch_file`, `delete_file`, `set_dependency`, `check`, `inspect`, and `finish`. The tool prompt includes a path list instead of all source. Reads are scoped, patches require one exact match, dependencies require exact versions, and path traversal is rejected. At most 12 model turns and 36 tools run per request. Tool errors and compile/isolated-render diagnostics go back to the model for repair. Ordinary app code has no access to these tools.

A finish request cannot override failed deterministic checks. The shell compiles and verifies any changed candidate, preserves its dependency lock, and commits using the expected base revision. A stale revision conflict, exhausted repair budget or cancellation leaves the working revision intact. Verification is technical evidence, not proof that a requested feature is useful; the product collects separate user feedback after adaptation.

## Behavior, privacy and speech

Runtime observation is opt-in. `BehaviorAdvisor` filters for repeated-click summaries, invokes at most one decision per app per minute, and allows only one outstanding suggestion per app. Explanations are tentative, suggestions are dismissible, and dismissed/ignored suggestions never become coding authorization. Raw pointer streams, keystrokes, audio and camera data are not sent by this feature.

Diagnostics record provider, role, request identity, latency, token usage and cost without raw message content by default. Content capture requires explicit configuration and runs through key/credential redaction. Redaction is best effort: arbitrary user text can contain unidentified sensitive data, so exported diagnostic privacy still matters.

Speech input uses the browser's `SpeechRecognition`/`webkitSpeechRecognition` after an explicit microphone action. Recognition may use the browser vendor's remote service; browser support and microphone permission vary. Final text populates the composer and does not automatically authorize a source change. Unsupported browsers retain typed input. The code does not currently send recorded audio to OpenAI or OpenRouter; the speech provider route is not an implemented external-transcription claim. This browser path is deterministic-adapter-tested but real microphone recognition requires a supported interactive browser.

## Optional live smoke test

`node scripts/live-provider.mjs --live --provider=openai` uses `OPENAI_API_KEY`; `--provider=openrouter` uses `OPENROUTER_API_KEY`. Supply keys through a secure environment, never CLI arguments. The test bundles and invokes the actual application adapters, checks text, structured decisions and one inert function-tool response, sends at most three requests with a 96-token output cap each, and defaults to a USD 0.01 estimated budget. No normal test invokes it. Running without `--live` or a key fails before any request. Only metadata and aggregate accounting are printed.

Optional `--model=...`, `--input-price=...`, `--output-price=...`, and `--budget=...` adjust the model and its current pricing. Defaults describe GPT-4.1 mini; verify current prices for your account. The CLI rejects budgets above USD 0.10. Client estimates and aborted requests remain subject to the accounting limitations above. A provider-side spend cap is still required for a hard guarantee. This path was verified to refuse unapproved/missing-key execution; no credential-backed run was performed.

The exported `reason()` helper uses the independently configured deeper-reasoning role only when the user asks for it. It has no tools or coding authority, so ordinary chat remains available while that independent request runs. Its output is advice; applying an idea still uses the explicit coding workflow.
