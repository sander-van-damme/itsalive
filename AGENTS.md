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


## Architecture boundary: keep the app runtime thin

Treat `src/app` as a minimal cross-origin execution kernel that can be replaced without losing platform-owned state or behavior.

- The root shell owns platform persistence, durable app documents, prompts, product policy, runtime API contracts and implementations, configuration, credentials, catalogs, history, logs, schedules, and other platform state unless browser security requires code to run in the app origin.
- Put code in `src/app` only when it must execute in the app origin, such as DOM access, generated-code execution, interaction capture, screenshots, validated `postMessage` transport, durability checks, or app-origin storage/service-worker cleanup.
- Do not add platform-private IndexedDB, localStorage, or other durable platform state to the app origin. Generated apps may still use their own browser-origin storage when the product intentionally exposes ordinary browser APIs to them.
- Initialize the runtime from the root shell over the validated bridge. Persistent app HTML is loaded and stored by the shell; the app runtime may serialize and restore DOM because that work requires app-origin document access.
- Treat `window.itsalive` as a shell-owned API exposed through a thin app-side facade/proxy. Keep policy, durable state, prompts, and large static catalogs in the shell; only local implementations that inherently require the app origin belong in the app runtime.
- When a responsibility can live on either side, prefer the shell. Do not move code into `src/app` merely because generated app code calls it.
