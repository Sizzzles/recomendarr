# Plex Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Plex-hosted PIN sign-in that discovers and connects an available Plex Media Server while retaining manual URL/token setup.

**Architecture:** A focused server-side Plex auth module owns PIN creation, polling, resource discovery, connection ordering, and pending secret state. One Next.js API route exposes action-based start, poll, select, and disconnect operations without returning tokens; a reusable React component integrates those operations into setup and Settings. Existing media-server configuration remains the final storage and connector interface.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Axios, SQLite settings through `better-sqlite3`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-27-plex-sign-in-design.md`

## Global Constraints

- Use Plex's strong PIN flow and a stable installation-specific `X-Plex-Client-Identifier`.
- Never return or log Plex account/server tokens, and do not embed tokens in browser-visible poster URLs.
- Keep existing manual Plex URL/token configuration as an advanced fallback.
- Leave Jellyfin, Emby, recommendation, Not now, Watched, Seerr, and watchlist behavior unchanged.
- Do not add a Plex username/password flow or Plex Home managed-user switching.

## Review Focus

- A claimed PIN with no usable server resource must return a useful no-server error without exposing its account token.
- A server with several local, remote, HTTP, HTTPS, and relay connections must be ordered deterministically and validated before saving.
- Polling with an unknown, expired, completed, or malformed flow identifier must fail safely and require a fresh sign-in.
- Disconnect must clear only Plex connection/display settings and preserve unrelated configuration.
- Existing manually configured Plex users must retain a working connection and be able to avoid Plex sign-in entirely.

---

### Task 1: Plex authentication client and pending-flow store

**Files:**
- Create: `src/lib/plex-auth.ts`
- Create: `tests/plex-auth.test.ts`
- Modify: `src/lib/config.ts`

**Interfaces:**
- Produces: `startPlexSignIn()`, `pollPlexSignIn(flowId)`, `selectPlexServer(flowId, serverId)`, `disconnectPlex()`, and normalized public Plex sign-in/server-choice types.
- Consumes: existing `saveSetting`, `saveSettings`, and `getAllSavedSettings` configuration helpers.

- [ ] **Step 1: Write failing tests for stable client identifier and strong PIN creation**

Assert that a missing identifier is generated and persisted once, reused thereafter, and sent with `X-Plex-Product: Recomendarr`; assert the start result contains an opaque flow ID and Plex authorization URL but no token.

- [ ] **Step 2: Run the focused test and verify failure because `src/lib/plex-auth.ts` does not exist**

Run: `npm test -- --run tests/plex-auth.test.ts`

- [ ] **Step 3: Implement client metadata, pending-flow storage, and `startPlexSignIn()`**

Use an injectable Axios-like client for tests, a UUID installation identifier persisted as `plex_client_identifier`, and an opaque UUID flow identifier stored only in an expiring in-memory map.

- [ ] **Step 4: Write failing tests for pending, claimed, expired, malformed, and upstream-error polling**

Assert claimed responses normalize server choices without exposing account/resource tokens, skip resources with no access token, and return a no-server result when appropriate.

- [ ] **Step 5: Implement `pollPlexSignIn(flowId)` and resource normalization**

Request Plex resources only after the PIN contains an auth token. Retain secrets solely inside the pending server-side record.

- [ ] **Step 6: Write failing tests for deterministic connection ordering, validation, save, and disconnect**

Cover local HTTPS, remote HTTPS, local HTTP, remote HTTP, relay fallback, invalid `MediaContainer`, preservation of unrelated settings, and the absence of tokens from results and error strings.

- [ ] **Step 7: Implement `selectPlexServer()` and `disconnectPlex()`**

Validate connection candidates in order and persist `media_server_type`, `media_server_url`, `media_server_api_key`, `plex_server_identifier`, `plex_server_name`, and optional `plex_account_name`. Delete the completed pending flow. Add a focused configuration helper that removes Plex keys transactionally without affecting other settings.

- [ ] **Step 8: Run the focused tests until they pass**

Run: `npm test -- --run tests/plex-auth.test.ts`

### Task 2: Plex authentication, settings, and poster API routes

**Files:**
- Create: `src/app/api/plex-auth/route.ts`
- Create: `src/app/api/plex-poster/route.ts`
- Create: `tests/plex-auth-api.test.ts`
- Create: `tests/settings-api.test.ts`
- Modify: `src/app/api/settings/route.ts`
- Modify: `src/lib/media-server.ts`
- Modify: `tests/media-server.test.ts`

**Interfaces:**
- Consumes: Task 1 Plex auth functions and existing media-server configuration.
- Produces: action-based `POST /api/plex-auth`, `GET /api/plex-auth` connection state, and authenticated `GET /api/plex-poster?path=...` image proxy.

- [ ] **Step 1: Write failing API tests for start, poll, select, disconnect, validation, and secret redaction**

Assert malformed actions return 400, known failures return useful status codes, successful selection returns only public connection metadata, and serialized response bodies contain no test token values.

- [ ] **Step 2: Run the API test and verify expected missing-route failures**

Run: `npm test -- --run tests/plex-auth-api.test.ts`

- [ ] **Step 3: Implement the Plex auth route**

Dispatch explicit `start`, `poll`, `select`, and `disconnect` actions with validated strings. Return the stored public connection state from GET without reading secrets into its response.

- [ ] **Step 4: Write a failing settings API test proving the stored Plex token is masked and preserved**

Assert GET does not include the full Plex token in either `config` or `raw`, and PUT treats the returned masked placeholder as unchanged rather than overwriting the stored token.

- [ ] **Step 5: Implement Plex-token masking and unchanged-secret handling in the settings route**

Keep the final four-character display already used by the API, replace `raw.media_server_api_key` with that masked value, and remove that key from a PUT before saving when it is the unchanged mask. A newly typed manual token remains saveable.

- [ ] **Step 6: Write a failing media-server test proving Plex poster URLs contain no token**

Assert watched Plex items use a relative `/api/plex-poster` URL containing only a validated Plex image path.

- [ ] **Step 7: Implement the poster proxy and change Plex watched-item mapping**

Accept only relative Plex paths beginning with `/`, reject external URLs and traversal, request the image server-side with the configured `X-Plex-Token`, and forward the image body/content type with private no-store caching.

- [ ] **Step 8: Run all focused route and connector suites until they pass**

Run: `npm test -- --run tests/plex-auth-api.test.ts tests/settings-api.test.ts tests/media-server.test.ts`

### Task 3: Reusable Plex sign-in UI

**Files:**
- Create: `src/components/app/plex-sign-in.tsx`
- Create: `src/components/app/plex-sign-in-model.ts`
- Create: `tests/plex-sign-in-model.test.ts`
- Modify: `src/components/app/models.ts`
- Modify: `src/components/app/settings-page.tsx`
- Modify: `src/components/app/setup-wizard.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: Task 2 public Plex auth API contracts.
- Produces: reusable `PlexSignIn` component with callbacks that update the existing settings form after selection or disconnect.

