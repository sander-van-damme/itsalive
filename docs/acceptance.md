# Browser acceptance

The [product contract](PRODUCT_VISION.md) is enforced through real user journeys, in addition to compiler, runtime, backup and security regressions. Run `npm ci`, `npx playwright install chromium`, then `npm run test:e2e`. Playwright starts the shell at `http://itsalive.localhost:4173` and the bootstrap at UUID subdomains on port 4174. App frames have real distinct origins. Browser compilation, candidate checks and React updates are real.

## Product journeys

`e2e/product-recovery.spec.ts` uses an explicitly installed deterministic HTTP replay from `e2e/fixtures/goal-provider.ts`. The production bundle contains neither its violin nor climbing-knot application fixture. Requests pass through the actual HTTP adapter, conversation intent parser, coding tools, SWC compilation, disposable verification origins, revision commit and live app.

- **Onboarding:** clean browser, no provider, goal submission opens setup rather than silently selecting Demo; successful connection resumes the original request.
- **Useful application:** create violin practice, choose a scale, start an exercise and record practice; never accept the compiler counter fixture as product success.
- **Conversation and modification:** a chord question returns an answer with no coding calls or version change. An explicit new exercise applies automatically without a second confirmation. Source remains hidden. Compatible transient state and saved practice survive the update, and saved practice survives reload.
- **Negative feedback:** introduce a broken Start control, attempt repair, choose Not yet, ask for missing detail without rewriting on vague feedback, then clarify and verify a working Start control after another repair. Feedback remains associated with the app, original request and version.
- **User control:** only accepted suggestions authorize changes. Ignored and dismissed suggestions leave the version intact. Structural requests that require confirmation explain their consequence.
- **Dialogs:** top-right close, Escape, contained keyboard focus and return, primary provider fields, advanced disclosure, Save/Cancel, validation and provider-error recovery.
- **Speech:** simulated browser recognition callbacks cover listening, final text, permission errors and typing fallback. Transcription requires no AI key; sending its result does.
- **Responsive use:** desktop application occupies most of the viewport beside one compact right rail. Mobile switches views without replacing the app frame or losing activity. Another goal creates an interactive knot tutorial, rather than a domain-specific product template.

Desktop and mobile captures are saved under `work/screenshots/` for visual review. Failure traces and screenshots are under `test-results/`, with the HTML report in `playwright-report/`. These paths are ignored build/test artifacts.

## Technical invariants

`e2e/platform.spec.ts` installs an explicit counter fixture for architectural tests. It is never the product starter. Its coverage retains:

- multi-file compilation, scoped source updates, compatible hook and durable state, reload and rollback;
- compile and runtime candidate rejection, working app retention and stale-edit ownership;
- pinned npm resolution, hashing and dependency cache reuse across app origins and reload;
- unsupported Node dependency diagnostics;
- application AI through the authenticated shell bridge;
- observation consent, actual repeated-click capture, suggestion dismissal and chat availability;
- full backup/restore into a clean browser with dependency downloads denied, including shell state, localStorage, IndexedDB schema/index/version/typed values, Cache Storage and OPFS;
- independent app-origin storage, shell credential isolation and absent privileged globals;
- empty backup restoration and useful downloadable diagnostics;
- explicit developer tools access rather than developer controls in the default journey.

`e2e/benchmark.spec.ts` retains actual-browser SWC versus esbuild compiler, visible update and lifecycle measurements. `e2e/live-dependencies.spec.ts` remains an explicit optional live-CDN probe. Unit tests retain bridge authentication, storage integrity, compiler, accounting, provider protocols and bounded coding tools, with added intent, onboarding and speech contracts.

`npm run test:production` builds both sites, serves their static assets and uses the same deterministic HTTP replay through the normal UI. It checks initial setup and request resumption, goal generation, conversational modification, hidden source tools, same app frame, transient and durable state retention, reload, and absence of development hooks and uncaught browser errors.

## Evidence boundaries

Deterministic replay verifies integration and outcomes for specified responses, not external model quality, live credentials, current model availability or real cost. Connection setup makes a bounded text-generation probe per provider/model; full structured-output and tool support still depends on that model. Browser microphone callbacks are simulated; no physical microphone recognition is claimed. Local static production smoke does not establish deployed DNS/TLS or hosted behavior. See [PRODUCT_RECOVERY.md](PRODUCT_RECOVERY.md) for the completed run counts, reviewed screenshots and remaining limits.

Playwright disables Vite shell HMR during acceptance. Generated-app hot updates remain enabled and tested. Root and wildcard Vite servers use separate dependency optimization caches so simultaneously starting them cannot invalidate each other's optimized modules.
