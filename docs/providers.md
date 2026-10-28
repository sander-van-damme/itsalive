# OpenAI, account access and live voice

The shell owns AI policy, credentials, usage, conversation and the bounded application-editing harness. Generated applications receive only `text`, `decide`, `choose` and `score` through the authenticated app bridge. They cannot choose provider endpoints, credentials, privileged roles or file-editing tools.

## Connections and models

First run is disconnected. A dedicated setup dialog preserves the pending request and checks structured output and function-call support for every distinct text model/reasoning/speed combination. A failed setup retains the draft and existing working configuration. Successful validation is reused only for the exact connection configuration and credentials, compared privately in memory. Debug, usage and interface preferences do not require connection probes. Healthy connections have no persistent badge; unchecked or failed connections remain actionable. Success is historical, not a promise of continuous availability.

Only OpenAI API-key and eligible ChatGPT-plan access are offered. OpenRouter has been removed. Compatible-looking APIs are not assumed to implement Responses tools, reasoning, service tiers, OAuth or live voice identically. Future providers need explicit capability tests, not merely a URL substitution.

| User category | Default                       | Internal use                                   |
| ------------- | ----------------------------- | ---------------------------------------------- |
| Low           | GPT-6 Luna, low reasoning     | Small decisions and simple edits               |
| Medium        | GPT-6.1 Sol, medium reasoning | Conversation, normal edits, generated-app AI   |
| High          | GPT-6.1 Sol, high reasoning   | Complex work and reasoning                     |
| Live voice    | GPT-Live 1                    | Full-duplex conversation and client delegation |

GPT-6 Astra is an optional text-model choice. ChatGPT-plan choices come from the signed-in account's catalog, retaining server display names and order. Routing has four configurable categories without an enable/disable switch; internal roles remain implementation details. Ordinary chat has no Think deeper button.

Standard/Faster/Fastest changes service priority without reducing reasoning quality. Requests use `default`, `priority` (Fast alias) or `ultrafast`. Fastest uses Fast on models without Ultrafast support. Listed API estimates are $0.10/$0.50 per million input/output tokens for Luna, $2/$10 for Sol and $10/$50 for Astra; Fast is 2× and Ultrafast 6×. Actual served tiers are used when returned. Account availability still applies; changing speed runs connection checks rather than silently downgrading a failed request.

## API-key transport

Browser requests go to same-origin `/api/ai/responses`, forwarded to `https://api.openai.com/v1/responses` using the caller's key. The Vite development middleware and Cloudflare root Worker implement this boundary. There is no shared server key, custom endpoint input or provider-key exposure to app origins. Keys are retained in shell browser storage and excluded from backups. The server forwards them transiently and does not store or log them.

Responses requests use developer messages, JSON-schema output, function tools and `store:false, stream:true`. They omit `max_output_tokens` and disable silent provider truncation. Old V3 output allowances are removed when configuration is loaded. Read SSE through a terminal event; distinguish completion, incomplete output, failures, cancellation and transport interruption. Preserve model output items, including encrypted reasoning and tool namespaces, across stateless tool rounds. Only complete, parsed tool operations can execute. Completed assistant output is displayed after validation; token-by-token text rendering is not implemented.

There are no application token budgets, serialized-request size ceilings, fixed conversation windows or source/tool content truncation. Provider generation has no universal application timeout. A genuine context-capacity error can trigger explicit reconstruction of the coding context from the full current candidate, original goal and operation receipts, while retaining the old continuation in the private checkpoint. If the required source still cannot fit, preserve the draft and report the provider obstacle; never silently discard source to fit an invented allowance.

## Bounded decisions

OpenAI Luna `decide`, `choose` and `score` use the dedicated same-origin `/api/ai/decisions` proxy to `POST /v1/decisions`. Validate question identity, supported types, probabilities, option membership and score distributions. The detailed service API preserves probabilities/confidence; the existing application primitive API returns a Boolean, option or numeric score. These judgments never authorize structural platform changes. Arbitrary JSON generation, conversational intent and free-form behavior suggestions continue through Responses.

