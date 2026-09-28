# Settings and Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add clear Settings connection feedback, accurate service guidance, safe runtime diagnostics, applied migration visibility, and a one-click consistent SQLite backup download.

**Architecture:** A server-only diagnostics module produces an allowlisted runtime/database model and already-sanitized text report without probing external services. A separate backup helper uses `better-sqlite3`'s online backup API, reads the completed snapshot fully into memory, then removes the temporary file before returning bytes through a Node.js App Router route. Pure client helpers control diagnostics/backup UI states and accept only a validated branded sanitized-report string, making it impossible for copied diagnostics to serialize `resolvedPath`.

**Tech Stack:** Next.js 16.1.6 App Router, React 19.2.3, TypeScript, `better-sqlite3` 12.6.2, SQLite WAL, Vitest 4.1.2, Playwright MCP.

**Spec:** `docs/superpowers/specs/2026-09-27-settings-diagnostics-design.md`

## Global Constraints

- Leave all work uncommitted and unpushed.
- `/api/diagnostics` must not perform fresh external connection tests.
- Diagnostic output is allowlisted and must never serialize arbitrary settings.
- Copied diagnostics must never serialize `resolvedPath`; only `sanitizedPath` may appear in copied output.
- The full resolved database path may appear only in the local Advanced Settings UI response fields.
- Never expose Plex tokens, Arr keys, AI keys, TMDb custom keys, Discord webhooks, Telegram credentials, passwords, bearer tokens, session IDs, or other secret values.
- Recent error diagnostics include at most 20 entries, newest first, with normalized and redacted messages truncated to 300 characters.
- Applied migration keys include only completed `migration_%` markers and are sorted ascending.
- Git commit lookup order is deployment/build environment metadata, local Git, then `unknown`.
- TMDb guidance must describe a custom key as optional while the built-in key is available.
- Backups must use `Database.backup()`; raw active-file copies are prohibited.
- The completed backup snapshot must be fully read into memory before its temporary file is deleted.
- Backup cleanup must run on success and failure, and no backup is retained server-side.
- Backup downloads must not include WAL/SHM files or reveal any server path.
- Do not add streaming, restore, scheduled backups, retained backups, configuration export/import, or background health probes.
- Preserve existing Plex, Jellyfin, Emby, Sonarr, Radarr, AI, TMDb, notification, scheduler, Queue, Library, Not now, and Watched behavior.

## Review Focus

- A diagnostic log containing credential-shaped URLs or headers must be redacted without destroying ordinary error context.
- An environment commit value that is empty or malformed must fall through safely to local Git or `unknown`.
- A backup that succeeds but cannot be read must still delete its temporary file and return no partial response.
- A backup file must remain present until the full `readFile()` operation completes, then be removed before route success returns.
- Clipboard construction must accept a branded `SanitizedDiagnosticReport` string rather than the full diagnostics object, so `resolvedPath` cannot leak by later serialization.

---

### Task 1: Diagnostics data model, runtime metadata, and database inspection

**Files:**

- Create: `src/lib/diagnostics.ts`
- Create: `tests/diagnostics.test.ts`
- Modify: `src/lib/database.ts`

**Interfaces:**

- Produces `RuntimeMetadata`, `DatabaseDiagnostics`, `RecentDiagnosticError`, `DiagnosticsSnapshot`, `getRuntimeMetadata()`, `getDatabaseDiagnostics()`, `getAppliedMigrations()`, `getRecentDiagnosticErrors()`, `sanitizeDatabasePath()`, `redactDiagnosticText()`, and `buildDiagnosticReport()`.
- Consumes the existing `getDatabase()` connection and configured database path.
- `buildDiagnosticReport()` consumes a report-safe type that contains `sanitizedPath` and does not define `resolvedPath`.

- [ ] **Step 1: Write failing tests for application version and Git commit precedence**

  Cover `RECOMENDARR_GIT_COMMIT`, `GIT_COMMIT`, and `VERCEL_GIT_COMMIT_SHA` precedence; normalized short hashes; malformed and empty environment values; injectable local Git fallback; and final `unknown`. Assert package version resolves to `3.0.1` through an injectable package metadata boundary.

- [ ] **Step 2: Run the focused tests and confirm the missing-module failure**

  Run: `npm test -- --run tests/diagnostics.test.ts`