- [ ] **Step 1: Write failing model tests for idle, opening, polling, server-selection, connected, expired, and error transitions**

Assert a single discovered server proceeds to selection automatically, multiple servers require a choice, expiry restores a retryable state, and errors never incorporate secret-shaped response properties.

- [ ] **Step 2: Run the model test and verify failure because the model does not exist**

Run: `npm test -- --run tests/plex-sign-in-model.test.ts`

- [ ] **Step 3: Implement the UI state model and public TypeScript types**

Keep polling state transitions pure so they can be tested without a browser DOM dependency.

- [ ] **Step 4: Implement the reusable Plex sign-in component**

Open the hosted auth URL, poll at a bounded interval until claimed/expired, show a server chooser when needed, and provide reconnect/disconnect actions. Cancel timers and outstanding polling when unmounted or restarted.

- [ ] **Step 5: Integrate the component into Settings and setup**

Show it only for Plex. Put existing URL/token fields behind **Advanced manual setup** and preserve their values and save/test paths. Reflect a selected server back into `media_server_url` and a non-secret connected indicator without placing its token in React state.

- [ ] **Step 6: Add focused styles and run model tests**

Run: `npm test -- --run tests/plex-sign-in-model.test.ts`

### Task 4: Regression verification and feature commit

**Files:**
- Modify only files required to fix failures caused by Tasks 1–3.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a verified Plex sign-in feature on the current branch.

- [ ] **Step 1: Run focused Plex tests**

Run: `npm test -- --run tests/plex-auth.test.ts tests/plex-auth-api.test.ts tests/settings-api.test.ts tests/plex-sign-in-model.test.ts tests/media-server.test.ts`

- [ ] **Step 2: Run the full test suite**

Run: `npm test`

- [ ] **Step 3: Run lint**

Run: `npm run lint`

- [ ] **Step 4: Run the production build**

Run: `npm run build`

- [ ] **Step 5: Review secrets and scope**

Search the diff for token-bearing JSON responses, query-string `X-Plex-Token`, unrelated Jellyfin/Emby changes, and accidental database/runtime artifacts. Run `git diff --check`.

- [ ] **Step 6: Commit the verified implementation**

Commit message: `feat: add Plex sign-in`