The documented Decisions schema permits 1–400 questions, 2–255 choices and 2–10 scoring levels. These are actual provider requirements. Other configured models or larger application choice/score sets use structured Responses. Do not retry a failed Decisions request through Responses automatically: this could conceal an access problem or duplicate billing. Decisions uses its separate input-only pricing and does not accept Responses' output, reasoning or service-tier parameters.

## ChatGPT plan connection

Choose **ChatGPT plan → Continue with ChatGPT**. The hosted flow uses a registered public OAuth client, PKCE/state/nonce, an exact `/auth/chatgpt/callback` and signed OIDC identity validation. Tokens persist in the user's browser, outside backups. The same-origin `/api/chatgpt` boundary exchanges/refreshes tokens and forwards plan requests without storing account credentials. Set the public deployment variable `CHATGPT_CLIENT_ID` to the provider-issued client; it must be registered for the exact hosted callback and separately granted ChatGPT allowance use. No client secret is used. See [the research and provisioning checklist](AUTH_RESEARCH.md).

Local installations can continue running `npm run connection`. That helper listens only on `127.0.0.1:1456`, uses the documented loopback registration, PKCE S256, one-use state, nonce and signed OIDC identity checks. It requires the granted `chatgpt.tokens.use.direct` scope before inference. Issued client IDs are retained with the verified account. Tokens and rotating refresh credentials are atomically stored in ignored `.itsalive-local/chatgpt.json` (directory `0700`, file `0600` on Unix). Never copy that directory into a release or support bundle. One account registration is supported per local helper directory.

Browser/helper calls require an allowed Origin and per-process session header. In this legacy local-helper mode only, browser storage receives no OAuth token. Hosted browser credentials use a separate `itsalive.chatgpt.*` store. Both modes discover `/v1/models` and use public `/v1/responses` with namespaced tools, full input history, `store:false`, streaming, and no unsupported output cap or `truncation` parameter. Hosted sign-out immediately clears browser credentials and attempts provider revocation; an outstanding refresh cannot restore the signed-out session.

Plan usage is separate from API spending and never silently falls back to a billable API key. Identity-only sign-in does not unlock plan inference. Live voice requires a separately disclosed API key. Hosted ChatGPT remains selectable and reports missing registration only when selected; the obsolete `VITE_CHATGPT_PLAN_ENABLED` gate is removed. Public documentation does not provide a registration-free hosted equivalent of the local dynamic-client flow or permission to borrow Codex's first-party device-login client identity. Production allowance access still requires provider provisioning and live verification; browser credential persistence is implemented.

## Spending and scheduling

The optional monthly API spending limit starts disabled. Record a pending request with unknown cost, then settle from actual provider usage, including usage returned with incomplete or failed responses. Reported token counts are distinct from monetary estimates computed using model pricing, cache read/write prices and the served tier. A provider-reported charge remains distinct from an estimate. Missing usage stays unknown rather than a precise zero charge. There are no output reservations or invented future token estimates. UTC month boundaries apply to this browser's ledger. ChatGPT-plan usage is separate from API spending.

Voice records measured wall time, observed session duration, provider-reported duration and estimated billable duration separately. The documented 15-second initialization charge applies only after successful session creation, including a subsequent connection failure; it never becomes a fabricated 15-second latency. A rejected or never-attempted creation is not billed, while an ambiguous transport/server failure remains unknown. Created-session costs use the documented $0.05/minute rate and remain monetary estimates even when duration is reported by the provider. Final outcomes and failure phases are retained.

Before each billable request starts, compare completed recorded spending with the enabled threshold. A request may cross it; already running concurrent requests may add more. Do not abort or truncate a response to enforce a token allowance. Unknown charges are displayed separately and cannot be counted as known spending.