- [ ] **Step 3: Implement typed runtime metadata collection**

  Keep environment and Git readers injectable for tests. Use a bounded `execFileSync('git', ['rev-parse', '--short', 'HEAD'])` fallback without a shell, a short timeout, and swallowed lookup failure. Normalize commit output to a safe printable identifier.

- [ ] **Step 4: Add failing tests for path sanitization, migration enumeration, and database summary**

  Cover Windows and POSIX paths, basename-only suffix preservation, reachable and failed database queries, byte size, `PRAGMA journal_mode`, completed-marker filtering, and deterministic migration sorting.

- [ ] **Step 5: Add focused database helpers and diagnostics inspection**

  Add only the reusable read helpers needed by diagnostics to `database.ts`; do not expose arbitrary settings. Database inspection must use parameterized SQL and tolerate unavailable filesystem metadata without failing the whole snapshot.

- [ ] **Step 6: Add failing tests for bounded recent errors and defense-in-depth redaction**

  Seed more than 20 errors and verify newest-first order, exactly 20 results, whitespace normalization, 300-character maximum, and omission of `details`. Include distinctive Plex, Sonarr, Radarr, AI, TMDb, Discord, Telegram, bearer, password, and query-string secrets.

- [ ] **Step 7: Implement recent-error sanitization and allowlisted report formatting**

  Redact credential-bearing URLs, authorization fragments, and secret-shaped key/value pairs. Build a readable plain-text report exclusively from a `DiagnosticReportInput` type that has `sanitizedPath` and cannot carry `resolvedPath`.

- [ ] **Step 8: Run the diagnostics tests until green**

  Run: `npm test -- --run tests/diagnostics.test.ts`

---

### Task 2: Diagnostics API and secret-exclusion contract

**Files:**

- Create: `src/app/api/diagnostics/route.ts`
- Create: `tests/diagnostics-api.test.ts`
- Modify: `src/lib/diagnostics.ts`

**Interfaces:**

- Produces `GET /api/diagnostics` with runtime, database, configured-service summaries, bounded recent errors, and an already-sanitized `report`.
- The structured database object may contain `resolvedPath` for local UI display; the `report` must be generated before response serialization from the report-safe model containing only `sanitizedPath`.
- Does not consume connector functions or make network calls.

- [ ] **Step 1: Write failing API tests for the allowlisted response shape**

  Assert runtime fields, database summary, full local `resolvedPath`, separate `sanitizedPath`, sorted migrations, configured-service booleans, `unknown`/`not_tested` states, recent errors, and `Cache-Control: no-store`.

- [ ] **Step 2: Write a failing no-probe test**

  Mock every external connector/test function and assert none are imported or called by diagnostics. Verify diagnostics remain useful when no connection test has run.

- [ ] **Step 3: Write a failing exhaustive secret-leak test**

  Seed distinctive values for every secret category in saved settings and logs. Serialize the complete response and assert none appear. Separately assert `response.report` contains `sanitizedPath` and does not contain `resolvedPath`, its parent directories, or drive-specific directory names.

- [ ] **Step 4: Implement the Node.js diagnostics route**

  Set `export const runtime = 'nodejs'`. Build configuration status from explicit booleans/types only. Return safe nullable fields for partial filesystem or database-summary failures, and a generic `500` only when snapshot construction fails completely.

- [ ] **Step 5: Run the diagnostics API tests until green**

  Run: `npm test -- --run tests/diagnostics-api.test.ts tests/diagnostics.test.ts`

---

### Task 3: Consistent SQLite backup helper and download route

**Files:**

- Create: `src/lib/database-backup.ts`
- Create: `src/app/api/database-backup/route.ts`
- Create: `tests/database-backup.test.ts`
- Create: `tests/database-backup-api.test.ts`

**Interfaces:**

- Produces `createDatabaseBackup(): Promise<{ bytes: Uint8Array; filename: string }>` and `POST /api/database-backup`.
- Consumes `getDatabase().backup(tempPath)`, `os.tmpdir()`, and promise-based filesystem operations through injectable dependencies in unit tests.

- [ ] **Step 1: Write failing helper tests for operation ordering and safe filenames**

  Record dependency calls and require this exact success order: create unique temporary path, await `backup(tempPath)`, await the complete `readFile(tempPath)`, then `unlink(tempPath)`, then resolve bytes. Assert deletion never begins before `readFile` resolves. Assert the public filename matches `recomendarr-backup-YYYY-MM-DD_HH-mm-ss.db` and contains no temporary or configured path.

