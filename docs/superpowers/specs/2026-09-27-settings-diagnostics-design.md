# Settings and Diagnostics Design

**Date:** 2026-09-27

## Goal

Make Settings easier to configure and troubleshoot by adding clear inline connection results, accurate provider guidance, runtime and database metadata, sanitized copyable diagnostics, applied migration visibility, and a safe one-click SQLite backup download.

## Scope

This milestone includes:

- Inline connection-test success and failure results.
- Service-specific required-field guidance.
- Application version, Git commit, and resolved database path in local Settings.
- A sanitized diagnostic report copied to the clipboard.
- A deterministic list of applied database migrations.
- A consistent SQLite snapshot downloaded directly through the browser.

This milestone does not add background health checks, scheduled backups, retained server backups, backup restore, configuration export/import, external telemetry, or fresh external service probes from diagnostics.

## Design Principles

- Diagnostic output uses an explicit allowlist. It never serializes arbitrary settings or configuration objects.
- Connection tests remain deliberate user actions. Diagnostics report only the latest state already known to the current application session, or `unknown` / `not tested`.
- Operational errors are useful but never disclose credentials.
- Database backups use SQLite's online backup API instead of copying an active database file.
- Settings form values remain intact after connection-test failures.
- The UI communicates status with text and icons in addition to color.
- Existing manual Plex, Jellyfin, Emby, Sonarr, Radarr, AI, TMDb, and notification behavior remains intact.

## Settings Information Architecture

The existing Settings tabs and save flow remain in place. Each service section gains two small additions:

1. Guidance immediately associated with its configuration fields.
2. A persistent inline result immediately beneath its connection-test control.

The Advanced tab gains a Diagnostics section containing:

- Recomendarr version.
- Git commit.
- Full resolved database path for local display only.
- Database reachability, size, journal mode, and applied migration count.
- Sorted applied migration names.
- **Copy diagnostics** action with copying, copied, and error states.
- **Download database backup** action with preparing, downloaded, and error states.

No diagnostic or backup action makes the Settings form dirty.

## Connection-Test Results

`POST /api/test-connection` remains the single connection-test endpoint. Successful and expected failed tests return a normalized public payload:

```ts
interface PublicConnectionTestResult {
    success: boolean;
    message: string;
    details?: Record<string, string | number | boolean>;
}
```

Permitted details are service-specific and non-secret, such as provider type, server version, model name, discovered user count, profile count, or root-folder count. Error messages are sanitized before they enter the response. Raw upstream response bodies, URLs containing credentials, headers, tokens, and keys are never returned.

The current `ConnectionResult` state remains the source for latest-known connection status. Running a test replaces that service's previous inline result. Navigating between Settings tabs preserves the result for the current mounted Settings page. A failed test does not clear or rewrite any form value.

Inline states are:

- Testing.
- Connected, with a concise public detail summary where available.
- Failed, with a useful next step.
- Not tested, when no result exists.

Diagnostics consume these latest-known states when supplied by the Settings client. The diagnostics endpoint itself does not contact Plex, Jellyfin, Emby, Sonarr, Radarr, TMDb, an AI provider, Discord, or Telegram.

## Service Guidance

Guidance must match actual application behavior:

- **Plex hosted sign-in:** no manual URL or token is required after authenticated server selection.
- **Plex manual setup:** server URL and Plex token are required.
- **Jellyfin and Emby:** server URL and API key are required.
- **Sonarr and Radarr connection tests:** URL and API key are required. A quality profile and root folder are additionally required before adding content.
- **TMDb:** a custom key is optional while the built-in key is available. The text explains that a custom key overrides the built-in configuration.
- **AI:** provider URL, model, and API key are required only when AI recommendations are enabled, subject to existing provider defaults.
- **Discord:** webhook URL is required when Discord notifications are enabled.
- **Telegram:** bot token and chat ID are required when Telegram notifications are enabled.
- **Scheduler:** a valid cron schedule is required when automatic runs are enabled.

Guidance is descriptive and does not introduce new validation rules beyond the requirements the application already enforces.

