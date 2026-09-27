# Queue Quality-of-Life Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Queue reliably searchable and sortable across the full database, preserve Queue preferences, improve empty states, and add optimistic single/bulk actions with concurrency-safe Undo.

**Architecture:** SQLite owns validated search, sorting, pagination, counts, and transactional status mutations. The recommendations route exposes normalized query and bulk/restore mutation contracts. Page-level React state owns server queries, optimistic snapshots, counts, and reconciliation; the Queue workspace owns non-persisted search text, persisted filter/sort controls, selection, and contextual presentation.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, SQLite through `better-sqlite3`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-27-queue-quality-of-life-design.md`

## Global Constraints

- Search is case-insensitive, trimmed, parameterized, and applied before pagination.
- Validate `sort`, `limit`, `offset`, statuses, and bulk IDs server-side with the specification's safe defaults and bounds.
- Persist Queue filter and sort in versioned browser storage; never persist search.
- Undo restores the complete previous mutable recommendation state only when the expected current `updatedAt` still matches; stale restore returns HTTP 409 and reconciles from the server.
- Database-only bulk actions reuse single-action business rules and are transactional.
- Bulk Not now uses the existing fixed seven-day snooze semantics.
- Bulk Add permits one media type per batch, remains itemized partial-success, and has no Undo.
- Keep current Watched learning behavior unchanged. Record the roadmap note that consumption may later be separated from positive preference signals.
- Leave Library behavior unchanged except for compatible shared query infrastructure.
- Leave all work uncommitted and unpushed.

## Review Focus

- Literal `%`, `_`, and escape characters in search must not become unintended SQLite wildcards or malformed escape sequences.
- A stale page response must never replace results for a newer filter/search/sort request.
- An Undo submitted after any newer row mutation must return 409 without overwriting newer state.
- Transactional bulk status actions must leave every row unchanged if one ID is missing or ineligible.
- Partial Bulk Add must preserve failed rows and accurately report every item without retrying successful external additions.

---

### Task 1: Validated server-side Queue queries

**Files:**
- Modify: `src/lib/database.ts`
- Modify: `src/app/api/recommendations/route.ts`
- Create: `src/lib/recommendation-query.ts`
- Create: `tests/recommendation-query.test.ts`
- Modify: `tests/recommendation-queue-api.test.ts`

**Interfaces:**
- Produces: `parseRecommendationQuery(searchParams): RecommendationQuery`, `getRecommendations(query)`, and `getMatchingRecommendationCount(query)`.
- Consumes: existing recommendation row mapping and status-count functions.

- [ ] **Step 1: Write failing parser tests**

Cover whitespace-only search, trimmed search, unknown sort, decimal/negative/non-numeric limit and offset, limits above 100, valid boundaries, mixed valid/invalid statuses, and an explicitly empty valid-status result.

- [ ] **Step 2: Run parser tests and verify the missing-module failure**

Run: `npm test -- --run tests/recommendation-query.test.ts`

- [ ] **Step 3: Implement query types and parser**

Define `RecommendationSort = 'newest' | 'oldest' | 'rating' | 'title' | 'source'` and a normalized query carrying statuses, status-filter presence, search, sort, limit, and offset.

- [ ] **Step 4: Write failing database tests for search and sort before pagination**

Seed more rows than one page and assert case-insensitive trimmed matching across all specified columns, literal wildcard handling, deterministic tie-breakers, null ratings last, and all five sort orders.

- [ ] **Step 5: Implement parameterized SQL query construction**

Escape SQLite `LIKE` metacharacters, build only allow-listed `ORDER BY` clauses, apply filtering before pagination, and return a matching count using the same status/search predicate.

- [ ] **Step 6: Write failing route tests for normalized query forwarding and response shape**

Assert `{ recommendations, counts, matchingCount, query }`, safe defaults, and an empty response when an explicit status parameter contains no valid status.

- [ ] **Step 7: Update the GET route and compatibility callers**

Keep counts-only behavior compatible. Update existing direct `getRecommendations` callers or provide a narrow compatibility overload only where needed outside the Queue route.

- [ ] **Step 8: Run Task 1 suites**

Run: `npm test -- --run tests/recommendation-query.test.ts tests/recommendation-queue-api.test.ts tests/database-queue-statuses.test.ts`

### Task 2: Queue preference, request, and empty-state model

**Files:**
- Create: `src/components/app/queue-model.ts`
- Create: `tests/queue-model.test.ts`
- Modify: `src/components/app/models.ts`
- Modify: `src/components/app/recommendations-workspace.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Produces: `parseQueuePreferences`, `saveQueuePreferences`, `getQueueEmptyState`, and page query inputs `{ filter, search, sort }`.
- Consumes: Task 1 query response and existing `RecommendationFilter`.

- [ ] **Step 1: Write failing preference tests**

Cover the versioned storage payload, missing/malformed JSON, invalid filter/sort, valid restoration, and Queue/Library isolation. Use an injected storage interface rather than browser globals.

- [ ] **Step 2: Write failing contextual empty-state tests**

