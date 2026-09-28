'use client';

import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { FeedbackProfile, Recommendation } from '@/lib/types';
import type { Counts, RecommendationFilter } from './models';
import type { RecommendationSort } from '../../lib/recommendation-query';
import { getBulkAddEligibility, getQueueEmptyState, pruneSelection, selectAllVisible } from './queue-model';
import { RecommendationDetail } from './recommendation-detail';
import { formatFeedbackReason, getLearningHighlights, getRecommendationSignals } from './utils';
import { getDialogFocusWrapTarget, getScrollLockPadding, QUEUE_DETAIL_OVERLAY_BREAKPOINT } from './queue-responsive';

interface RecommendationsWorkspaceProps {
    recs: Recommendation[];
    counts: Counts;
    filter: RecommendationFilter;
    setFilter: (value: RecommendationFilter) => void;
    feedbackProfile: FeedbackProfile;
    loading: boolean;
    listLoading: boolean;
    loadingMore: boolean;
    hasMore: boolean;
    onLoadMore: () => void;
    onAction: (id: string, action: string) => void;
    onAddWatched: () => void;
    mode: 'queue' | 'library';
    search?: string;
    sort?: RecommendationSort;
    matchingCount?: number;
    onSearchChange?: (value: string) => void;
    onSortChange?: (value: RecommendationSort) => void;
    onBulkAction?: (ids: string[], action: 'not_now' | 'watched' | 'pending' | 'reject') => void;
    onBulkAdd?: (recommendations: Recommendation[]) => void;
    mutatingIds?: Set<string>;
    mutationBusy?: boolean;
}