- [ ] **Step 2: Run the helper test and confirm the missing-module failure**

  Run: `npm test -- --run tests/database-backup.test.ts`

- [ ] **Step 3: Implement the backup helper with unconditional cleanup**

  Generate a UUID-based temporary basename under `os.tmpdir()`. Await the v12.6.2 online backup promise. Fully read the completed snapshot into memory. Delete it only after `readFile` resolves. Use `finally` to retry safe cleanup on every failure path, ignoring only `ENOENT`. Never read or package WAL/SHM files.

- [ ] **Step 4: Add failure-path tests**

  Cover backup rejection, read rejection after a completed backup, unlink failure, and already-absent cleanup. Assert no bytes resolve after a failure, no path escapes the temporary directory, and cleanup is attempted exactly as required.

- [ ] **Step 5: Write failing route tests for binary response and cleanup**

  Open returned bytes with `better-sqlite3` and query known seeded rows to prove the response is a valid consistent SQLite snapshot. Assert `Content-Type: application/vnd.sqlite3`, safe `Content-Disposition`, `Cache-Control: no-store`, absence of path/WAL/SHM strings in headers, and generic sanitized failures.

- [ ] **Step 6: Implement the Node.js backup route**

  Set `export const runtime = 'nodejs'`. Return a Web `Response` containing the in-memory bytes and attachment headers. Do not stream, retain, or expose the temporary file.

- [ ] **Step 7: Run all backup tests until green**

  Run: `npm test -- --run tests/database-backup.test.ts tests/database-backup-api.test.ts`

---

### Task 4: Normalize connection-test responses and add service guidance

**Files:**

- Modify: `src/app/api/test-connection/route.ts`
- Modify: `src/app/page.tsx`
- Modify: `src/components/app/models.ts`
- Modify: `src/components/app/settings-page.tsx`
- Modify: `src/components/app/notification-panel.tsx`
- Create: `src/components/app/connection-test-result.tsx`
- Create: `src/components/app/service-guidance.ts`
- Create: `tests/connection-test-api.test.ts`
- Create: `tests/service-guidance.test.ts`

**Interfaces:**

- Produces normalized `PublicConnectionTestResult` and reusable inline `ConnectionTestResult` presentation.
- Produces pure service-guidance selectors based on provider type and enablement state.
- Preserves discovery arrays needed by existing user/profile/root-folder flows.

- [ ] **Step 1: Write failing route tests for normalized public results**

  Cover success and expected upstream failure for media server, Sonarr, Radarr, AI, TMDb, Discord, and Telegram; malformed bodies; unknown services; preserved discovery data; and sanitized messages. Seed secret-shaped upstream error text and assert it is absent from serialized responses.

- [ ] **Step 2: Implement normalized connection-test responses**

  Return `success`, `message`, optional allowlisted `details`, and existing safe discovery collections. Use `400` for malformed or unknown requests. Convert expected upstream failures to useful public failures without returning raw exceptions.

- [ ] **Step 3: Write failing pure guidance tests**

  Assert Plex authenticated/manual requirements, Jellyfin/Emby requirements, Sonarr/Radarr connection versus add requirements, optional custom TMDb key wording, conditional AI fields, notification requirements, and scheduler cron guidance.

- [ ] **Step 4: Implement service guidance data**

  Keep guidance declarative and derived from current form values. Do not add validation rules or change saving behavior.

- [ ] **Step 5: Implement inline result presentation**

  Extend `ConnectionResult` without discarding existing discovery fields. Render testing, success, failure, and not-tested states near each test action. Preserve entered values after all outcomes and keep text/icon cues independent of color.

- [ ] **Step 6: Run focused connection and guidance tests until green**

  Run: `npm test -- --run tests/connection-test-api.test.ts tests/service-guidance.test.ts tests/plex-sign-in-client.test.ts`

---

### Task 5: Advanced diagnostics and backup UI

**Files:**

- Create: `src/components/app/settings-diagnostics-model.ts`
- Create: `src/components/app/settings-diagnostics.tsx`
- Create: `tests/settings-diagnostics-model.test.ts`
- Modify: `src/components/app/settings-page.tsx`
- Modify: `src/components/app/models.ts`
- Modify: `src/app/globals.css`

**Interfaces:**

