# V2 implementation milestones

V1 preserved at `archive/v1` and tag `archive-v1-2026-10-21`. V2 is now on main. Product recovery is developed on `fix/product-experience-recovery`; this work does not deploy or merge.

- [x] Read V1 architecture, invariants, and issues #168 and #149.
- [x] Preserve V1 and establish a clean implementation branch.
- [x] Compare browser compiler strategies with reproducible measurements.
- [x] Integrate shell, authenticated origins, source projects, compilation and state-preserving updates.
- [x] Integrate bounded providers, conversation, file tools, repair and optional behavior suggestions.
- [x] Implement shell-owned portable backup and restore, including app-origin storage.
- [x] Run deterministic tests, real multi-origin browser acceptance and benchmarks.
- [x] Document evidence, limitations and reviewable Git changes.

Design invariants: source is authoritative; failed candidates keep the active app; credentials and platform authority remain in the shell; wildcard deployment is bootstrap only; deterministic checks decide technical success. Verification must not mutate live app data. No V1 compatibility machinery.

Owner review, live-provider compatibility, real microphone recognition and production deployment are separate checks before main replacement. See [the implementation report](V2-REPORT.md) for measured evidence and limitations.

## Product experience recovery

The authoritative contract is [PRODUCT_VISION.md](PRODUCT_VISION.md), enforced by root AGENTS.md and product acceptance scenarios. Recovery replaces the developer-oriented default with the running application and one assistant/navigation rail, explicit provider onboarding, private coding delegation and an unresolved-feedback conversation. Advanced tools retain engineering access.

Validation and reviewed screenshot evidence are recorded in [PRODUCT_RECOVERY.md](PRODUCT_RECOVERY.md). Live-provider response quality and physical microphone recognition remain separate from deterministic browser evidence.