For text requests, await the pending ledger write before sending a billable request, and await settlement before returning its result. Storage failures pause new work and retain the reported usage in memory for a persistence retry; a reload after lost settlement retains the durable unknown-cost marker. Voice writes remain asynchronous to the media lifecycle, are ordered per session, and expose failed settlements for retry. Merge individual request records atomically so concurrent tabs cannot overwrite each other's charges. `flushUsage()` waits for queued writes, retries known failures and explicitly returns any unsaved records for the export rather than presenting them as durable. In-memory tab totals can still lag other tabs, and this is not an account-wide hard cap.

Normal bursts queue rather than failing at two concurrent requests. Internal scheduling allows eight active calls, at most 30 starts/second, a corresponding 1,800/minute pacing rate, and 128 waiting calls to protect against generated-app request floods. Queueing does not impose a model deadline. Conversation has priority over queued background work. Coding has no fixed turn/tool ceiling: repeated identical operations against the same source provide evidence of a non-progressing loop. Concurrent app edits queue and recheck the target app before execution. These settings have no user-facing rate controls.

The ledger is a browser estimate, not an account-wide financial guarantee: parallel tabs, cleared storage, unknown usage, provider prices and external calls can differ. Use provider-side controls for a hard account boundary. Do not report uncertain spending as free.

## Voice and suggestions

Voice uses `/api/voice/sessions` to start GPT-Live 1 with WebRTC and `delegation.type:client`. It sends microphone audio over the negotiated peer connection and receives live transcripts/events on `oai-events`. No browser-vendor transcription fallback exists.

Client delegations use accumulated user transcripts and enter the same intent, authorization and compile/verify/commit workflow as typed input. The live conversation remains available during work. Results return through `session.commentary.append`, never invented from task-start status. A second requested edit waits for the previous edit. Destructive changes still require their specific confirmation.

**Spoken replies** controls actual playback muting; captions remain visible. Muting does not stop audio generation or billing. **Mute microphone** suspends audio input; **End conversation** requests graceful close, waits for final usage with a bounded timeout and releases media. Unconfirmed usage remains estimated. Startup history and delegated transcript context are preserved without arbitrary clipping; raw microphone recordings are not stored. The implementation does not add cross-reload persistence of every live transcript fragment.

## Draft recovery and remaining technical bounds

Private IndexedDB checkpoints retain the original goal, candidate source, base revision, continuation, operation receipts and pending tool cursor. They survive reload and are included in portable backups with their candidate dependencies. Diagnostic export does not automatically attach every checkpoint, but explicit debug request/tool records can contain the same candidate content. Save each operation's source and receipt together. Explicit retries resume only against the same base revision; successful commits invalidate the checkpoint atomically. Recheck candidates after reload, and require an explicit completion declaration plus deterministic compilation/runtime verification before commit. An unchanged verified artifact may be reused within one run; a passed compile alone never commits a candidate.

Recovery preserves completed operations from supported incomplete responses without executing truncated arguments. Call IDs prevent replaying successful non-idempotent patches. Repeated incomplete responses without progress pause visibly instead of looping. Transport interruption and cancellation preserve the last durable operation; they do not pretend unreceived output or usage is known.

Security and actual implementation constraints remain separate from model capacity: canonical relative paths, fixed-origin authentication, bridge request saturation, dependency integrity/exact versions, the bootstrap runtime-envelope bound, dependency-download memory bounds and the in-memory backup limit. Compilation workers and browser handshake/media setup retain technical timeouts. These protect browser execution and storage; they are not token controls on model input or output.

Helpful suggestions are ordinary conversational behavior. They are dismissible and do not authorize unsolicited changes. Removing the old preference does not enable passive tracking: repeated-click observation remains disabled in ordinary use, with its internal adapter covered by regression tests.

## Diagnostics and validation

