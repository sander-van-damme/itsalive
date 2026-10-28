# Runtime recovery and visible work

The October review exposed a candidate that passed an isolated check and then failed when applied to a running app. Those are separate outcomes. Candidate verification is still mandatory, and the live apply now records its candidate, base revision, exception and rollback result under the same operation identity.

## Recovery after a live failure

The runtime preserves error names, messages, remote stacks and causes across its private MessagePort. The shell restores the previous artifact when needed, restores the durable state snapshot, and inspects the result. It records whether that restoration was verified; it does not infer success merely because a rollback was requested.

When rollback is verified and the failure occurred in live application, the coding harness keeps the candidate, completed receipts and original goal, clears the finish decision and sends the actual exception back for repair. Productive work has no fixed turn ceiling. Repeated identical checks against an unchanged candidate and the same failure remain a demonstrated no-progress condition. A persistence failure, revision conflict or unconfirmed rollback stops for recovery instead of continuing to mutate the app.

An older paused checkpoint that already requested finish and subsequently reported a workflow failure is revisited by the worker before another commit. It no longer silently runs the same successful cold check and failing live apply. Cancelled work with pending operations still resumes at the first uncompleted operation.

Cancellation remains available during compilation, verification and the final state snapshot. Once live application starts, the shell finishes the atomic commit or verified rollback; `onApplying` tells the interface when that boundary is active. A failure saving activity or presenting a result after a committed revision cannot undo that revision.

## Exact work markers

Runtime inspection returns opaque region IDs for actual visible sections and controls. IDs are tied to DOM elements, not selectors invented by a model. The coding worker can call `report_progress` with a short factual update and region IDs it obtained from inspection. The shell passes those IDs to the originating app runtime.

The runtime resolves each ID against its current DOM. Unknown, replaced or invisible elements are rejected. Only resolved targets receive a frosted overlay and temporary `inert` and `aria-busy` state; unrelated controls remain usable. A requested parent covers its requested descendants once. Markers follow resizing and scrolling, stay inside scroll clipping boundaries, remain visible in native modal dialogs, respect reduced motion and are removed on application changes and operation completion. Clearing a marker restores each element's previous inert and busy states.

An empty target list reports real progress without implying that any particular element is being changed. The runtime never fills the whole page with a guessed mask. Region resolution is evidence of the chosen element's identity, not proof that a worker's description is semantically correct; the generation policy requires honest, task-specific updates.

## App switching and resource lifetime

The shell retains the four most recently used application runtimes, including the selected app. Switching among these apps keeps React state, ongoing sessions and their DOM mounted. Only the selected frame is exposed as the active application; inactive frames are hidden and receive an `itsalive:visibility` event so generated apps can pause optional audio or animation. In-flight generated-app AI requests are cancelled on deactivation, and hidden apps cannot start new paid work until activated.

New frames render out of view with their real viewport before becoming visible, so their initial canvas and layout measurements are usable.

The four-frame cache bounds browser DOM, WebGL and media resources. Before evicting an older inactive frame, the shell saves its durable state and records `app.runtime.suspended`. Generated apps must still store important task state and timestamps through `@itsalive/store`: arbitrary transient JavaScript state cannot survive browser reload, cache eviction or a backup operation. Backup and restore flush every retained app, close their runtimes, and reopen the selected/restored app afterward.

## Integration

- `Workspace.setActivity({message, targets}, appId)` returns resolved and rejected region IDs.
- `Workspace.clearActivity(appId)` removes the originating app's markers.
- `Workspace.applyProject(..., correlationId, signal)` accepts cancellation through verification; `onApplying(appId, active)` marks the atomic live-application phase.
- Harness `onProgress` includes an optional task-specific `message` in addition to the lifecycle stage.
- Harness `onActivity` connects the worker's progress tool to runtime region resolution.
- `coding.tool.content` and `coding.check.evidence` carry full debug evidence into the shell logger, which owns credential redaction and collection settings.
- `Workspace.backupSummary` and `backupDetails` use the storage layer's completeness summary.

The unit suite covers exact failure evidence, non-serializable error details, verified versus unconfirmed rollback, legacy checkpoint retry, transcript continuation, cancellation boundaries, resource eviction and asynchronous app ownership. Browser acceptance covers transient sessions across app switches, initial layout measurement, exact marker bounds, scroll clipping, native dialogs, unaffected controls, reduced motion and stale region rejection. Real provider behavior remains a separate validation requirement.

Shell appearance is supplied as optional validated runtime metadata and updated through the authenticated bridge. The platform starter follows it immediately; generated apps retain their own styling and may opt into `html[data-shell-theme]`. The runtime no longer forces an inline light color scheme over authored styles.
