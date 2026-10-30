# Live conversation protocol review

Reviewed against current official OpenAI documentation on 26 October 2026. The uploaded diagnostics did not record the original provider error, so the exact historical Windows failure cannot be reconstructed. The startup history schema in the reviewed source is nevertheless incompatible with the documented protocol and is a credible failure cause.

## Protocol corrections

- [WebRTC connection guide](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live): retain `POST /v1/live/sessions`, JSON session/transport configuration, `gpt-live-1`, the SDP answer, and `session.started`. Do not substitute the separate Realtime API or send `session.start` over WebRTC.
- [Session guide](https://developers.openai.com/api/docs/guides/live-conversations): startup history needs typed message objects and typed text arrays. The former `{role, content: string}` shape was wrong. Cumulative usage arrives through `session.usage.updated`; command errors identify their command through nested `error.client_event_id`.
- [Delegation guide](https://developers.openai.com/api/docs/guides/live-delegation): client delegation remains active while application work proceeds. Quiet progress uses thinking appends; verified results use commentary appends. Each append is limited to 500 tokens. UTF-8 byte chunks provide a conservative bound without discarding text or splitting Unicode characters.

## Context and lifecycle

The provider limits startup history to 128 messages and 8,192 combined tokens. The client retains a chronological prefix using a conservative serialized UTF-8 byte bound; this is explicitly logged as bytes, not measured tokens. Remaining messages retain their roles, ordering and complete text in subsequent context appends. Microphone input and playback stay muted, and the interface stays in its restoration state, until every append is acknowledged. Full backend conversation history remains intact. This is a transport constraint, not a total conversation cap. Provider acknowledgments establish delivery timing, not proof of semantic understanding.

The same acknowledgment gate loads the active app, scoped preferences and general user instructions before listening starts. Later app and preference changes update factual context without restarting the call. Voice requests to remember or forget a preference go through the conversational backend and cannot claim persistence before a confirmed result. Ambiguous goals prompt a brief, empathetic question before proposing or promising an application; questions about an actual app delegate inspection.

Startup and failure diagnostics now identify permission, media, offer, ICE, HTTP creation, answer, context restoration, listening and shutdown phases. They include HTTP status, provider request/session IDs, transport state transitions and finalization status. Debug mode additionally records assembled instructions/history, transcripts, delegated input/results and provider error fields. Credential redaction applies before evidence reaches the logger. SDP and its private network addresses are excluded from diagnostic payloads.

Failures release microphone tracks, audio, peer/channel listeners and timers before UI callbacks. Late permission grants after cancellation are stopped immediately. Device removal is recoverable through a fresh connection. Microphone mute also sends the provider control command. Spoken playback remains independently switchable. Known command failures do not terminate a healthy conversation; failed history restoration does. Closing waits for final usage before releasing transport, with an explicit fallback timeout when finalization is unavailable.

## Accounting correction

The WebRTC guide documents a 15-second initialization charge, credited against running duration. The previous review's blanket description of that minimum as fabricated was incorrect. The implementation bug applied it after any attempted HTTP request, including rejected creation, and used it as elapsed latency. Creation rejection now records no initialization charge; ambiguous network/5xx outcomes remain unknown. Successful creation can have a 15-second estimate even if SDP negotiation subsequently fails. Measured elapsed time, provider duration, estimated cost and confirmed final usage are separate evidence.

## Verification boundary

Protocol and lifecycle tests cover typed startup messages, rejected and ambiguous creation, malformed accepted responses, exact error correlation, usage events, complete chunked results, 128/129-message and oversized-history preservation, acknowledgment-gated readiness, cleanup, retry and debug redaction. Browser acceptance tests use simulated media and provider responses. Real OpenAI access, physical microphones, Windows privacy controls, incognito permission behavior and audible quality require a real device/provider session; they have not been claimed as verified here.