export function RecommendationsWorkspace({
    recs,
    counts,
    filter,
    setFilter,
    feedbackProfile,
    loading,
    listLoading,
    loadingMore,
    hasMore,
    onLoadMore,
    onAction,
    onAddWatched,
    mode,
    search,
    sort,
    matchingCount = recs.length,
    onSearchChange,
    onSortChange,
    onBulkAction,
    onBulkAdd,
    mutatingIds = new Set(),
    mutationBusy = false,
}: RecommendationsWorkspaceProps) {
    const [librarySearch, setLibrarySearch] = useState('');
    const [librarySort, setLibrarySort] = useState<'newest' | 'rating'>('newest');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [usesDetailOverlay, setUsesDetailOverlay] = useState(false);
    const [detailOverlayOpen, setDetailOverlayOpen] = useState(false);
    const deferredQuery = useDeferredValue(librarySearch);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const detailDialogRef = useRef<HTMLDialogElement | null>(null);
    const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
    const queueCount = counts.pending + counts.rejected;
    const isQueueMode = mode === 'queue';

    useEffect(() => {
        if (!isQueueMode) return;
        const mediaQuery = window.matchMedia(`(max-width: ${QUEUE_DETAIL_OVERLAY_BREAKPOINT - 1}px)`);
        const updateLayout = () => setUsesDetailOverlay(mediaQuery.matches);
        updateLayout();
        mediaQuery.addEventListener('change', updateLayout);
        return () => mediaQuery.removeEventListener('change', updateLayout);
    }, [isQueueMode]);

    useEffect(() => {
        const dialog = detailDialogRef.current;
        if (!dialog) return;

        if (!usesDetailOverlay || !detailOverlayOpen) {
            if (dialog.open) dialog.close();
            return;
        }

        const previousOverflow = document.body.style.overflow;
        const previousPaddingRight = document.body.style.paddingRight;
        const appMain = document.querySelector<HTMLElement>('.app-main');
        const previousMainOverflow = appMain?.style.overflowY || '';
        const compensation = getScrollLockPadding(window.innerWidth, document.documentElement.clientWidth);
        const currentPadding = Number.parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
        document.body.style.overflow = 'hidden';
        if (appMain) appMain.style.overflowY = 'hidden';
        if (compensation > 0) document.body.style.paddingRight = `${currentPadding + compensation}px`;
        if (!dialog.open) dialog.showModal();

        return () => {
            document.body.style.overflow = previousOverflow;
            document.body.style.paddingRight = previousPaddingRight;
            if (appMain) appMain.style.overflowY = previousMainOverflow;
        };
    }, [detailOverlayOpen, usesDetailOverlay]);

    const closeDetailOverlay = () => {
        setDetailOverlayOpen(false);
        window.requestAnimationFrame(() => detailTriggerRef.current?.focus());
    };

    const containDialogFocus = (event: KeyboardEvent<HTMLDialogElement>) => {
        if (event.key !== 'Tab') return;
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter((element) => !element.hasAttribute('hidden'));
        const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
        const targetIndex = getDialogFocusWrapTarget(currentIndex, focusable.length, event.shiftKey);
        if (targetIndex === null) return;
        event.preventDefault();
        focusable[targetIndex]?.focus();
    };

    const filteredRecs = useMemo(() => {
        if (isQueueMode) return recs;
        return recs
            .filter((rec) => {
                if (!deferredQuery) return true;
                const query = deferredQuery.toLowerCase();
                return (
                    rec.title.toLowerCase().includes(query) ||
                    (rec.aiReasoning || '').toLowerCase().includes(query) ||
                    (rec.overview || '').toLowerCase().includes(query) ||
                    formatFeedbackReason(rec.feedbackReason).toLowerCase().includes(query) ||
                    (rec.feedbackNotes || '').toLowerCase().includes(query)
                );
            })
            .sort((a, b) => {
                if (librarySort === 'rating') return (b.voteAverage || 0) - (a.voteAverage || 0);
                return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
            });
    }, [deferredQuery, isQueueMode, librarySort, recs]);

    useEffect(() => {
        if (!hasMore || loadingMore || listLoading) {
            return;
        }

        const root = scrollRef.current;
        const target = sentinelRef.current;
        if (!root || !target) {
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    onLoadMore();
                }
            },
            {
                root,
                rootMargin: '0px 0px 220px 0px',
                threshold: 0.1,
            }
        );

        observer.observe(target);
        return () => observer.disconnect();
    }, [filteredRecs.length, hasMore, listLoading, loadingMore, onLoadMore]);

    const resolvedSelectedId = filteredRecs.some((rec) => rec.id === selectedId)
        ? selectedId
        : (filteredRecs[0]?.id || null);

    const selectedRecommendation = filteredRecs.find((rec) => rec.id === resolvedSelectedId) || null;
    const selectedRecommendations = filteredRecs.filter(rec => rec.id && selectedIds.has(rec.id));
    const addEligibility = getBulkAddEligibility(selectedRecommendations);

    useEffect(() => {
        setSelectedIds(current => pruneSelection(current, filteredRecs));
    }, [filteredRecs]);
    const emptyState = isQueueMode ? getQueueEmptyState({
        loading: listLoading,
        search: search || '',
        filter,
        matchingCount,
        counts,
        hasMore,
    }) : null;

    const copy = isQueueMode
        ? {
            kicker: 'Triage Workspace',
            title: 'Recommendations',
            description: 'Review the active queue in one place, inspect the rationale, and feed the engine better signals.',
            listTitle: `${filteredRecs.length} titles ready for review`,
            emptyIcon: 'Queue',
            emptyTitle: 'No recommendations in this view',
            emptyDescription: 'Try a different status filter or run the engine again to refill the queue.',
            detailEmpty: {
                kicker: 'Triage Workspace',
                title: 'Select a recommendation',
                description: 'Pick a title from the queue to inspect the recommendation rationale, watch the trailer, and approve or reject it.',
            },
            searchPlaceholder: 'Search queue titles, explanations, or feedback...',
            footerDone: 'You have reached the end of the triage queue.',
        }
        : {
            kicker: 'Library Intake',
            title: 'Added Titles',
            description: 'Keep library sends separate from triage so the recommendation queue stays clean and reviewable.',
            listTitle: `${filteredRecs.length} titles already moved into your library workflow`,
            emptyIcon: 'Library',
            emptyTitle: 'No added titles yet',
            emptyDescription: 'Approve a recommendation and it will move here once it is sent to Sonarr or Radarr.',
            detailEmpty: {
                kicker: 'Library Intake',
                title: 'Select an added title',
                description: 'Pick a title to inspect why it was added, review the trailer, and confirm the recommendation context.',
            },
            searchPlaceholder: 'Search added titles, notes, or reasoning...',
            footerDone: 'You have reached the end of the added-title history.',
        };

    return (
        <div className="page-stack">
            <div className="page-header refined">
                <div>
                    <p className="page-kicker">{copy.kicker}</p>
                    <h2>{copy.title}</h2>
                    <p>{copy.description}</p>
                </div>
                {isQueueMode && filter === 'watched' && (
                    <button type="button" className="btn btn-primary" onClick={onAddWatched}>
                        Add watched title
                    </button>
                )}
            </div>

            {isQueueMode && selectedIds.size > 0 && (
                <div className="bulk-toolbar" aria-label="Bulk recommendation actions">
                    <strong>{selectedIds.size} selected</strong>
                    <button type="button" className="btn btn-ghost" disabled={mutationBusy} onClick={() => setSelectedIds(selectAllVisible(filteredRecs))}>Select all visible</button>
                    <button type="button" className="btn btn-ghost" disabled={mutationBusy} onClick={() => setSelectedIds(new Set())}>Clear</button>
                    <button type="button" className="btn btn-success" disabled={mutationBusy || !addEligibility.allowed} onClick={() => onBulkAdd?.(selectedRecommendations)}>Add</button>
                    <button type="button" className="btn btn-ghost" disabled={mutationBusy} onClick={() => onBulkAction?.(Array.from(selectedIds), 'not_now')}>Not now</button>
                    <button type="button" className="btn btn-ghost" disabled={mutationBusy} onClick={() => onBulkAction?.(Array.from(selectedIds), 'watched')}>Already watched</button>
                    <button type="button" className="btn btn-danger" disabled={mutationBusy} onClick={() => onBulkAction?.(Array.from(selectedIds), 'reject')}>Reject</button>
                    {selectedRecommendations.every(rec => ['not_now', 'rejected', 'watched'].includes(rec.status)) && (
                        <button type="button" className="btn btn-ghost" disabled={mutationBusy} onClick={() => onBulkAction?.(Array.from(selectedIds), 'pending')}>Return to queue</button>
                    )}
                    {!addEligibility.allowed && <span className="bulk-explanation">{addEligibility.reason}</span>}
                </div>
            )}

            <div className="filter-shell">
                {isQueueMode && (
                    <div className="filter-tabs wide">
                        {[
                            { key: 'all', label: `All active (${queueCount})` },
                            { key: 'pending', label: `Pending (${counts.pending})` },
                            { key: 'not_now', label: `Not now (${counts.not_now})` },
                            { key: 'watched', label: `Watched (${counts.watched})` },
                            { key: 'rejected', label: `Rejected (${counts.rejected})` },
                        ].map((tab) => (
                            <button
                                key={tab.key}
                                className={`filter-tab ${filter === tab.key ? 'active' : ''}`}
                                onClick={() => setFilter(tab.key as RecommendationFilter)}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>
                )}

                <div className="workspace-controls">
                    <input
                        type="text"
                        className="workspace-search"
                        placeholder={isQueueMode && usesDetailOverlay ? 'Search Queue...' : copy.searchPlaceholder}
                        value={isQueueMode ? (search || '') : librarySearch}
                        onChange={(event) => isQueueMode ? onSearchChange?.(event.target.value) : setLibrarySearch(event.target.value)}
                    />
                    <select
                        aria-label={isQueueMode ? 'Sort recommendations' : 'Sort library titles'}
                        value={isQueueMode ? (sort || 'newest') : librarySort}
                        onChange={(event) => isQueueMode
                            ? onSortChange?.(event.target.value as RecommendationSort)
                            : setLibrarySort(event.target.value as 'newest' | 'rating')}
                    >
                        <option value="newest">Newest first</option>
                        {isQueueMode && <option value="oldest">Oldest first</option>}
                        <option value="rating">Highest rated</option>
                        {isQueueMode && <option value="title">Title A–Z</option>}
                        {isQueueMode && <option value="source">Source</option>}
                    </select>
                </div>
            </div>

            {listLoading && recs.length === 0 ? (
                <div className="empty-state refined">
                    <div className="spinner spinner-lg" />
                    <h3>Loading titles</h3>
                    <p>Fetching the next slice of recommendations from the queue.</p>
                </div>
            ) : filteredRecs.length === 0 ? (
                <div className="empty-state refined">
                    <div className="empty-icon">{copy.emptyIcon}</div>
                    <h3>{emptyState?.title || copy.emptyTitle}</h3>
                    <p>{emptyState?.description || copy.emptyDescription}</p>
                    {emptyState?.action === 'clear-search' && (
                        <button type="button" className="btn btn-secondary" onClick={() => onSearchChange?.('')}>Clear search</button>
                    )}
                    {isQueueMode && matchingCount > 0 && hasMore && (
                        <button type="button" className="btn btn-secondary" onClick={onLoadMore}>Load remaining results</button>
                    )}
                </div>
            ) : (
                <div className={`workspace-shell ${isQueueMode ? 'queue-workspace-shell' : ''}`}>
                    <aside className="workspace-list">
                        <div className="workspace-list-header">
                            <div>
                                <p className="section-kicker">{isQueueMode ? 'Queue' : 'Library'}</p>
                                <h3>{isQueueMode ? `${matchingCount} titles match this view` : copy.listTitle}</h3>
                            </div>
                        </div>

                        <div ref={scrollRef} className="workspace-list-scroll">
                            {filteredRecs.map((rec) => {
                                const signals = getRecommendationSignals(rec, feedbackProfile);
                                const learningHighlights = getLearningHighlights(rec, feedbackProfile);

                                return (
                                    <article
                                        key={rec.id}
                                        className={`workspace-item ${resolvedSelectedId === rec.id ? 'active' : ''} ${isQueueMode ? 'selectable' : ''} ${rec.id && selectedIds.has(rec.id) ? 'selected' : ''}`}
                                    >
                                        {isQueueMode && rec.id && (
                                            <label className="queue-select-control">
                                                <input
                                                    type="checkbox"
                                                    className="queue-select-input"
                                                    aria-label={`Select ${rec.title}`}
                                                    checked={selectedIds.has(rec.id)}
                                                    disabled={mutationBusy}
                                                    onChange={(event) => setSelectedIds(current => {
                                                        const next = new Set(current);
                                                        if (event.target.checked) next.add(rec.id!); else next.delete(rec.id!);
                                                        return next;
                                                    })}
                                                />
                                                <span className="queue-select-indicator" aria-hidden="true" />
                                            </label>
                                        )}
                                        <button
                                            type="button"
                                            className="workspace-item-trigger"
                                            aria-label={`View details for ${rec.title}`}
                                            onClick={(event) => {
                                                setSelectedId(rec.id || null);
                                                if (usesDetailOverlay) {
                                                    detailTriggerRef.current = event.currentTarget;
                                                    setDetailOverlayOpen(true);
                                                }
                                            }}
                                        />
                                        <div className="workspace-item-poster">
                                            {rec.posterUrl ? (
                                                <img src={rec.posterUrl} alt="" />
                                            ) : (
                                                <div className="workspace-item-poster placeholder">No poster</div>
                                            )}
                                        </div>

                                        <div className="workspace-item-copy">
                                            <div className="workspace-item-top">
                                                <h4>{rec.title}</h4>
                                                <span className={`status-pill ${rec.status}`}>{rec.status.replace('_', ' ')}</span>
                                            </div>
                                            <p className="workspace-item-subtitle">
                                                {[rec.year, rec.voteAverage ? `${rec.voteAverage.toFixed(1)}/10` : null, rec.source.toUpperCase()]
                                                    .filter(Boolean)
                                                    .join(' · ')}
                                            </p>
                                            {rec.overview && <p className="workspace-item-overview">{rec.overview}</p>}

                                            <div className="signal-row compact">
                                                {signals.slice(0, 3).map((signal) => (
                                                    <span key={`${signal.label}-${signal.value || ''}`} className={`micro-pill ${signal.tone}`}>
                                                        {signal.label}
                                                        {signal.value ? `: ${signal.value}` : ''}
                                                    </span>
                                                ))}
                                            </div>

                                            <div className="learning-card mini">
                                                <strong>Learning from you</strong>
                                                {learningHighlights.length > 0 ? (
                                                    <span>{learningHighlights[0]}</span>
                                                ) : (
                                                    <span>More approvals and rejects will sharpen ranking here.</span>
                                                )}
                                            </div>

                                            {rec.status === 'rejected' && rec.feedbackReason && (
                                                <p className="workspace-feedback-note">Rejected for {formatFeedbackReason(rec.feedbackReason)}</p>
                                            )}
                                            {rec.status === 'not_now' && rec.snoozedUntil && (
                                                <p className="workspace-feedback-note">
                                                    Snoozed until {new Date(rec.snoozedUntil).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                                </p>
                                            )}
                                        </div>
                                    </article>
                                );
                            })}

                            <div ref={sentinelRef} className="workspace-feed-state">
                                {loadingMore ? (
                                    <>
                                        <span className="spinner" />
                                        Loading more titles...
                                    </>
                                ) : hasMore ? (
                                    <button type="button" className="btn btn-ghost" onClick={onLoadMore}>
                                        Load more
                                    </button>
                                ) : (
                                    <span className="helper-copy">{copy.footerDone}</span>
                                )}
                            </div>
                        </div>
                    </aside>

                    <div className="workspace-detail desktop-workspace-detail">
                        <RecommendationDetail
                            recommendation={selectedRecommendation}
                            feedbackProfile={feedbackProfile}
                            loading={loading || Boolean(selectedRecommendation?.id && mutatingIds.has(selectedRecommendation.id))}
                            onAction={onAction}
                            emptyState={copy.detailEmpty}
                        />
                    </div>

                    {isQueueMode && (
                        <dialog
                            ref={detailDialogRef}
                            className="queue-detail-dialog"
                            aria-label={selectedRecommendation ? `Recommendation details for ${selectedRecommendation.title}` : 'Recommendation details'}
                            onCancel={(event) => {
                                event.preventDefault();
                                closeDetailOverlay();
                            }}
                            onKeyDown={containDialogFocus}
                            onClose={() => {
                                if (detailOverlayOpen) closeDetailOverlay();
                            }}
                        >
                            <div className="queue-detail-dialog-header">
                                <strong>Recommendation details</strong>
                                <button type="button" className="btn btn-ghost btn-sm" onClick={closeDetailOverlay}>
                                    Close
                                </button>
                            </div>
                            <div className="queue-detail-dialog-scroll">
                                <RecommendationDetail
                                    recommendation={selectedRecommendation}
                                    feedbackProfile={feedbackProfile}
                                    loading={loading || Boolean(selectedRecommendation?.id && mutatingIds.has(selectedRecommendation.id))}
                                    onAction={onAction}
                                    emptyState={copy.detailEmpty}
                                />
                            </div>
                        </dialog>
                    )}
                </div>
            )}
        </div>
    );
}