Cover initial loading, no generated recommendations, no search match, snoozed-only pending state, empty named status, completed active triage, and pagination exhaustion.

- [ ] **Step 3: Implement the pure Queue model**

Use exact fallback values `all` and `newest`. Return structured empty-state copy and optional clear-search/run-engine actions.

- [ ] **Step 4: Move search and sort ownership to the page query state**

Remove client-side filtering/sorting of loaded rows. Debounce search input, reset offset/results when query inputs change, and ignore stale requests with `AbortController` or a request sequence.

- [ ] **Step 5: Persist validated Queue filter and sort only**

Initialize browser preferences after mount, update storage on changes, keep Library independent, and remove the Queue component `key` behavior that would defeat controlled search handling.

- [ ] **Step 6: Render contextual states and responsive controls**

Show `matchingCount`, a clear-search action, safe loading behavior, and server-backed sort options for all five orders.

- [ ] **Step 7: Run Task 2 tests**

Run: `npm test -- --run tests/queue-model.test.ts tests/recommendation-query.test.ts`

### Task 3: Shared mutation rules and concurrency-safe restore

**Files:**
- Modify: `src/lib/database.ts`
- Create: `src/lib/recommendation-actions.ts`
- Create: `tests/recommendation-actions.test.ts`
- Modify: `src/app/api/recommendations/route.ts`
- Modify: `tests/recommendation-queue-api.test.ts`
- Add roadmap note to the nearest Watched feedback logic comment in `src/lib/database.ts`

**Interfaces:**
- Produces: `applyRecommendationAction(id, action, options)`, `applyBulkRecommendationAction(ids, action, options)`, and `restoreRecommendationState(id, previous, expectedUpdatedAt)`.
- Consumes: existing seven-day snooze, watched-state synchronization, feedback-profile semantics, and recommendation row mapping.

- [ ] **Step 1: Write failing single-action parity tests**

Assert Not now remains seven days and neutral, Reject writes the same feedback fields, Watched keeps current positive learning and watched-state behavior, and Pending clears snooze/feedback exactly as before.

- [ ] **Step 2: Implement one shared database action path and migrate single PATCH branches**

Return the authoritative updated recommendation row for each mutation. Preserve current public behavior while eliminating duplicated transition logic.

- [ ] **Step 3: Write failing full-state restore tests**

Capture and restore status, `snoozedUntil`, `feedbackReason`, `feedbackNotes`, `feedbackAt`, and supported timestamps. Assert exact restoration when expected current `updatedAt` matches.

- [ ] **Step 4: Write the stale-restore concurrency test**

Mutate the row after the target action, submit the old expected `updatedAt`, assert a typed conflict, HTTP 409 mapping, and no changed columns.

- [ ] **Step 5: Implement transactional optimistic-concurrency restore**

Use a conditional update with `WHERE id = ? AND updated_at = ?` inside a transaction. Distinguish missing row from version conflict and never accept client-provided immutable identity/content fields.

- [ ] **Step 6: Write failing transactional bulk action tests**

Cover de-duplication, 100-ID bound, missing/ineligible rollback, seven-day bulk snooze parity, shared Reject fields, Watched parity, Pending clearing rules, response ordering, and unchanged feedback-profile behavior.

- [ ] **Step 7: Implement bulk validation and transactional database actions**

Validate all rows before mutation, reuse the same action function inside one SQLite transaction, and return authoritative rows in request order.

- [ ] **Step 8: Extend PATCH route contracts**

Accept either `id` or `ids`, explicit `restore` with `previous` and `expectedUpdatedAt`, return 409 for version conflicts, and reject malformed/oversized batches with 400.

- [ ] **Step 9: Run Task 3 suites**

Run: `npm test -- --run tests/recommendation-actions.test.ts tests/recommendation-queue-api.test.ts tests/database-queue-statuses.test.ts`

### Task 4: Optimistic single actions and Undo

**Files:**
- Create: `src/components/app/queue-optimistic.ts`
- Create: `tests/queue-optimistic.test.ts`
- Modify: `src/app/page.tsx`
- Modify: `src/components/app/recommendations-workspace.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Produces: pure collection/count mutation helpers and an `UndoEntry` containing previous rows plus expected post-action `updatedAt` values.
- Consumes: Task 3 authoritative mutation/restore responses and Task 2 query state.

- [ ] **Step 1: Write failing optimistic-state tests**

Cover visible-row removal, status-filter retention, count deltas, next selection, exact rollback, and preservation of every prior recommendation field.

- [ ] **Step 2: Implement pure optimistic helpers**

Never synthesize server timestamps for final state. Use temporary optimistic values only until authoritative rows arrive, then replace them.

- [ ] **Step 3: Write failing Undo lifecycle tests**

Use fake timers to cover the eight-second window, replacement by a newer action, dismissal, successful restore, HTTP 409 reconciliation, and general failure reconciliation.

- [ ] **Step 4: Integrate optimistic single actions**

Apply local changes before awaiting PATCH, disable the active ID, replace with authoritative response on success, and restore the snapshot on initial-action failure.

- [ ] **Step 5: Add actionable Undo toast**

Store one active Undo entry, render an accessible button, submit complete previous mutable state with the authoritative post-action `updatedAt`, and reload the current query on conflict.

- [ ] **Step 6: Run Task 4 tests**

Run: `npm test -- --run tests/queue-optimistic.test.ts tests/recommendation-queue-api.test.ts`

### Task 5: Bulk selection and database-only bulk actions

**Files:**
- Modify: `src/components/app/queue-model.ts`
- Modify: `tests/queue-model.test.ts`
- Modify: `src/components/app/recommendations-workspace.tsx`
- Modify: `src/components/app/recommendation-detail.tsx`
- Modify: `src/components/app/feedback-modal.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Produces: visible selection controls, selection eligibility, bulk database-action handlers, and batch Undo entries.
- Consumes: Task 3 bulk API and Task 4 optimistic/Undo helpers.