## Diagnostics Architecture

### Server module

A focused server-only module owns runtime metadata, database inspection, redaction, and report formatting. It exposes typed operations similar to:

```ts
getRuntimeMetadata(): RuntimeMetadata
getDatabaseDiagnostics(): DatabaseDiagnostics
getAppliedMigrations(): string[]
sanitizeDatabasePath(path: string): string
redactDiagnosticText(value: string): string
buildDiagnosticReport(input: DiagnosticReportInput): string
```

The module must not import client code and must not return the settings table or full configuration object.

### API

`GET /api/diagnostics` returns an allowlisted response containing:

```ts
interface DiagnosticsResponse {
    runtime: {
        appVersion: string;
        gitCommit: string;
        nodeVersion: string;
        platform: string;
    };
    database: {
        reachable: boolean;
        sizeBytes: number | null;
        journalMode: string | null;
        resolvedPath: string;
        sanitizedPath: string;
        appliedMigrations: string[];
    };
    services: Array<{
        name: string;
        configured: boolean;
        latestState: 'connected' | 'failed' | 'testing' | 'not_tested' | 'unknown';
    }>;
    recentErrors: Array<{
        timestamp: string;
        source: string;
        message: string;
    }>;
    report: string;
}
```

The full `resolvedPath` is used only for the local Advanced UI. The `report` uses `sanitizedPath`.

The API does not perform external connection tests. Service state passed from the browser is not trusted as server configuration and is not accepted through GET parameters. The endpoint reports persistent configuration status and uses `not_tested` or `unknown` where no safe latest-known server state exists. The Settings UI may combine this metadata with its in-memory connection results when producing the final copied report, but it may only substitute the public state label, never arbitrary details.

### Runtime metadata

- Application version comes from `package.json`.
- Git commit lookup order is:
  1. Deployment or build environment metadata such as `RECOMENDARR_GIT_COMMIT`, `GIT_COMMIT`, or `VERCEL_GIT_COMMIT_SHA`.
  2. A local `git rev-parse --short HEAD` lookup when Git metadata is available.
  3. `unknown`.
- Commit values are normalized to a short printable identifier and rejected if malformed.

### Database summary

The database summary reports:

- Reachability based on successfully opening/querying the configured database through the existing connection.
- Main database file size from filesystem metadata, formatted for display and retained as bytes in the API.
- Current journal mode from `PRAGMA journal_mode`.
- Applied migration count.
- Applied migration keys.

Migration keys come only from `settings` rows whose key begins with `migration_` and whose value is `true`. Names are sorted ascending deterministically.

### Recent errors

- Include at most the latest 20 `ERROR` log entries.
- Order newest first.
- Include timestamp, source, and sanitized message only.
- Truncate each message to 300 characters after whitespace normalization and redaction.
- Do not include the log `details` field in copied diagnostics.

### Secret exclusion and redaction

The report builder starts with an allowlisted model and never receives credential values. Defense-in-depth redaction also removes common credential-bearing URL components, authorization headers, query parameters, and secret-shaped key/value fragments from log messages.

The copied report must never contain:

- Plex tokens.
- Radarr or Sonarr API keys.
- AI API keys.
- Discord webhook URLs.
- Telegram bot tokens or chat IDs.
- TMDb custom keys.
- Passwords, bearer tokens, session identifiers, or any other stored credential value.

Tests seed distinctive values for every named secret category and assert that neither the structured diagnostic response nor copied report contains them.

The diagnostic database path keeps only a safe suffix:

- Windows example: `C:\\...\\recomendarr.db`
- POSIX example: `/.../recomendarr.db`

## Database Backup

### API behavior

`POST /api/database-backup` performs the complete server-side operation:

1. Resolve the operating-system temporary directory.
2. Generate a collision-resistant temporary filename that is never exposed to the browser.
3. Call `await getDatabase().backup(tempPath)` using `better-sqlite3` v12.6.2.
4. Read the completed database file into memory.
5. Remove the temporary file.
6. Return the bytes with:
   - `Content-Type: application/vnd.sqlite3`
   - `Content-Disposition: attachment; filename="recomendarr-backup-YYYY-MM-DD_HH-mm-ss.db"`
   - `Cache-Control: no-store`

