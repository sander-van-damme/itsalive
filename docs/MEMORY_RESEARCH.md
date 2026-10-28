# Preferences and conversational understanding

The October 2026 review showed two different needs: remember how the user wants apps to behave, and understand the current problem before selecting a solution. A memory of preferred interface style cannot substitute for asking which hand is tense. Conversely, the user should not have to repeat an explicit preference for concise copy every time they create an app.

## Research findings

Official documentation was reviewed on 26 October 2026. These are product patterns, not claims that It's Alive has access to another service's memory.

- [ChatGPT Memory](https://help.openai.com/en/articles/8590148-memory-in-chatgpt) distinguishes saved memories from chat history and supports reviewing, correcting and deleting remembered context. Turning memory off is different from deleting the underlying conversations. Availability differs across plans and workspaces. The relevant pattern here is a visible, editable memory with clear sources and separate scope.
- [ChatGPT Custom Instructions](https://help.openai.com/en/articles/8096356-chatgpt-custom-instructions) provides directly editable instructions applied across conversations. They are distinct from details the assistant learns. It's Alive likewise keeps the user's instructions separate from model-proposed memory updates.
- [Claude personalization](https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features) separates account-wide instructions from project-specific instructions. It's Alive uses all-app and current-app preference scopes, rather than passing every app's conversations to every other app.
- [Gemini memory and instructions](https://support.google.com/gemini/answer/16598625?hl=en) supports conversational corrections as well as viewing, editing, deleting and disabling instructions. The transferable pattern is that a new preference can correct an old one, and the user can inspect the resulting state.

## Implemented contract

`src/ai/memory.ts` stores a versioned `PreferenceMemory` under `user.preferences`. General instructions are a user-controlled text field. The companion cannot overwrite that field. Individual remembered preferences carry a stable topic, complete text, all-app or current-app scope, explicit or inferred provenance, source app, source quote and timestamps.

A directly stated enduring preference may be remembered automatically. An inferred preference remains a suggestion until accepted. A one-off requested edit should not automatically become a global preference. A correction updates a stable topic rather than adding repeated contradictory entries. An inferred correction cannot replace an explicit active preference. Forgetting requires the user's request; it remains possible while memory use is disabled. Disabling remembered preferences pauses learning and use without deleting them or disabling independently supplied general instructions.

Memory updates must include a literal excerpt from the latest user turn. A model-generated claim or text found inside an app cannot independently authorize a memory write. Credential-like strings are rejected by preference storage. General instructions and relevant active preferences are provided to the conversational companion. The coding worker receives only the preferences relevant to its task through `changePreferences`, not the user's complete memory.

The active preference list has a 6,000-character product budget to keep the remembered profile manageable. This is not a model token limit or a conversation/source truncation rule. General instructions and model requests are not cut to that budget. When the active list is full, a proposed addition is retained completely as a suggestion with an explicit capacity result; existing active preferences are not silently evicted. The user can shorten, forget or accept entries. Duplicate topics are updated automatically. This deliberately avoids a hidden summarizer silently deleting or changing explicit preferences.

## Conversation and app evidence

`converse` accepts an optional `ConversationEnvironment` containing the active app's actual source, state and runtime inspection; a list of available app identities; actual context for explicitly referenced apps; and preference memory. Model inputs preserve this supplied context without arbitrary slicing. App contents are marked as evidence, not as instructions to change the companion's behavior or authorize memory changes.

`findReferencedApps` resolves explicit app-title mentions. A title match is a retrieval cue, not proof of knowledge: the companion can name a referenced app in a change only when its project or inspection was actually supplied. Ambiguous or unavailable references require clarification. This provides deliberate cross-app design references without importing unrelated chats or making all app data global.

The conversation policy separates authorization from understanding. A stopwatch or a clear metronome repair proceeds directly. A problem-led request with consequential missing detail asks a useful question first. Clarification responses can contain two to four concise choices with complete answer values; the UI must retain an unrestricted text answer. A clarification cannot also authorize a structural change. Actual app evidence should answer observable complaints before the companion asks the user to repeat them.

The response's `decisionSummary` is a short factual explanation for diagnostics, not hidden model reasoning. `changeRequest` preserves the original goal, discovered facts and relevant constraints. Generated app requirements live in `generation-policy.ts`: functional copy, no invented duplicate branding, readable and accessible controls, distinct task flows, durable in-progress state, useful motion/audio, and truthful goal-oriented progress.

## Integration and validation

The shell supplies evidence before calling `converse`, renders clarification choices, persists `applyMemoryChanges(...).memory`, and reports whether a preference was saved or merely suggested. Settings exposes instructions and memory controls independently of provider connection validation. The worker receives the selected task preferences and design contract. Memory and instructions are portable user settings; they contain personal preferences, so ordinary backup disclosure still applies.

Settings saves merge the fields the user actually changed against the state captured when the dialog opened. Memories learned in the meantime remain intact. An explicit edit or deletion wins for that entry, and a capacity conflict asks the user to review rather than silently dropping newer preferences.

Unit coverage exercises update/deduplication, cross-app scope, inferred suggestions, acceptance, disabled use, forgetting, credential rejection, source-quote checks, complete overflow preservation and user edits. Conversation coverage verifies that real source and runtime evidence reach the provider uncut, choices cannot simultaneously authorize a build, and a referenced app's name alone is insufficient evidence.

`e2e/review-companion.spec.ts` uses deterministic HTTP provider responses with the real shell, parser, tools, compiler and app iframe. It covers a useful question before any coding request, choice selection and free-text entry, direct stopwatch creation, actual source and runtime inspection for a complaint, named app source reaching the coding worker, explicit memory across apps and Settings edit/forget controls, and overlapping requests executing both authorized changes in order. Memory unit coverage also checks Settings/conversation merge conflicts.

These deterministic tests verify data flow and authorization boundaries. They do not establish real-model empathy or generated interface quality. Real-provider acceptance should repeat the original tight-hands, Learn/Practice, no-filler and stopwatch-reference scenarios and inspect the actual resulting conversation and app.
