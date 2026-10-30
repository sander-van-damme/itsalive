# Product vision and acceptance contract

It's Alive is an intelligent, continuously adaptive interface that helps ordinary people achieve their goals. The application is the product; the coding system is internal machinery. A person learning violin should practice with a useful learning tool, ask questions and refine it without knowing React, source files, compilation or revisions.

## The workspace

The running application fills most of the viewport beside a compact, collapsible left rail. The rail combines app switching, creation, conversation, voice, progress and settings. When collapsed, app switching, conversation, live voice, history, settings, spending and response speed remain accessible as compact controls. There is no permanent third navigation column. On small screens, App and Assistant views share the same mounted application, preserving activity when switching. Use restrained neutral colors, readable typography, visible focus and compact familiar controls. First arrival is a focused full-screen goal invitation with a few editable examples; the regular chat rail appears after starting. Empty states provide one useful next action without filler slogans. The shell supports system, light and dark appearance.

Source inspection and editing have no user-facing interface. One three-dot menu contains Settings and Version history. Settings contains full-workspace backup and restore, clearly separate from current-app version recovery, and downloadable diagnostic logs. Preserve browser compilation, isolated immutable app origins, safe candidate checks, hot updates, durable storage, provider accounting and backup boundaries.

## Starting with a goal

A user can describe a goal through text or voice. Without a configured provider, explain that AI needs a connection, offer an OpenAI API key or eligible ChatGPT-plan access with compatible model defaults, test the connection and preserve the pending request. Resume it after successful setup. Do not create a generic counter and call the goal complete. A new app's internal starting document is only a temporary starting point for generation.

First-run setup is distinct from general Settings: a connection step, followed by an optional spending limit with a visible step indicator. Advanced model choices stay in Settings; response speed is always available in the workspace. Explain unavailable account options. Reuse successful validation for the exact unchanged connection configuration. Independent preferences must save promptly during generation. Preserve an explicit application name; otherwise obtain a concise name in the existing planning exchange. Enter submits creation and chat, Shift+Enter inserts a line, and composition never submits early.

Scripted providers require the explicit development URL ?test-provider=scripted and are labeled wherever active. They have no settings control. Never fall back to them after a missing key or provider failure. Voice uses OpenAI live AI over WebRTC, with visible transcripts and an option to mute spoken replies. Native browser speech recognition is not used. Voice requires an OpenAI API key, independently of ChatGPT-plan access for application work. Keep the conversation going during delegated work and show permission, connection and retry states.

## AI roles and authorization

The conversational companion understands goals, answers questions and requests clarification. It produces structured intents for private coding workers when a user explicitly asks to create, change or repair. Such requests already authorize ordinary work; no generic Apply change step follows. Questions such as “Why is this chord difficult?” remain conversation. Authorization does not establish understanding. Ambiguous problem statements get one useful discovery question before selecting a solution; concrete requests such as a stopwatch proceed directly. When alternatives matter, offer concise choices while retaining free text. Supply actual app inspection and source evidence for questions about current behavior. Resolve explicit references to other apps using their saved source, not generic assumptions. Destructive, expensive or high-risk changes require specific confirmation describing their consequences.

Coding workers inspect the current project, make bounded changes, compile, verify candidates and commit safe results. Show goal-oriented progress such as “Creating your app…”, “Checking the changes…” and “Ready to try.” Keep tool output and technical failure details in diagnostics. Do not claim tests, features or successful changes before verification. Preserve relevant durable data and compatible running state during updates; retain the last working application on failure.

Selected models may use their actual input, output and reasoning capabilities. Do not impose arbitrary token, context, turn or tool-call ceilings. Preserve unfinished candidate work durably and resume safely after interruption. A successful check is evidence of technical validity, not evidence that the user's goal is complete. Progress comes from real activity, supports reduced motion, and includes cancellation. Semantic updates explain findings and results in ordinary language. Work overlays only cover stable element identities from a current inspection and clear on completion, failure, cancellation or revision changes. Creation shows the app name and restrained activity rather than repeating the goal. Report genuine provider limitations accurately without blaming a reasonable request for an internal cap.

## Feedback and adaptation