Settings → Help and diagnostics has one Debug logging switch and Download diagnostic logs. Both work without AI. Ordinary logs contain operation context, timing, routing and accounting metadata; assembled prompts, model output and tool content require explicit debug capture. With debug enabled, retain full assembled messages/instructions, tool definitions and arguments/results, structured model output and available verification/failure evidence. Preserve exception name, message, stack, cause and custom fields. There are no silent per-field or array-length caps. API keys, OAuth token fields, Bearer credentials and known credential values are removed in both modes. Raw microphone recordings are not stored.

Operation correlation IDs, internal accounting request IDs, provider response IDs and provider HTTP request IDs are separate fields. Per-session sequence numbers preserve order when events share a millisecond. New events declare severity independently from INFO/DEBUG collection level. Exports flush queued diagnostic/usage writes and snapshot persisted records; metadata declares capture modes (including retained records from earlier debug sessions), retention limits, dropped-event counts, time coverage and persistence failures. Completeness and historical pruning remain explicitly unknown for legacy records without that metadata. The diagnostic ring retains 2,000 events; the usage ledger is not clipped to that ring or to a settings-export limit. Disabling debug changes future collection, not previously stored records.

Deterministic tests exercise actual routing and application tooling using HTTP/media fixtures. They establish protocol and workflow behavior, not model quality, eligibility, microphone performance, actual latency or billed cost. No real provider credentials were available during this implementation.

`tests/ai-debug-evidence.test.ts` and `tests/diagnostics.test.ts` cover full-content opt-in versus ordinary metadata, credential redaction, structured failures, independent local/provider identities, export flushing and failed settlement evidence. Voice accounting fixtures distinguish rejected, unknown and created sessions and assert that initialization estimates never overwrite measured wall time.

For the opt-in real-provider browser journey, set `OPENAI_API_KEY` securely and run `npm run test:live -- --live --provider=openai`. It checks the actual connection, requests a small violin practice app through the normal interface, runs the real coding/compile/verify/commit pipeline, exercises durable practice state, requests a reset feature, verifies the update and reloads. There are no output-token ceilings or default spending caps. Optional `--budget=<USD>` prevents subsequent requests after recorded spending reaches the threshold; it cannot cap in-flight charges. Timings, reported usage and accounting states are written to `work/live-provider-results.json` after success. Credential input is not traced, filmed or screenshotted. Never pass keys on the command line. This does not validate a physical microphone or ChatGPT-plan sign-in.

`node scripts/benchmark-decisions.mjs --live --samples=3` compares the real Decisions and structured Responses endpoints on the same bounded judgment, alternating their order and recording actual usage and latency. Without a securely supplied key it explicitly skips. Deterministic fixtures cannot establish a Decisions speed or cost advantage.

## References

Responses, Decisions and pricing were checked again on 2026-10-25. Account and voice references below were originally checked during the 2026-10-22 implementation.

- [Responses function calling](https://developers.openai.com/api/docs/guides/function-calling) and [reasoning continuation](https://developers.openai.com/api/docs/guides/reasoning)
- [Decisions guide](https://developers.openai.com/api/docs/guides/decisions) and [create reference](https://developers.openai.com/api/reference/resources/decisions/methods/create)
- [TypeSafe's System One and Jev reference](https://typesafe.ai/blog/introducing-system-one-models-and-jev): typed probabilistic judgments informed the separation of decisions from generation; no additional provider or account is required.
- [Pricing](https://developers.openai.com/api/docs/pricing), [Fast mode](https://developers.openai.com/api/docs/guides/fast-mode) and [Ultrafast mode](https://developers.openai.com/api/docs/guides/ultrafast-mode)
- [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source), [sign-in protocol](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) and [session lifecycle](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [Live conversations](https://developers.openai.com/api/docs/guides/live-conversations) and [client delegation](https://developers.openai.com/api/docs/guides/live-delegation)
