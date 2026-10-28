# It's Alive V2

It's Alive is a continuously adaptive AI interface for ordinary users. Describe a goal, use the application it creates, and ask the companion to help or make changes. The application fills the workspace; assistance and app navigation share one compact collapsible left sidebar. Technical implementation stays behind the scenes.

The authoritative [product vision](docs/PRODUCT_VISION.md) and [agent contract](AGENTS.md) govern interface and orchestration decisions. V1 remains on the preserved `archive/v1` branch and `archive-v1-2026-10-21` tag.

## Run locally

Use Node.js 22 or newer.

```sh
npm ci
npm run dev
# In another terminal:
npm run dev:app
```

Open **http://itsalive.localhost:4173**. The exact hostname matters: the authenticated bridge rejects other shell origins. Application frames use `http://<uuid>.itsalive.localhost:4174`. Chromium resolves localhost subdomains automatically; other browsers may need local DNS configuration.

Describe what you want to do. If AI is not connected, **⋯ → Settings** guides you through OpenAI API-key or eligible ChatGPT-plan setup with current model defaults and structured/tool connection tests, then resumes your request. Explicit requests to create, change or repair run automatically; questions stay conversational. Negative feedback continues the conversation so the assistant can help resolve the problem.

**Settings** groups AI connection, usage, editable preferences and general instructions, backup and diagnostics. Advanced AI choices have four categories (Low, Medium, High and Live voice). Standard/Faster/Fastest and the monthly spending estimate remain in the sidebar; an optional spending limit lives in Settings. Defaults use GPT-6 Luna, GPT-6.1 Sol, GPT-6.1 Sol with higher reasoning, and GPT-Live 1. Reasoning is selected automatically. There are no source-editor or developer-tools controls. Debug logging and diagnostic downloads work without a connected AI account.

**Talk live** starts an AI conversation over WebRTC. You can keep talking while application changes run, turn off **Spoken replies** to read the responses, or mute the microphone. Browser speech recognition is never used. Live voice requires an OpenAI API key and has separate metered usage. **Enter** sends a message; **Shift+Enter** inserts a new line.

For local ChatGPT-plan access, run `npm run connection` in another terminal, then choose **ChatGPT plan → Continue with ChatGPT**. The helper performs official OAuth, keeps tokens in an ignored local directory, loads your available models and uses eligible plan allowance shared with Codex. It does not use GitHub as an OAuth provider. Hosted deployments implement browser-owned PKCE OAuth, credential persistence, refresh and sign-out through a stateless same-origin boundary. They require an OpenAI-issued public client with the exact website callback and hosted plan scope; identity-only login cannot use the allowance. See [authentication research and setup](docs/AUTH_RESEARCH.md).

Development-only deterministic operation uses `http://itsalive.localhost:4173/?test-provider=scripted`. It is never a production setting or an error fallback.

## Architecture

```text
Shell origin: source + immutable revisions + IndexedDB + provider keys
    ├── SWC WASM compiler worker + shared pinned dependency cache
    ├── conversation / decisions / bounded file-editing harness
    ├── disposable candidate origin → deterministic render check
    └── authenticated MessagePort
          └── application UUID origin
              ├── minimal stable bootstrap
              ├── shell-supplied React Refresh + Zustand runtime
              └── generated app + ordinary origin storage
```

Normal app compilation happens in the browser. SWC transforms only changed modules; source projects contain ordinary TS/TSX, CSS, JSON and relative imports. Compatible npm packages are resolved through an ESM gateway, pinned, hashed and cached centrally by the shell. Browser-only packages are supported; Node builtins and unsupported module forms receive actionable diagnostics.

Runtime packages are stable across revisions. Compatible React edits preserve local hook state. Durable JSON state uses a runtime-owned Zustand store, persisted in shell IndexedDB. Applications may also independently use IndexedDB, localStorage, Cache Storage and OPFS.

```tsx
import { useStore, setState } from "@itsalive/store";
import { text, decide, choose, score } from "@itsalive/ai";

export default function App() {
  const count = useStore((state) => Number(state.count ?? 0));
  return (
    <button onClick={() => setState({ count: count + 1 })}>{count}</button>
  );
}
```

Generated code never receives provider credentials or coding capabilities. AI calls cross the authenticated bridge to shell-owned routing. API-key requests use a same-origin server boundary forwarding to fixed OpenAI endpoints; ChatGPT-plan requests use the hosted account boundary or the local helper according to installation. Accounting separates roles, provider-reported usage, monetary estimates and unknown charges; it does not reserve fabricated charges. Client-side limits are not provider-enforced financial guarantees; configure provider-side limits for that purpose.

## Backup and restore

**Settings → Backup and restore → Back up or restore all apps** downloads a SHA-256-checked archive containing all source revisions, recoverable candidate drafts, manifests/locks, cached dependency resources, the complete usage ledger and portable platform settings/history and supported app-origin storage. The shell visits each app in backup-only mode without executing generated source. Restore validates the archive before modifying data and restores origin data before shell records.

**Version history → Restore** changes only the current app version and retains its saved data.

The archive reports skipped storage and failures. It excludes shell provider keys, but arbitrary application data can contain secrets. Cookies and inaccessible browser-managed state are not restored. Archives are unencrypted and currently limited to 128 MiB in memory. Close other app tabs; arbitrary concurrent writes, service workers and external network effects prevent universal transactional guarantees. See [backup details](docs/backup.md).

## Validate

```sh
npm run typecheck
npm test
npm run build
npx playwright install --with-deps chromium
npm run test:e2e
npm run test:production
npm run benchmark
```

Tests use actual Chromium origins, actual WASM compilation, real React updates, deterministic providers and a reproducible npm fixture. Live-provider probes are a separate opt-in path: see [provider documentation](docs/providers.md).

The root Worker in `wrangler.toml` serves `dist-root/` plus the `/api/*` routes at `https://itsalive.org`; `dist-app/` deploys to `https://*.itsalive.org` using the included Wrangler configurations. Generated apps require JavaScript evaluation and WebAssembly. Deployment/DNS/TLS and live providers were not validated by local tests.

## Evidence and limits

- [October review implementation and 196-record coverage](docs/review-2026-10-26/README.md)
- [Implementation milestones](docs/MILESTONES.md)
- [Compiler comparison and measurements](docs/compiler.md)
- [Browser acceptance coverage](docs/acceptance.md)
- [OpenAI, account access, spending and live voice](docs/providers.md)
- [Backup formats and limitations](docs/backup.md)

Generated TypeScript is transpiled, not semantically typechecked. Normal updates preserve compatible React state; arbitrary render failures may require a remount. Apps have broad control over their own origin; this is origin isolation, not a complete sandbox from their local runtime. Full offline shell boot, streaming backups, encrypted archives and universal npm compatibility are outside this version.
