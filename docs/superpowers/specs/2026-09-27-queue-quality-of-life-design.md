# Queue Quality-of-Life Design

## Purpose

This milestone makes the recommendation Queue efficient to search and triage as it grows. It adds server-side search and sorting, persistent Queue preferences, contextual empty states, optimistic actions with state-preserving Undo, and bulk selection and actions. Library behavior is unchanged except where shared query infrastructure can be reused without changing its UI.

## Scope

The milestone includes:

- Queue search across the complete matching dataset rather than only loaded pages.
- Queue sorting before pagination.
- Browser-persisted Queue status filter and sort preference.
- Contextual loading and empty states.
- Optimistic single-item queue actions.
- Eight-second Undo for reversible status actions.
- Bulk selection and bulk Add, Not now, Reject, Already watched, and Return to queue.
- Same-media-type enforcement for Bulk Add.

It does not include undoing Radarr/Sonarr additions, cross-device preference synchronization, Library bulk actions, or a permanent action-history system.

## Server-side Queue queries

`GET /api/recommendations` accepts the existing `status`, `limit`, and `offset` parameters plus:

- `search`: free-form text.
- `sort`: `newest`, `oldest`, `rating`, `title`, or `source`.

Search is trimmed. Missing, non-string, or whitespace-only search behaves as no search. Matching is case-insensitive and covers:

- `title`
- `overview`
- `ai_reasoning`
- `feedback_reason`
- `feedback_notes`

SQLite applies status filtering, search, and sorting before `LIMIT` and `OFFSET`. Search values are bound parameters and wildcard characters supplied by users are escaped so they behave as literal characters.

Sort behavior is deterministic:

- `newest`: `created_at DESC`, then `id ASC`.
- `oldest`: `created_at ASC`, then `id ASC`.
- `rating`: populated `vote_average` values first, descending, then `created_at DESC`, then `id ASC`.
- `title`: case-insensitive title ascending, then year ascending, then `id ASC`.
- `source`: source ascending, then `created_at DESC`, then `id ASC`.

The route validates all query inputs:

- Unknown `sort` values use `newest`.
- `limit` must be an integer from 1 through 100 and otherwise defaults to 50.
- `offset` must be a non-negative integer and otherwise defaults to 0.
- Unknown statuses are discarded. If a status parameter is present but contains no valid statuses, the response is an empty result rather than silently returning every status.

Counts remain global counts by status, independent of search and pagination. The response also includes a `matchingCount` for the validated status/search query so the UI can distinguish no matches from an unloaded page.

## Queue preferences

The Queue persists only:

- Selected Queue status filter.
- Selected sort order.

Preferences use a versioned local-storage key and are validated before use. Missing, malformed, or unsupported stored values fall back to `all` and `newest`. Library has its own non-persisted state and cannot overwrite Queue preferences.

Search text is never persisted. It is owned by the Queue workspace and resets when the user leaves Queue, including navigation to Library and back.

Changing status, search, or sort resets pagination to the first page and cancels or ignores stale in-flight results so an older request cannot replace the newest query.

## Contextual Queue states

The Queue uses status counts, `matchingCount`, engine state available to the page, and the active query to choose copy:

- Initial loading: recommendations are being loaded.
- No recommendations exist: invite the user to run the engine.
- Search has no match: show the query and offer to clear it.
- Pending is empty while Not now contains items: explain that recommendations are snoozed.
- A specific status is empty: name that status and suggest the relevant next action.
- All active is empty but watched/rejected/added history exists: explain that triage is complete.
- Pagination returns no additional items: keep the existing end-of-list treatment without replacing the current list.

Empty-state selection is implemented as a pure function so each branch is directly testable.

## Optimistic single-item actions

The browser applies reversible actions to its current Queue state immediately, updates visible counts, and moves selection to the next appropriate item. It then sends the mutation request.

If the request fails, the browser restores the exact captured recommendation and counts, then shows an error. A full collection refresh is used only when reconciliation is necessary; routine successful actions do not block on reloading the entire collection.

Undo is offered for eight seconds after:

- Not now
- Reject
- Already watched
- Return to queue

Each optimistic action captures the complete prior recommendation object, including status and relevant state such as:

- `snoozedUntil`
- `feedbackReason`
- `feedbackNotes`
- `feedbackAt`
- timestamps and any other fields returned by the API

Undo sends that captured state to a dedicated restore operation. The request also includes the `updatedAt` produced by the action being undone as its optimistic-concurrency precondition. The server restores all supported mutable fields only when the row still has that exact `updated_at` value, and performs the comparison and update in one database transaction. A mismatch returns HTTP 409 without modifying the row because a newer action has superseded the undo target. The UI only reports Undo success after the server accepts it. On a conflict or other Undo failure, the Queue reloads from the server and reports that newer state was preserved.

Only the most recent reversible action or batch has an active Undo toast. Starting another reversible action dismisses the prior Undo opportunity.

Reject continues to require explicit feedback. The optimistic mutation begins only after the feedback modal is submitted successfully enough to construct the request.

Add has no Undo because an external Radarr or Sonarr side effect cannot be safely reversed by restoring the recommendation row.