- [ ] **Step 1: Write failing selection and eligibility tests**

Cover select-all-visible, query-result pruning, clear selection, same-type Bulk Add eligibility, mixed-type explanation text, ineligible status explanation, and contextual Return to queue.

- [ ] **Step 2: Implement checkbox selection and responsive toolbar**

Keep checkbox clicks from changing detail selection, provide title-specific labels, and disable controls during mutations.

- [ ] **Step 3: Integrate bulk Not now, Watched, and Return to queue**

Apply one optimistic batch snapshot, submit one transactional request, reconcile authoritative rows, and offer one batch Undo using each row's post-action `updatedAt`.

- [ ] **Step 4: Extend Reject feedback flow for a selected batch**

Apply one reason/note to all selected rows through the shared bulk route and preserve the exact batch for rollback/Undo.

- [ ] **Step 5: Run Task 5 tests**

Run: `npm test -- --run tests/queue-model.test.ts tests/queue-optimistic.test.ts tests/recommendation-actions.test.ts`

### Task 6: Same-media-type partial-success Bulk Add

**Files:**
- Modify: `src/lib/engine.ts`
- Create: `tests/recommendation-bulk-add.test.ts`
- Modify: `src/app/api/recommendations/route.ts`
- Modify: `src/components/app/add-to-library-modal.tsx`
- Modify: `src/components/app/recommendations-workspace.tsx`
- Modify: `src/app/page.tsx`

**Interfaces:**
- Produces: `approveAndAddMany(ids, options)` with ordered item results and `{ added, failed, unchanged }` totals.
- Consumes: existing `approveAndAdd`, Arr profile/root-folder discovery, and Task 5 selection eligibility.

- [ ] **Step 1: Write failing Bulk Add service tests**

Cover same-type validation before side effects, duplicate IDs, continuation after failure, ordered item results, correct totals, successful status updates, and preservation of failed rows.

- [ ] **Step 2: Implement `approveAndAddMany` by reusing the single-item workflow**

Validate every row's media type first, then process sequentially to avoid flooding Arr and to keep outcome ordering deterministic.

- [ ] **Step 3: Add the bulk-add PATCH contract and route tests**

Require one profile/root-folder/search option set, reject mixed selections with 400, and return the itemized partial-success response.

- [ ] **Step 4: Adapt the Add modal for one or many same-type recommendations**

Show selected count and media type, retain existing single Add behavior, and display progress while the batch is processed.

- [ ] **Step 5: Reconcile itemized results in the Queue**

Remove successful Added rows from active Queue views, retain failed rows, clear successful selections, and show concise totals with expandable item errors. Do not offer Undo.

- [ ] **Step 6: Run Task 6 suites**

Run: `npm test -- --run tests/recommendation-bulk-add.test.ts tests/recommendation-queue-api.test.ts tests/engine.integration.test.ts`

### Task 7: Full regression and security verification

**Files:**
- Modify only files required to fix failures caused by Tasks 1–6.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: the complete uncommitted Queue QoL milestone.

- [ ] **Step 1: Run all focused Queue suites**

Run: `npm test -- --run tests/recommendation-query.test.ts tests/queue-model.test.ts tests/recommendation-actions.test.ts tests/queue-optimistic.test.ts tests/recommendation-bulk-add.test.ts tests/recommendation-queue-api.test.ts tests/database-queue-statuses.test.ts tests/engine.integration.test.ts`

- [ ] **Step 2: Run the full test suite**

Run: `npm test`

- [ ] **Step 3: Run lint**

Run: `npm run lint`

- [ ] **Step 4: Run the production build**

Run: `npm run build`

- [ ] **Step 5: Review scope and failure cases**

Run `git diff --check`; inspect the complete diff for SQL interpolation, stale-request races, restore fields, 409 behavior, bulk transaction boundaries, partial Add accounting, Watched learning drift, accidental Library changes, and runtime database artifacts.

- [ ] **Step 6: Leave all work uncommitted and unpushed**

Report changed files, tests, verification results, any rulings/deferred minors, and confirm Git was not mutated beyond the working tree.
