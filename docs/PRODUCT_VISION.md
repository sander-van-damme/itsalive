# Product vision and acceptance contract

It's Alive is an intelligent, continuously adaptive interface that helps ordinary people achieve their goals. The application is the product; the coding system is internal machinery. A person learning violin should practice with a useful learning tool, ask questions and refine it without knowing React, source files, compilation or revisions.

## The workspace

The running application fills the left and most of the viewport. A compact, collapsible right rail combines app switching, creation, conversation, voice, progress and settings. There is no permanent third navigation column. On small screens, App and Assistant views share the same mounted application, preserving activity when switching. Use restrained neutral colors, readable typography, visible focus and compact familiar controls. Empty states provide one useful next action, not a marketing page.

Source inspection, editing and detailed diagnostics belong behind an explicit Developer tools control. Ordinary recovery is expressed as Undo change or Restore previous version. Preserve browser compilation, isolated immutable app origins, safe candidate checks, hot updates, durable storage, provider accounting and backup boundaries.

## Starting with a goal

A user can describe a goal through text or voice. Without a configured provider, explain that AI needs a connection, offer OpenAI or OpenRouter with compatible model defaults, test the connection and preserve the pending request. Resume it after successful setup. Do not create a generic counter and call the goal complete. A new app's internal starting document is only a temporary starting point for generation.

Scripted providers are explicit development/test choices, clearly labeled wherever active. Never fall back to one after a missing key or provider failure. Browser speech recognition can transcribe without an AI key; sending that transcript to the companion still requires AI setup. Recognition may use browser-vendor remote services. Show listening, permission, unsupported and retry states without claiming local processing.

## AI roles and authorization

The conversational companion understands goals, answers questions and requests clarification. It produces structured intents for private coding workers when a user explicitly asks to create, change or repair. Such requests already authorize ordinary work; no generic Apply change step follows. Questions such as “Why is this chord difficult?” remain conversation. Ambiguous requests get a concise question. Destructive, expensive or high-risk changes require specific confirmation describing their consequences.

Coding workers inspect the current project, make bounded changes, compile, verify candidates and commit safe results. Show goal-oriented progress such as “Creating your app…”, “Checking the changes…” and “Ready to try.” Keep tool output and technical failure details in diagnostics. Do not claim tests, features or successful changes before verification. Preserve relevant durable data and compatible running state during updates; retain the last working application on failure.

## Feedback and adaptation

Feedback attaches to the app, original request and resulting version. A compact dismissible prompt may ask whether a meaningful change helped. Positive feedback is recorded quietly. “Not yet” continues the unresolved conversation: ask what is still wrong unless deterministic evidence already explains it. Vague dissatisfaction alone must not trigger rewriting. A specific correction requested in that conversation automatically enters investigation and repair, then verification and a fresh opportunity to assess the result. Never end negative feedback with only “feedback saved.” Do not repeatedly prompt about an unresolved attempt.

Behavioral signals are uncertain and require observation consent. Suggestions are subtle, dismissible and never block chat or application use. Ignoring or dismissing a suggestion causes no structural edits. Acceptance supplies authorization for the particular suggested change. Users can undo changes and control observation.

## Settings, recovery and accessibility

Primary settings connect a provider, select a sensible model and explain basic usage limits. Per-role routing, token prices, request limits and detailed logs use progressive disclosure. Validate fields and test configured credentials before saving. Errors explain how to recover and preserve entered data. Cancel and Escape discard unsaved settings. Every dialog has a visible top-right close button, a programmatic name, initial focus, contained keyboard focus, Escape dismissal and focus restoration. Long dialogs fit small screens with accessible actions.

Controls must be keyboard operable and have understandable accessible names. Use visible focus, adequate contrast, sufficiently large targets and status announcements. Maintain readable reflow without horizontal page scrolling. Avoid repeated live announcements or forcing focus during background updates.

## Success criteria

Executable browser tests must cover clean first-run setup and request resumption; meaningful goal-specific generation through the actual conversation → intent → coding → compilation → app pipeline; explicit modifications without redundant confirmation; ordinary conversation without coding; app-state preservation; negative-feedback clarification and another repair; ignored/dismissed/accepted suggestions; provider errors; dialog keyboard and Save/Cancel behavior; simulated speech callbacks and permission failures; and desktop/mobile layout and visibility of developer controls.

Use deterministic providers for reproducible tests, clearly distinguishing them from real provider verification. Review real browser screenshots and interact with useful generated functionality. Keep compilation, runtime, origin security, persistence and backup regression coverage. Building successfully alone does not establish product correctness.

## Design references

Apply these references concretely in implementation and testing:

- [Nielsen Norman Group usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/): visible status, familiar language, user control, error prevention and recovery, minimal necessary information.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/): keyboard access, focus visibility, contrast, reflow, target sizing and status messages.
- [WAI-ARIA modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/): named dialogs, initial focus, contained Tab navigation, Escape and focus return.
- [Nielsen Norman Group progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/): reveal specialized settings only when requested, keeping the initial task simple.
- [Google People + AI Guidebook: Feedback + Controls](https://pair.withgoogle.com/guidebook/chapters/feedback-and-controls/): support immediate correction and steering, make proactive assistance easy to dismiss, and match automation to user expectations and stakes.