- Consumes public `GET /api/diagnostics` metadata and `POST /api/database-backup` bytes.
- Produces pure diagnostics/backup state transitions and a Settings Advanced panel.
- Clipboard composition accepts `{ report: SanitizedDiagnosticReport, connectionStates: PublicConnectionState[] }`, never the full diagnostics response. The brand is created only by the diagnostics response parser after validating that `report` is a string.

- [ ] **Step 1: Write failing model tests for diagnostics, clipboard, and backup states**

  Cover idle/loading/ready/error diagnostics; idle/copying/copied/error clipboard; idle/preparing/downloaded/error backup; timeout reset behavior; response filename parsing; safe filename fallback; and object-URL cleanup.

- [ ] **Step 2: Add the compile-time and runtime copied-report safety tests**

  Define an opaque `SanitizedDiagnosticReport` string brand and a `CopyDiagnosticsInput` that has the branded report and public connection-state labels only. Add `@ts-expect-error` coverage showing a full `DiagnosticsResponse` and an unvalidated plain string cannot be passed. At runtime, give the formatter an object with an extra `resolvedPath` property through an unsafe cast and assert copied text still reads only the branded report value and never serializes that property.

- [ ] **Step 3: Implement the pure Settings diagnostics model**

  Keep state transitions, response parsing/branding, byte formatting, attachment filename parsing, and copied-report composition free of DOM dependencies. Append only normalized in-memory state labels to the already-sanitized server report.

- [ ] **Step 4: Implement the Advanced Diagnostics panel**

  Show app version, commit, full local resolved path, database summary, and sorted migration names. Add refresh, Copy diagnostics, and Download database backup actions with explicit progress/success/error text. Do not mark Settings dirty.

- [ ] **Step 5: Implement the browser download lifecycle**

  Fetch the POST route, read the blob, derive only a safe attachment basename, create and click a temporary anchor, revoke the object URL in `finally`, and report success only after triggering the download.

- [ ] **Step 6: Add focused responsive and accessible styles**

  Reuse existing settings cards, badges, and buttons. Provide keyboard-visible focus, wrapping paths, mobile action stacking, and migration-list scrolling where needed.

- [ ] **Step 7: Run the model tests until green**

  Run: `npm test -- --run tests/settings-diagnostics-model.test.ts`

- [ ] **Step 8: Verify the UI with Playwright MCP**

  Start the app against local test data. Verify inline connection outcomes preserve values, Advanced displays metadata and sorted migrations, Copy diagnostics writes sanitized text, and Backup emits a `.db` download with a safe timestamped name. Capture desktop and narrow-layout snapshots. If the Playwright browser is unavailable, attempt the approved browser installation once and report the exact blocker without substituting visual claims.

---

### Task 6: Regression, security, and scope verification

**Files:**

- Modify only files required to fix failures caused by Tasks 1–5.

**Interfaces:**

- Consumes all prior tasks.
- Produces a verified, uncommitted Settings and diagnostics milestone.

- [ ] **Step 1: Run all focused suites**

  Run: `npm test -- --run tests/diagnostics.test.ts tests/diagnostics-api.test.ts tests/database-backup.test.ts tests/database-backup-api.test.ts tests/connection-test-api.test.ts tests/service-guidance.test.ts tests/settings-diagnostics-model.test.ts tests/settings-api.test.ts tests/media-server.test.ts tests/plex-auth-api.test.ts tests/plex-sign-in-client.test.ts`

- [ ] **Step 2: Run the full test suite before the production build**

  Run: `npm test`

  Read the complete result. Report any pre-existing live-provider failure separately; do not weaken or skip it to claim a pass.

- [ ] **Step 3: Run lint**

  Run: `npm run lint`

- [ ] **Step 4: Run the production build**

  Run: `npm run build`

- [ ] **Step 5: Run diff and secret audits**

  Run: `git diff --check`

  Search changed source, test fixtures, serialized diagnostic responses, and generated filenames for the distinctive test secrets. Confirm no response/report contains `resolvedPath` in copied output, no backup code copies the active database directly, deletion occurs after the full read, no external connector is called by diagnostics, and no Seerr or unrelated Queue behavior changed.

- [ ] **Step 6: Review runtime artifacts and working tree**

  Inspect `git status --short`. Restore only SQLite/runtime artifacts created by tests after stopping any development server started by this work. Preserve all authorized source and documentation changes. Do not commit or push.

- [ ] **Step 7: Produce the completion report**

  Report changed files, tests added, exact test/lint/build/diff results, Playwright evidence or blocker, caveats, deferred work, and confirmation that nothing was committed or pushed.
