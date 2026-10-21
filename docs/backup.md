# Portable backup and restoration

`Repository` owns shell data in a single IndexedDB database. Source revisions are immutable; committing a revision and updating its app pointer is one transaction with an expected-current revision check. Apps, revision history, conversations, bounded diagnostics, and safe settings are exported together. Credentials live outside this database and never enter archives.

`exportBackup` closes no application itself: the shell must first flush durable state and close its live frames. It captures the shell, then asks the caller to mount one trusted backup-only app frame per UUID. That frame receives the current shell runtime but no generated source. It reads accessible origin storage and returns a structured snapshot. Each frame closes before the next opens.

The archive is a portable JSON envelope containing a versioned manifest, exact payload string and SHA-256 digest. Integrity checking detects corruption, not a malicious author capable of rewriting both payload and digest. Treat imports as executable application source and import only trusted archives. The UI must disclose that app data and conversations may contain secrets; archives are not encrypted.

## What is supported

- Shell source projects, lock metadata, complete retained revision history, durable managed state, conversations, diagnostics and settings. All cached remote modules and assets referenced by retained revision locks are included and independently checked against their lock hashes. Missing cache bytes are explicit failures; restoring those dependencies will require network access.
- App localStorage string keys and values.
- IndexedDB database versions, object-store key paths and auto-increment settings, indexes (including unique/multi-entry), keys and values. Each database is captured in one readonly transaction across its stores. The tagged graph format preserves shared references, cycles, arrays, plain objects, dates, regular expressions, maps, sets, bigint, undefined, special numbers, ArrayBuffers and views, Blobs and Files.
- Readable Cache Storage response bodies, status and headers with request URLs/headers. Opaque responses are explicitly skipped.
- Origin Private File System files and relative directory paths. File contents are binary-safe. Empty directories are not retained.

The manifest records each captured, skipped, failed or warning category. A backup can be partial: a failed database or inaccessible origin is retained as an explicit error, never disguised as a complete backup.

## Restoration

`inspectBackup` validates the digest, schema, source/revision references, origin-to-app mapping, every encoded storage graph and OPFS path before any destination writes. The caller can show its manifest before import. `restoreBackup` initializes the corresponding app origins without source, restores each supported storage type, then atomically replaces the shell database. Replacing shell records is deliberately a user-visible import action.

Recorded IndexedDB stores are replaced atomically inside one database transaction, or together with an abortable schema upgrade. Restoring over a newer database or a different schema at the same version is refused: use a clean profile or clear that app’s site data first. No uncancellable database deletion is queued against a user origin. Recorded caches are replaced; recorded OPFS files are overwritten; localStorage is replaced. Unrelated databases/caches/files are retained. This allows recovery in an existing profile without deleting unrelated origin data. A clean profile provides the most faithful test of portability.

There is no distributed transaction across browser origins. If a later origin fails, earlier origin writes may already be present. The error explicitly reports this; shell records are not published until all attempted origin restorations succeed. Missing origin snapshots from a partial archive are reported as skipped while source and shell state can still restore. Cancellation is forwarded to the runtime, aborts active IndexedDB restore transactions/upgrades, and stops between other storage operations; already completed writes are not rolled back.

## Browser limits and operational constraints

- Close other app tabs before backup or restore. Other contexts can write during capture. IndexedDB transactions are consistent within one database, but there is no atomic snapshot across all storage mechanisms or applications.
- An active service-worker controller causes backup/restore refusal. A worker could intercept even the bootstrap navigation; remove that worker through browser site settings and close controlled tabs before retrying. The platform cannot silently guarantee trustworthy bootstrap execution under arbitrary pre-existing workers.
- Existing database connections can block replacement. The operation fails after a bounded wait with an instruction to close other tabs. Database schema upgrades and auto-increment generator state after deleted high keys are not fully observable: restored generators advance from surviving keys.
- Cookie attributes, scope, expiry and HttpOnly values are not reliably available through JavaScript. Cookies are excluded from restoration; sessionStorage is intentionally excluded as session-only state. Browser permissions, HTTP cache, protected credentials and service-worker registrations are not portable app data.
- Unsupported structured-clone objects (for example non-exportable CryptoKeys or file-system handles) cause an explicit database capture failure.
- This first implementation builds archives in memory, with a default 128 MiB archive limit. Binary encoding avoids oversized argument lists, but this is not a streaming archive engine. Large databases require substantial browser memory. Progress is at origin/storage-operation boundaries; cancellation also forwards over the bridge and aborts active IndexedDB restore transactions.
- User/provider secrets inside arbitrary app data cannot be reliably identified. Only shell-managed credential exclusion is guaranteed. Keep backups private.

## Evidence

`tests/storage.test.ts` exercises concurrent revision conflicts, immutable source, full shell round-trips, secret redaction, bounded logging, and binary/cyclic graph preservation. `tests/backup.test.ts` covers clean-repository import, integrity rejection before writes, explicit capture failures, cancellation, blocked origin restoration, and path traversal rejection. Real browser evidence lives in the multi-origin Playwright suite; no live provider key is required for backup testing.