## Shared mutation business rules

Single and bulk actions call shared server-side business functions rather than maintaining separate SQL implementations:

- Not now uses the existing seven-day snooze calculation, clears feedback, and remains learning-neutral.
- Reject records the supplied rejection reason, notes, and feedback timestamp exactly as the single action does.
- Already watched clears rejection/snooze state, persists the watched signal, and contributes the same positive learning signal as the single action.
- Return to queue sets Pending and clears snooze and feedback fields using the existing transition rules.

The same functions serve the existing single-item API branches and the new bulk branches. This prevents bulk behavior from drifting from Not now, Watched, rejection, or feedback-profile behavior.

Watched learning behavior is intentionally unchanged in this milestone. Roadmap note: `watched` may later be separated from positive preference signals because consumption does not necessarily imply liking.

## Bulk selection

Queue cards include selection checkboxes without changing the existing click-to-inspect behavior. The toolbar supports:

- Select all visible results.
- Clear selection.
- A selected-item count.

Selection contains recommendation IDs and is pruned whenever query results change. “Select all visible” applies only to currently loaded results; it never implies every row in the database.

Available actions depend on the selection and current filter:

- **Add:** all selected recommendations must have the same media type and must be eligible to add.
- **Not now:** uses the same fixed seven-day duration and neutral semantics as single-item Not now.
- **Reject:** opens one feedback form whose reason and optional notes apply to every selected item.
- **Already watched:** uses the same watched transition and learning behavior as the single-item action.
- **Return to queue:** applies to selected Not now, Rejected, or Watched items.

Bulk Add is disabled for mixed movie/series selections. The toolbar displays: “Bulk Add requires selecting only movies or only series.” It is also disabled when any selected row is not eligible for Add, with specific explanatory copy.

## Bulk API behavior

`PATCH /api/recommendations` gains a bulk request form with `ids` and one supported action. IDs are trimmed, de-duplicated, bounded to 100 items, and validated before mutation.

Database-only bulk actions execute in one SQLite transaction. Validation happens before mutation. If one requested row is missing or ineligible, the request fails without changing any row.

Bulk Add is intentionally different because each item can create an external Arr side effect:

- The client supplies one media type, quality profile, root folder, and search preference for the batch.
- The server verifies every selected recommendation has that media type before starting.
- Items are processed individually through the existing add workflow.
- Processing continues after an individual failure.
- The response contains one result per ID plus totals for added, failed, and unchanged items.
- Successful items move to Added immediately; failed items retain their prior state.

The UI optimistically handles database-only bulk actions. Bulk Add shows progress and applies the returned itemized results rather than assuming complete success.

## API response and client state

Mutation responses return the updated recommendation rows needed to reconcile optimistic state. Bulk responses return updates in request order. No client reconstructs feedback timestamps or snooze expiry when the authoritative value is available from the server.

The page-level collection state owns optimistic updates because it also owns pagination and counts. The workspace owns presentation state: search text, selection, and sort controls. Shared pure helpers calculate optimistic collection changes, count deltas, selection eligibility, persistence parsing, and empty-state copy.

## Error handling and concurrency

- Search requests use an abort signal or monotonically increasing request identity so stale responses are ignored.
- Action controls are disabled for IDs with an active mutation.
- A batch cannot start while another batch is active.
- Individual failures restore their exact snapshots.
- Bulk transactional failures restore the complete captured batch.
- Bulk Add reports partial outcomes without rolling back successful external additions.
- Refreshing during the eight-second Undo window loses the client-side Undo opportunity but does not corrupt database state.

## Accessibility and responsive behavior

- Selection checkboxes have title-specific accessible labels.
- Bulk controls are keyboard reachable and remain visible above the Queue list.
- Disabled Bulk Add includes visible explanatory text rather than relying on a disabled-button tooltip.
- Toast Undo uses a real button and does not rely on color alone.
- On narrow screens, the bulk toolbar wraps without covering recommendation actions.

## Testing

Focused tests cover:

- Case-insensitive, trimmed, escaped search across records beyond the first page.
- Empty or malformed search fallback.
- Every sort order and deterministic pagination.
- Safe validation/defaulting for `sort`, `limit`, `offset`, and statuses.
- Preference persistence parsing, invalid values, and Queue/Library isolation.
- Search reset when Queue unmounts.
- Every contextual empty-state branch.
- Optimistic single and bulk updates, exact rollback, and count changes.
- Undo restoring the complete prior state, including snooze and feedback fields.
- Undo refusing stale restores with HTTP 409 when `updatedAt` has changed, followed by client reconciliation.
- Eight-second Undo replacement/expiry behavior.
- Mixed-media Bulk Add disabling and explanation.
- Transactional bulk status operations.
- Seven-day neutral bulk snoozing.
- Bulk Reject, Already watched, and Return to queue reusing single-action business rules.
- Itemized partial-success Bulk Add.
- Existing feedback-profile behavior: Not now remains neutral; Watched and Added remain positive; Rejected remains negative.
- Existing pagination, single actions, Library, and watched-title search behavior.

Before completion, run `npm test`, `npm run lint`, and `npm run build`.
