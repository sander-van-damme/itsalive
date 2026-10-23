# OpenAI, account access and live voice

The shell owns AI policy, credentials, usage, conversation and the bounded application-editing harness. Generated applications receive only `text`, `decide`, `choose` and `score` through the authenticated app bridge. They cannot choose provider endpoints, credentials, privileged roles or file-editing tools.

## Connections and models

First run is disconnected. Setup preserves the pending request and checks structured output and function-call support for every distinct text model/reasoning/speed combination. A failed setup retains the draft and existing working configuration. The badge distinguishes unchecked, checking, ready and failed connections; having a key alone never establishes readiness. Success is historical, not a promise of continuous availability.

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

Responses requests use developer messages, JSON-schema output, function tools and `store:false, stream:true`. Read SSE through `response.completed`; late failures, incomplete responses and interrupted streams are errors. Preserve model output items, including encrypted reasoning and tool namespaces, across stateless tool rounds. Completed assistant output is displayed after validation; token-by-token text rendering is not implemented.

## ChatGPT plan connection

Run `npm run connection` locally and choose **ChatGPT plan → Continue with ChatGPT**. This is OpenAI's documented plan-sharing flow, including eligible allowance shared with Codex, rather than GitHub OAuth or access to private ChatGPT endpoints.

The helper listens only on `127.0.0.1:1456`, uses an exact loopback callback, PKCE S256, one-use state, nonce and signed OIDC identity checks. It requires the granted `chatgpt.tokens.use.direct` scope before inference. Issued client IDs are retained with the verified account. Tokens and rotating refresh credentials are atomically stored in ignored `.itsalive-local/chatgpt.json` (directory `0700`, file `0600` on Unix). Never copy that directory into a release or support bundle. One account registration is supported per local helper directory.

Browser/helper calls require an allowed Origin and per-process session header. Browser storage receives no OAuth token. Model discovery uses `/v1/models`; inference uses public `/v1/responses` with namespaced tools, full input history and no unsupported `max_output_tokens`. Sign-out attempts token revocation, clears local tokens and reports unconfirmed remote revocation. The account identity remains registered for reconnecting.

Plan usage is separate from API spending and never silently falls back to a billable API key. Live voice requires a separate API key. OpenAI currently documents this access for eligible local open-source/personal tools; paid or remotely hosted offerings require access from OpenAI. This repository includes the local integration, not hosted registration or access approval. The hosted account option remains disabled until an approved installation builds with `VITE_CHATGPT_PLAN_ENABLED=1`. Model access, browser local-network permissions and eligibility need a real-account check.

## Spending and scheduling

The optional monthly API spending limit starts disabled. When enabled, estimate/reserve cost before requests and settle from returned usage. UTC month boundaries apply to this browser's ledger. Cached-token discounts are not assumed. Failed or interrupted requests retain conservative reservations because billing is uncertain. ChatGPT-plan tokens are recorded separately at zero API cost. Voice reserves its 15-second initialization minimum, tracks elapsed usage and settles graceful-close usage at the listed $0.05/minute rate.

Normal bursts queue rather than failing at two concurrent requests. Internal safeguards allow eight active calls, at most 30 starts/second, a corresponding 1,800/minute ceiling, 128 waiting calls and a two-minute queue timeout. Conversation has priority over queued background work. Coding remains bounded at 12 turns/36 calls; concurrent app edits queue and recheck the target app before execution. These settings have no user-facing rate controls.

The ledger is a browser estimate, not an account-wide financial guarantee: parallel tabs, cleared storage, unknown usage, provider prices and external calls can differ. Use provider-side controls for a hard account boundary. Do not report uncertain spending as free.

## Voice and suggestions

Voice uses `/api/voice/sessions` to start GPT-Live 1 with WebRTC and `delegation.type:client`. It sends microphone audio over the negotiated peer connection and receives live transcripts/events on `oai-events`. No browser-vendor transcription fallback exists.

Client delegations use accumulated user transcripts and enter the same intent, authorization and compile/verify/commit workflow as typed input. The live conversation remains available during work. Results return through `session.commentary.append`, never invented from task-start status. A second requested edit waits for the previous edit. Destructive changes still require their specific confirmation.

**Spoken replies** controls actual playback muting; captions remain visible. Muting does not stop audio generation or billing. **Mute microphone** suspends audio input; **End conversation** requests graceful close, waits for final usage with a bounded timeout and releases media. Unconfirmed usage remains estimated. Startup history is bounded; raw microphone recordings are not stored. The implementation does not add cross-reload persistence of every live transcript fragment.

Helpful suggestions are ordinary conversational behavior. They are dismissible and do not authorize unsolicited changes. Removing the old preference does not enable passive tracking: repeated-click observation remains disabled in ordinary use, with its internal adapter covered by regression tests.

## Diagnostics and validation

Settings → Help and diagnostics has one Debug logging switch and Download diagnostic logs. Both work without AI. Logs include correlation/request identity, app/version context, connection errors, token estimates, latency and selected models; keys are redacted and AI prompts/replies are excluded by default. Logs can contain app details and runtime errors. Exports include browser/app versions, health and usage. Enabling debug does not add full prompts or model reasoning.

Deterministic tests exercise actual routing and application tooling using HTTP/media fixtures. They establish protocol and workflow behavior, not model quality, eligibility, microphone performance, actual latency or billed cost. No real provider credentials were available during this implementation.

For an explicitly authorized live text probe, set `OPENAI_API_KEY` securely and run `npm run test:live -- --live --provider=openai`. It checks text, structured decisions and an inert function tool using Luna, sends at most three requests and defaults to a $0.01 estimated cap (maximum allowed $0.10). Never pass keys on the command line. This is separate from live voice or account sign-in validation.

## Official references checked on 2026-10-22

- [Responses function calling](https://developers.openai.com/api/docs/guides/function-calling) and [reasoning continuation](https://developers.openai.com/api/docs/guides/reasoning)
- [Pricing](https://developers.openai.com/api/docs/pricing), [Fast mode](https://developers.openai.com/api/docs/guides/fast-mode) and [Ultrafast mode](https://developers.openai.com/api/docs/guides/ultrafast-mode)
- [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source), [sign-in protocol](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) and [session lifecycle](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [Live conversations](https://developers.openai.com/api/docs/guides/live-conversations) and [client delegation](https://developers.openai.com/api/docs/guides/live-delegation)