The current in-memory response is acceptable for the expected personal-use database size. Streaming is deferred.

The route uses `try/finally` cleanup so a partially created temporary file is removed when backup, reading, or response construction fails. Cleanup treats an already absent file as success. The route never returns the temporary path, configured database path, WAL file, or SHM file.

The online backup API is the consistency boundary. A raw filesystem copy is prohibited.

### UI behavior

The backup button:

- Disables while a backup is being prepared.
- Requests the backup from the server.
- Reads the attachment filename from the response, falling back to a locally generated safe timestamp.
- Triggers a browser download from the response blob.
- Revokes the temporary browser object URL.
- Shows an inline success result after initiating the download.
- Shows a useful inline failure without exposing a server path or stack trace.

No backup file is retained by the browser code beyond the normal user-initiated download.

## Copy Diagnostics UI

The UI fetches the diagnostics payload when the Advanced section loads or when the user requests a refresh. It combines only approved in-memory connection state labels with the server report fields and copies plain text through the Clipboard API.

The report contains sections for:

- Application.
- Platform.
- Services.
- Scheduler.
- Database.
- Applied migrations.
- Recent errors.

The database section includes output equivalent to:

```text
Database reachable: yes
Database size: 12.4 MB
Journal mode: WAL
Applied migrations: 4
Database path: C:\...\recomendarr.db
```

The action displays `Copying`, `Copied`, or a clear error. Clipboard failure leaves the report available for a retry and does not expose secrets in an error message.

## Error Handling

- Diagnostics return `500` with a generic public error when metadata collection fails completely.
- Partial diagnostic failures use safe nullable values and keep the rest of the response useful.
- Backup failures return a generic public error and log a sanitized internal message.
- Connection tests return `400` for unknown services or malformed settings payloads and a sanitized failure result for expected upstream connection failures.
- No response includes a stack trace or raw upstream error object.

## Testing Strategy

### Unit tests

- Runtime version and Git commit precedence.
- Git fallback and `unknown` behavior.
- Windows and POSIX database path sanitization.
- Migration filtering and deterministic sorting.
- Database size, reachability, and journal-mode summary.
- Twenty-entry error cap, newest-first ordering, whitespace normalization, and 300-character truncation.
- Redaction of every named secret category and credential-bearing URLs.
- Diagnostic report formatting without arbitrary settings data.

### API tests

- Diagnostics response contains only allowlisted fields.
- Diagnostics make no external connection calls.
- Full database path is separate from the sanitized report path.
- Backup response contains a valid SQLite database snapshot.
- Backup headers use a safe timestamped filename.
- Backup does not include or return WAL/SHM paths.
- Temporary backup cleanup occurs after success and failure.
- Connection-test success and failures produce useful sanitized messages.

### UI/model tests

- Inline connection result transitions: idle, testing, success, and failure.
- Failed tests preserve form state.
- Diagnostics copy transitions: idle, copying, copied, and error.
- Backup transitions: idle, preparing, downloaded, and error.
- Service guidance changes correctly for Plex sign-in/manual mode and enabled optional services.

### Playwright verification

- Test results render beneath the correct service without navigating away.
- Entered values remain after a failed test.
- Advanced shows version, commit, full local database path, summary, and sorted migrations.
- Copy diagnostics produces sanitized text and visible success feedback.
- Backup triggers a `.db` download with a safe timestamped name and success feedback.
- Keyboard focus and responsive layouts remain usable.

## Security and Privacy Review

Before completion, inspect diagnostic fixtures and serialized responses for all known test secrets. Search the implementation diff for token, API-key, webhook, authorization, and chat-ID values. Confirm copied diagnostics use only the sanitized path, backup filenames reveal no server directory, and runtime SQLite files are not added to the commit.

## Deferred Work

- Streaming very large backups.
- Scheduled or retained backups.
- Backup restore.
- Configuration export/import.
- Persistent service-health history.
- Background external health probes.
