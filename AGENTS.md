# AGENTS.md

## Project status: beta

itsalive.org is in beta. Until the project owner explicitly says the product is out of beta and ready for release, breaking changes are allowed and should generally be preferred over compatibility machinery when they make the codebase or product simpler.

During beta:
- Do not add migrations, deprecated aliases, fallback readers, dual schemas, compatibility adapters, or version-bridging code solely to preserve older beta behavior or data.
- It is acceptable to reset or invalidate beta app data, history, settings, IndexedDB schemas, URLs, bridge messages, and runtime APIs when a cleaner current design requires it.
- Remove obsolete migration and backward-compatibility code when encountered.
- Preserve current product invariants, security boundaries, and test coverage; breaking changes being allowed does not make correctness or safety checks optional.
- Prefer tests for current behavior over regression tests whose only purpose is to preserve retired beta contracts.

Only after the project owner explicitly declares itsalive.org out of beta and ready for release should agents treat backward compatibility, migrations, deprecation periods, and stable public contracts as default requirements.


## Architecture boundary: wildcard app is only a bootstrap

Treat `src/app` and `dist-app` as a minimal, stable cross-origin bootstrap, not as the home of the platform runtime.

- The permanent wildcard app code should do only what is required to bootstrap safely: derive/validate the immutable app UUID, authenticate the expected root origin/source, validate the bootstrap envelope/version, establish the communication channel, and execute the shell-supplied runtime payload.
- The root shell owns, builds, and versions substantive runtime source. Code may need to **execute** in the app origin without being **owned or deployed** by the app build.
- DOM execution, document serialization/restoration, interaction capture, screenshots, logging hooks, canonical-root enforcement, durability checks, `window.itsalive` installation, cron callback registration, and similar origin-dependent logic should normally live in the shell-owned injectable runtime bundle.
- Prefer a one-time validated `postMessage` bootstrap handshake that transfers a dedicated `MessagePort` for subsequent runtime communication.
- A mounted app should receive the runtime version belonging to the currently loaded shell. Ordinary runtime changes should require only a root deployment; update the wildcard bootstrap only when the bootstrap/security protocol itself must change.
- The root shell owns platform persistence, durable app documents, prompts, product policy, runtime API contracts, configuration, credentials, catalogs, behavioral summaries, histories, logs, schedules, and other platform state.
- Persistent app HTML is loaded/stored by the shell. The injected runtime may serialize and restore DOM because those operations require app-origin access, but it sends snapshots to the shell for persistence.
- Do not add platform-private IndexedDB, localStorage, or other durable platform state to the app origin. Generated apps may still use their own browser-origin storage through ordinary browser APIs.
- Treat `window.itsalive` as a shell-owned API installed by the injected runtime. Keep policy, durable state, prompts, and catalogs shell-owned; local implementations exist only to bridge or perform browser-origin operations.
- When deciding whether code belongs in `src/app`, ask whether it is necessary **before trusted shell runtime code can be received and started**. If not, it belongs outside the permanent app bootstrap.