Feedback attaches to the app, original request and resulting version. A compact dismissible prompt may ask whether a successfully applied meaningful change helped. Supersede prior prompts when a new attempt begins, and never offer success feedback for a failed or cancelled attempt. Positive feedback is recorded quietly. “Not yet” continues the unresolved conversation: ask what is still wrong unless deterministic evidence already explains it. Vague dissatisfaction alone must not trigger rewriting. A specific correction requested in that conversation automatically enters investigation and repair, then verification and a fresh opportunity to assess the result. Never end negative feedback with only “feedback saved.” Do not repeatedly prompt about an unresolved attempt.

Occasional helpful suggestions are normal conversational behavior, with no preference switch. Suggestions are subtle, dismissible and never block chat or application use. Ignoring or dismissing a suggestion causes no structural edits; acceptance authorizes that suggested change. Removing a suggestions preference does not authorize new behavioral tracking. Passive repeated-click observation remains off for normal users; its internal adapter is retained for regression tests.

## Settings, recovery and accessibility

Primary settings connect AI with sensible defaults. AI choices always has four categories: Low, Medium, High and Live voice. The system selects reasoning automatically; chat has no Think deeper control. Response speed uses Standard, Faster and Fastest, with a short cost explanation. A monthly API spending limit is optional and off by default. Concurrency and runaway-request safeguards are internal. Debug logging is one explicit switch, independent of AI connection validation; it captures complete sanitized request, response, tool and failure evidence. Credentials remain excluded. Logs can be downloaded even while disconnected, with snapshot, retention and build identity metadata. Connection changes test structured replies and function calls for configured text models before saving. Errors explain how to recover and preserve entered data. Cancel and Escape discard unsaved settings. Every dialog has a visible top-right close button, a programmatic name, initial focus, contained keyboard focus, Escape dismissal and focus restoration. Long dialogs fit small screens with accessible actions.

Cost accounting uses reported usage after requests, including failure usage. Token counts, estimated monetary charges and unknown costs are distinct. An enabled spending limit stops new billable work after recorded spending reaches it; in-flight or concurrent work can exceed it. Healthy connections need no persistent success badge; connection problems remain visible and actionable.

Enter sends a message, Shift+Enter inserts a line, and IME composition never submits early. Controls must be keyboard operable and have understandable accessible names. Use visible focus, adequate contrast, sufficiently large targets and status announcements. Generated interfaces inherit these requirements: readable type, no invented brand/logo unless requested, no filler slogans, no duplicated labels without purpose, and complete keyboard behavior for dialogs. Useful instruction must survive copy cleanup. Maintain readable reflow without horizontal page scrolling. Avoid repeated live announcements or forcing focus during background updates.

## Success criteria

Executable browser tests must cover clean first-run setup and request resumption; meaningful goal-specific generation through the actual conversation → intent → coding → compilation → app pipeline; explicit modifications without redundant confirmation; ordinary conversation without coding; app-state preservation; negative-feedback clarification and another repair; ignored/dismissed/accepted suggestions; provider errors; dialog keyboard and Save/Cancel behavior; simulated live-voice delegation, silent replies and permission failures; and desktop/mobile layout with no developer controls.

Use deterministic providers for reproducible tests, clearly distinguishing them from real provider verification. Review real browser screenshots and interact with useful generated functionality. Keep compilation, runtime, origin security, persistence and backup regression coverage. Building successfully alone does not establish product correctness.

## Design references

Apply these references concretely in implementation and testing:

- [Nielsen Norman Group usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/): visible status, familiar language, user control, error prevention and recovery, minimal necessary information.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/): keyboard access, focus visibility, contrast, reflow, target sizing and status messages.
- [WAI-ARIA modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/): named dialogs, initial focus, contained Tab navigation, Escape and focus return.
- [Nielsen Norman Group progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/): reveal specialized settings only when requested, keeping the initial task simple.
- [Google People + AI Guidebook: Feedback + Controls](https://pair.withgoogle.com/guidebook/chapters/feedback-and-controls/): support immediate correction and steering, make proactive assistance easy to dismiss, and match automation to user expectations and stakes.

## User preferences

General instructions, explicit remembered preferences and tentative suggestions are separate. Users can inspect, edit, accept, remove or disable remembered preferences. Track provenance and app/all-app scope; update by topic rather than accumulating contradictory copies. A bounded readable memory list does not cap model input, source, conversation, output or reasoning. The companion receives relevant memory; coding tasks receive the preferences relevant to their goal. Never infer permission for structural changes from remembered behavior.
