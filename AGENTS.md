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
