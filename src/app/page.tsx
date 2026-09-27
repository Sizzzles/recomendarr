'use client';

import { Suspense, useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { AddToLibraryModal } from '@/components/app/add-to-library-modal';
import { DashboardPage } from '@/components/app/dashboard-page';
import { FeedbackModal } from '@/components/app/feedback-modal';
import { RecommendationsWorkspace } from '@/components/app/recommendations-workspace';
import { SettingsPage } from '@/components/app/settings-page';
import { SetupWizard } from '@/components/app/setup-wizard';
import { WatchedSearchModal } from '@/components/app/watched-search-modal';
import type {
    ConnectionResult,
    Counts,
    EngineFilterState,
    Page,
    RecommendationFilter,
} from '@/components/app/models';
import { EMPTY_DASHBOARD_SUMMARY } from '@/components/app/models';
import { parseQueuePreferences, saveQueuePreferences } from '@/components/app/queue-model';
import type { RecommendationSort } from '@/lib/recommendation-query';
import type { LogEntry, Recommendation } from '@/lib/types';
import type { RecommendationStatus } from '@/lib/types';
import { beginOptimisticTransition, matchesQueueSearch, reconcileRecommendation } from '@/components/app/queue-optimistic';

const RECOMMENDATION_PAGE_SIZE = 24;
const EMPTY_COUNTS: Counts = { pending: 0, approved: 0, rejected: 0, added: 0, not_now: 0, watched: 0, total: 0 };

function getRecommendationStatuses(page: Page, filter: RecommendationFilter): RecommendationStatus[] {
    if (page === 'library') {
        return ['added'];
    }

    if (filter === 'pending') {
        return ['pending'];
    }

    if (filter === 'rejected') {
        return ['rejected'];
    }

    if (filter === 'not_now') {
        return ['not_now'];
    }

    if (filter === 'watched') {
        return ['watched'];
    }

    return ['pending', 'rejected'];
}

export default function Home() {
    return (
        <Suspense
            fallback={
                <div className="app-loading-screen">
                    <div className="spinner spinner-lg" />
                </div>
            }
        >
            <HomeContent />
        </Suspense>
    );
}

function HomeContent() {
    const [page, setPage] = useState<Page>('dashboard');
    const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
    const [setupStep, setSetupStep] = useState(0);
    const [recs, setRecs] = useState<Recommendation[]>([]);
    const [pendingPreviewRecs, setPendingPreviewRecs] = useState<Recommendation[]>([]);
    const [counts, setCounts] = useState<Counts>(EMPTY_COUNTS);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [filter, setFilter] = useState<RecommendationFilter>('all');
    const [queueSearch, setQueueSearch] = useState('');
    const deferredQueueSearch = useDeferredValue(queueSearch);
    const [queueSort, setQueueSort] = useState<RecommendationSort>('newest');
    const [queuePreferencesReady, setQueuePreferencesReady] = useState(false);
    const [matchingCount, setMatchingCount] = useState(0);
    const recommendationRequest = useRef(0);
    const mutationLock = useRef(new Set<string>());
    const reloadCollectionRef = useRef<(options: { reset: boolean; offset: number }) => Promise<void>>(async () => {});
    const [logFilter, setLogFilter] = useState('all');
    const [isRunning, setIsRunning] = useState(false);
    const [loading] = useState(false);
    const [listLoading, setListLoading] = useState(false);
    const [loadingMoreRecs, setLoadingMoreRecs] = useState(false);
    const [hasMoreRecs, setHasMoreRecs] = useState(true);
    const [recOffset, setRecOffset] = useState(0);
    const [toasts, setToasts] = useState<Array<{ id: number; msg: string; type: string }>>([]);
    const [dashboardSummary, setDashboardSummary] = useState(EMPTY_DASHBOARD_SUMMARY);

    const [modalRec, setModalRec] = useState<Recommendation | null>(null);
    const [bulkModalRecs, setBulkModalRecs] = useState<Recommendation[]>([]);
    const [bulkAddErrors, setBulkAddErrors] = useState<string[]>([]);
    const [arrProfiles, setArrProfiles] = useState<Array<{ id: number; name: string }>>([]);
    const [arrFolders, setArrFolders] = useState<Array<{ id: number; path: string; freeSpace: number }>>([]);
    const [modalLoading, setModalLoading] = useState(false);
    const [selectedProfile, setSelectedProfile] = useState<number>(0);
    const [selectedFolder, setSelectedFolder] = useState('');
    const [searchForContent, setSearchForContent] = useState(true);
    const [addingToLibrary, setAddingToLibrary] = useState(false);

    const [feedbackRec, setFeedbackRec] = useState<Recommendation | null>(null);
    const [feedbackReason, setFeedbackReason] = useState<'already_watched' | 'wrong_genre' | 'wrong_mood' | 'too_mainstream' | 'too_old' | 'not_interested'>('not_interested');
    const [feedbackNotes, setFeedbackNotes] = useState('');
    const [savingFeedback, setSavingFeedback] = useState(false);
    const [watchedSearchOpen, setWatchedSearchOpen] = useState(false);
    const [mutatingIds, setMutatingIds] = useState<Set<string>>(new Set());
    const [undoEntry, setUndoEntry] = useState<{
        previous: Recommendation[];
        expectedUpdatedAt: Record<string, string>;
        message: string;
    } | null>(null);
    const [bulkFeedbackIds, setBulkFeedbackIds] = useState<string[]>([]);

    const [connResults, setConnResults] = useState<Record<string, ConnectionResult>>({});
    const [engineFilters, setEngineFilters] = useState<EngineFilterState>({
        genres: [],
        language: 'all',
        yearMin: 0,
        yearMax: 0,
        mediaType: 'all',
        vibePrompt: '',
        minRating: 0,
        providers: [],
    });
    const currentQueueKey = `${page}|${filter}|${deferredQueueSearch.trim()}|${queueSort}`;
    const currentQueueKeyRef = useRef(currentQueueKey);
    currentQueueKeyRef.current = currentQueueKey;

    const toast = useCallback((msg: string, type = 'info') => {
        const id = Date.now();
        setToasts((prev) => [...prev, { id, msg, type }]);
        setTimeout(() => setToasts((prev) => prev.filter((item) => item.id !== id)), 4000);
    }, []);

    const fetchPendingPreview = useCallback(async () => {
        try {
            const params = new URLSearchParams({ status: 'pending', limit: '4' });
            const response = await fetch(`/api/recommendations?${params}`);
            const data = await response.json();
            setPendingPreviewRecs(data.recommendations || []);
            setCounts(data.counts || EMPTY_COUNTS);
        } catch {
            // silent fetch failure
        }
    }, []);

    const loadRecommendationCollection = useCallback(async ({
        reset,
        offset,
    }: {
        reset: boolean;
        offset: number;
    }) => {
        if (page !== 'recommendations' && page !== 'library') {
            return;
        }

        if (reset) {
            setListLoading(true);
            setRecs([]);
            setRecOffset(0);
        } else {
            setLoadingMoreRecs(true);
        }

        const requestId = ++recommendationRequest.current;
        try {
            const params = new URLSearchParams({
                status: getRecommendationStatuses(page, filter).join(','),
                limit: String(RECOMMENDATION_PAGE_SIZE),
                offset: String(offset),
            });
            if (page === 'recommendations') {
                if (deferredQueueSearch.trim()) params.set('search', deferredQueueSearch);
                params.set('sort', queueSort);
            }
            const response = await fetch(`/api/recommendations?${params}`);
            const data = await response.json();
            if (requestId !== recommendationRequest.current) return;
            if (!response.ok) throw new Error(data.error || 'Could not load recommendations');
            const nextRecs = Array.isArray(data.recommendations) ? data.recommendations as Recommendation[] : [];

            setRecs((prev) => {
                if (reset) {
                    return nextRecs;
                }

                const seen = new Set(prev.map((rec) => rec.id));
                return [...prev, ...nextRecs.filter((rec) => !seen.has(rec.id))];
            });
            setCounts(data.counts || EMPTY_COUNTS);
            setMatchingCount(typeof data.matchingCount === 'number' ? data.matchingCount : nextRecs.length);
            setRecOffset(offset + nextRecs.length);
            setHasMoreRecs(nextRecs.length === RECOMMENDATION_PAGE_SIZE);
        } catch {
            if (requestId !== recommendationRequest.current) return;
            if (reset) {
                setRecs([]);
                setHasMoreRecs(false);
            }
        } finally {
            if (requestId !== recommendationRequest.current) return;
            setListLoading(false);
            setLoadingMoreRecs(false);
        }
    }, [deferredQueueSearch, filter, page, queueSort]);
    reloadCollectionRef.current = loadRecommendationCollection;

    const loadMoreRecommendations = useCallback(() => {
        if (page !== 'recommendations' && page !== 'library') {
            return;
        }

        if (listLoading || loadingMoreRecs || !hasMoreRecs) {
            return;
        }

        void loadRecommendationCollection({ reset: false, offset: recOffset });
    }, [hasMoreRecs, listLoading, loadRecommendationCollection, loadingMoreRecs, page, recOffset]);

    const fetchDashboardSummary = useCallback(async () => {
        try {
            const response = await fetch('/api/dashboard');
            const data = await response.json();
            setDashboardSummary({ ...EMPTY_DASHBOARD_SUMMARY, ...data });
        } catch {
            // silent fetch failure
        }
    }, []);

    const fetchLogs = useCallback(async () => {
        try {
            const params = new URLSearchParams();
            if (logFilter !== 'all') params.set('level', logFilter);
            const response = await fetch(`/api/logs?${params}`);
            const data = await response.json();
            setLogs(data.logs || []);
        } catch {
            // silent fetch failure
        }
    }, [logFilter]);

    const checkEngine = useCallback(async () => {
        try {
            const response = await fetch('/api/engine');
            const data = await response.json();
            setIsRunning(Boolean(data.running));
        } catch {
            // silent fetch failure
        }
    }, []);

    useEffect(() => {
        fetch('/api/settings')
            .then((response) => response.json())
            .then((data) => setSetupComplete(data.setupComplete ?? false))
            .catch(() => setSetupComplete(false));
    }, []);

    useEffect(() => {
        if (!setupComplete) return;
        void Promise.all([fetchPendingPreview(), fetchDashboardSummary(), checkEngine()]);
    }, [checkEngine, fetchDashboardSummary, fetchPendingPreview, setupComplete]);

    useEffect(() => {
        const preferences = parseQueuePreferences(window.localStorage);
        setFilter(preferences.filter);
        setQueueSort(preferences.sort);
        setQueuePreferencesReady(true);
    }, []);

    useEffect(() => {
        if (!undoEntry) return;
        const timer = window.setTimeout(() => setUndoEntry(null), 8000);
        return () => window.clearTimeout(timer);
    }, [undoEntry]);

    useEffect(() => {
        if (!queuePreferencesReady) return;
        saveQueuePreferences(window.localStorage, { filter, sort: queueSort });
    }, [filter, queuePreferencesReady, queueSort]);

    useEffect(() => {
        if (page !== 'recommendations') setQueueSearch('');
    }, [page]);

    useEffect(() => {
        if (!setupComplete) return;
        if (page !== 'recommendations' && page !== 'library') return;
        if (page === 'recommendations' && !queuePreferencesReady) return;
        void loadRecommendationCollection({ reset: true, offset: 0 });
    }, [filter, loadRecommendationCollection, page, queuePreferencesReady, setupComplete]);

    useEffect(() => {
        if (page === 'logs' && setupComplete) {
            void fetchLogs();
        }
    }, [fetchLogs, page, setupComplete]);

    useEffect(() => {
        if (!setupComplete) {
            return;
        }

        window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }, [page, setupComplete]);

    if (setupComplete === null) {
        return (
            <div className="app-loading-screen">
                <div className="spinner spinner-lg" />
            </div>
        );
    }

    if (!setupComplete) {
        return (
            <>
                <SetupWizard
                    step={setupStep}
                    setStep={setSetupStep}
                    onComplete={() => {
                        setToasts([{ id: Date.now(), msg: 'Setup complete. Loading workspace...', type: 'success' }]);
                        setTimeout(() => window.location.reload(), 1500);
                    }}
                    toast={toast}
                />
                <div className="toast-container">
                    {toasts.map((item) => (
                        <div key={item.id} className={`toast ${item.type}`}>
                            {item.msg}
                        </div>
                    ))}
                </div>
            </>
        );
    }

    const runEngine = async () => {
        setIsRunning(true);
        toast('Recommendation engine started', 'info');

        try {
            const filters: Record<string, unknown> = {};
            if (engineFilters.genres.length > 0) filters.genres = engineFilters.genres;
            if (engineFilters.language !== 'all') filters.language = engineFilters.language;
            if (engineFilters.yearMin > 0) filters.yearMin = engineFilters.yearMin;
            if (engineFilters.yearMax > 0) filters.yearMax = engineFilters.yearMax;
            if (engineFilters.mediaType !== 'all') filters.mediaType = engineFilters.mediaType;
            if (engineFilters.vibePrompt.trim()) filters.vibePrompt = engineFilters.vibePrompt.trim();
            if (engineFilters.minRating > 0) filters.minRating = engineFilters.minRating;
            if (engineFilters.providers.length > 0) filters.providers = engineFilters.providers;

            const hasFilters = Object.keys(filters).length > 0;
            const response = await fetch('/api/engine', {
                method: 'POST',
                headers: hasFilters ? { 'Content-Type': 'application/json' } : {},
                body: hasFilters ? JSON.stringify({ filters }) : undefined,
            });
            const data = await response.json();

            if (data.error) {
                toast(data.error, 'error');
                return;
            }

            toast(`Found ${data.totalNew} new recommendations`, 'success');
            await Promise.all([
                fetchPendingPreview(),
                fetchDashboardSummary(),
                page === 'recommendations' || page === 'library'
                    ? loadRecommendationCollection({ reset: true, offset: 0 })
                    : Promise.resolve(),
            ]);
        } catch (error) {
            toast((error as Error).message, 'error');
        } finally {
            setIsRunning(false);
        }
    };

    const openAddModal = async (recommendation: Recommendation) => {
        setBulkModalRecs([]);
        setBulkAddErrors([]);
        setModalRec(recommendation);
        setModalLoading(true);
        setArrProfiles([]);
        setArrFolders([]);
        setSelectedProfile(0);
        setSelectedFolder('');
        setSearchForContent(true);

        try {
            const response = await fetch(`/api/arr-options?type=${recommendation.mediaType}`);
            const data = await response.json();
            setArrProfiles(data.profiles || []);
            setArrFolders(data.folders || []);
            if (data.profiles?.length) setSelectedProfile(data.profiles[0].id);
            if (data.folders?.length) setSelectedFolder(data.folders[0].path);
        } catch {
            toast('Could not fetch profile and folder options', 'error');
        } finally {
            setModalLoading(false);
        }
    };

    const openBulkAddModal = async (recommendations: Recommendation[]) => {
        if (!recommendations.length) return;
        await openAddModal(recommendations[0]);
        setBulkModalRecs(recommendations);
    };

    const confirmAdd = async () => {
        if (!modalRec) return;
        setAddingToLibrary(true);

        try {
            const isBulk = bulkModalRecs.length > 0;
            const response = await fetch('/api/recommendations', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...(isBulk
                        ? { ids: bulkModalRecs.map(item => item.id), mediaType: modalRec.mediaType }
                        : { id: modalRec.id }),
                    action: 'approve',
                    qualityProfileId: selectedProfile || undefined,
                    rootFolderPath: selectedFolder || undefined,
                    searchForContent,
                }),
            });
            const data = await response.json();
            if (!response.ok || !data.success) {
                toast(data.message || data.error, 'error');
                return;
            }

            toast(isBulk ? `${data.totals.added} added, ${data.totals.failed} failed` : data.message, data.totals?.failed ? 'info' : 'success');
            if (isBulk && data.totals.failed > 0) {
                const failedIds = new Set((data.results as Array<{ id: string; outcome: string }>).filter(item => item.outcome === 'failed').map(item => item.id));
                const failed = bulkModalRecs.filter(item => item.id && failedIds.has(item.id));
                setBulkModalRecs(failed);
                setModalRec(failed[0] || null);
                setBulkAddErrors((data.results as Array<{ id: string; outcome: string; message: string }>).filter(item => item.outcome === 'failed').map(item => item.message));
            } else {
                setModalRec(null);
                setBulkModalRecs([]);
                setBulkAddErrors([]);
            }
            await Promise.all([
                fetchPendingPreview(),
                fetchDashboardSummary(),
                page === 'recommendations' || page === 'library'
                    ? loadRecommendationCollection({ reset: true, offset: 0 })
                    : Promise.resolve(),
            ]);
        } catch (error) {
            toast((error as Error).message, 'error');
        } finally {
            setAddingToLibrary(false);
        }
    };

    const performStatusAction = async (
        id: string,
        action: 'reject' | 'pending' | 'not_now' | 'watched',
        feedback?: { feedbackReason?: string; feedbackNotes?: string },
    ) => {
        const previous = recs.find(rec => rec.id === id);
        if (!previous || mutationLock.current.size > 0) return false;
        mutationLock.current.add(id);
        setUndoEntry(null);
        const queryKey = currentQueueKeyRef.current;
        const snapshot = { recommendations: recs, counts, matchingCount, offset: recOffset };
        const status: RecommendationStatus = action === 'reject' ? 'rejected' : action === 'not_now' ? 'not_now' : action;
        const visibleStatuses = getRecommendationStatuses(page, filter);
        const optimistic = beginOptimisticTransition(recs, counts, id, status, visibleStatuses);
        setRecs(optimistic.recommendations);
        setCounts(optimistic.counts);
        if (!visibleStatuses.includes(status)) {
            setMatchingCount(value => Math.max(0, value - 1));
            setRecOffset(value => Math.max(0, value - 1));
        }
        setMutatingIds(current => new Set(current).add(id));
        try {
            const response = await fetch('/api/recommendations', {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, action, ...feedback }),
            });
            const data = await response.json();
            if (!response.ok || !data.success || !data.recommendation) throw new Error(data.error || data.message || 'Recommendation update failed');
            const authoritative = data.recommendation as Recommendation;
            setUndoEntry({
                previous: [previous],
                expectedUpdatedAt: { [id]: authoritative.updatedAt || '' },
                message: action === 'pending' ? 'Returned to queue' : action === 'not_now' ? 'Snoozed for 7 days' : action === 'watched' ? 'Marked as watched' : 'Recommendation rejected',
            });
            if (queryKey !== currentQueueKeyRef.current) {
                await reloadCollectionRef.current({ reset: true, offset: 0 });
                return true;
            }
            setRecs(current => reconcileRecommendation(current, authoritative, visibleStatuses, item => matchesQueueSearch(item, deferredQueueSearch)));
            return true;
        } catch (error) {
            if (queryKey === currentQueueKeyRef.current) {
                setRecs(snapshot.recommendations);
                setCounts(snapshot.counts);
                setMatchingCount(snapshot.matchingCount);
                setRecOffset(snapshot.offset);
            } else {
                await reloadCollectionRef.current({ reset: true, offset: 0 });
            }
            toast((error as Error).message, 'error');
            return false;
        } finally {
            mutationLock.current.delete(id);
            setMutatingIds(current => { const next = new Set(current); next.delete(id); return next; });
        }
    };

    const undoLastAction = async () => {
        const entry = undoEntry;
        if (!entry?.previous.length || mutationLock.current.size > 0) return;
        const undoIds = entry.previous.flatMap(item => item.id ? [item.id] : []);
        for (const id of undoIds) mutationLock.current.add(id);
        setMutatingIds(current => new Set([...current, ...undoIds]));
        setUndoEntry(null);
        try {
            const response = await fetch('/api/recommendations', {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(entry.previous.length === 1
                    ? { id: entry.previous[0].id, action: 'restore', previous: entry.previous[0], expectedUpdatedAt: entry.expectedUpdatedAt[entry.previous[0].id!] }
                    : { action: 'restore', restores: entry.previous.map(previous => ({ previous, id: previous.id, expectedUpdatedAt: entry.expectedUpdatedAt[previous.id!] })) }),
            });
            const data = await response.json();
            if (!response.ok) throw Object.assign(new Error(data.error || 'Undo failed'), { status: response.status });
            await reloadCollectionRef.current({ reset: true, offset: 0 });
            toast('Action undone', 'success');
        } catch (error) {
            await reloadCollectionRef.current({ reset: true, offset: 0 });
            toast((error as { status?: number }).status === 409 ? 'Could not undo because this recommendation changed. Newer state was preserved.' : (error as Error).message, 'error');
        } finally {
            for (const id of undoIds) mutationLock.current.delete(id);
            setMutatingIds(current => { const next = new Set(current); for (const id of undoIds) next.delete(id); return next; });
        }
    };

    const performBulkStatusAction = async (ids: string[], action: 'not_now' | 'watched' | 'pending' | 'reject', feedback?: { feedbackReason?: string; feedbackNotes?: string }) => {
        const uniqueIds = Array.from(new Set(ids));
        const previous = uniqueIds.flatMap(id => recs.find(rec => rec.id === id) || []);
        if (previous.length !== uniqueIds.length || mutationLock.current.size > 0) return false;
        for (const id of uniqueIds) mutationLock.current.add(id);
        setUndoEntry(null);
        const queryKey = currentQueueKeyRef.current;
        const snapshot = { recommendations: recs, counts, matchingCount, offset: recOffset };
        const destination: RecommendationStatus = action === 'reject' ? 'rejected' : action === 'not_now' ? 'not_now' : action;
        const visibleStatuses = getRecommendationStatuses(page, filter);
        let nextRecommendations = recs;
        let nextCounts = counts;
        for (const item of previous) {
            const transition = beginOptimisticTransition(nextRecommendations, nextCounts, item.id!, destination, visibleStatuses);
            nextRecommendations = transition.recommendations;
            nextCounts = transition.counts;
        }
        setRecs(nextRecommendations);
        setCounts(nextCounts);
        const leavingCount = visibleStatuses.includes(destination) ? 0 : previous.length;
        if (leavingCount) {
            setMatchingCount(value => Math.max(0, value - leavingCount));
            setRecOffset(value => Math.max(0, value - leavingCount));
        }
        setMutatingIds(current => new Set([...current, ...uniqueIds]));
        try {
            const response = await fetch('/api/recommendations', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: uniqueIds, action, ...feedback }) });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.error || 'Bulk action failed');
            const authoritative = data.recommendations as Recommendation[];
            setUndoEntry({
                previous,
                expectedUpdatedAt: Object.fromEntries(authoritative.map(item => [item.id!, item.updatedAt || ''])),
                message: `${authoritative.length} recommendations updated`,
            });
            if (queryKey !== currentQueueKeyRef.current) {
                await reloadCollectionRef.current({ reset: true, offset: 0 });
                return true;
            }
            setRecs(current => authoritative.reduce((items, updated) => reconcileRecommendation(items, updated, visibleStatuses, item => matchesQueueSearch(item, deferredQueueSearch)), current));
            return true;
        } catch (error) {
            if (queryKey === currentQueueKeyRef.current) {
                setRecs(snapshot.recommendations);
                setCounts(snapshot.counts);
                setMatchingCount(snapshot.matchingCount);
                setRecOffset(snapshot.offset);
            } else {
                await reloadCollectionRef.current({ reset: true, offset: 0 });
            }
            toast((error as Error).message, 'error');
            return false;
        } finally {
            for (const id of uniqueIds) mutationLock.current.delete(id);
            setMutatingIds(current => { const next = new Set(current); for (const id of uniqueIds) next.delete(id); return next; });
        }
    };

    const handleBulkAction = async (ids: string[], action: 'not_now' | 'watched' | 'pending' | 'reject') => {
        if (action === 'reject') {
            setBulkFeedbackIds(ids);
            setFeedbackReason('not_interested');
            setFeedbackNotes('');
            const first = recs.find(rec => rec.id === ids[0]);
            if (first) setFeedbackRec(first);
            return;
        }
        await performBulkStatusAction(ids, action);
    };

    const submitFeedback = async () => {
        if (!feedbackRec) return;
        setSavingFeedback(true);

        try {
            const feedback = { feedbackReason, feedbackNotes: feedbackNotes.trim() || undefined };
            const success = bulkFeedbackIds.length
                ? await performBulkStatusAction(bulkFeedbackIds, 'reject', feedback)
                : await performStatusAction(feedbackRec.id!, 'reject', feedback);
            if (!success) return;
            setFeedbackRec(null);
            setBulkFeedbackIds([]);
            setFeedbackReason('not_interested');
            setFeedbackNotes('');
        } catch (error) {
            toast((error as Error).message, 'error');
        } finally {
            setSavingFeedback(false);
        }
    };

    const handleAction = async (id: string, action: string) => {
        if (action === 'approve') {
            const recommendation = recs.find((rec) => rec.id === id);
            if (recommendation) {
                await openAddModal(recommendation);
            }
            return;
        }

        if (action === 'reject') {
            const recommendation = recs.find((rec) => rec.id === id);
            if (recommendation) {
                setBulkFeedbackIds([]);
                setFeedbackRec(recommendation);
                setFeedbackReason(recommendation.feedbackReason || 'not_interested');
                setFeedbackNotes(recommendation.feedbackNotes || '');
            }
            return;
        }

        await performStatusAction(id, action as 'pending' | 'not_now' | 'watched');
    };

    const handleWatchedAdded = async (message: string) => {
        toast(message, 'success');
        await Promise.all([
            fetchPendingPreview(),
            fetchDashboardSummary(),
            page === 'recommendations'
                ? loadRecommendationCollection({ reset: true, offset: 0 })
                : Promise.resolve(),
        ]);
    };

    const clearLogs = async () => {
        await fetch('/api/logs', { method: 'DELETE' });
        setLogs([]);
        toast('Logs cleared', 'info');
    };

    const testConnection = async (service: string, settings?: Record<string, string>) => {
        setConnResults((prev) => ({ ...prev, [service]: { testing: true } }));
        try {
            const response = await fetch('/api/test-connection', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ service, settings }),
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || 'Connection test failed');
            }

            setConnResults((prev) => ({
                ...prev,
                [service]: { success: data.success, testing: false, data },
            }));
            return data;
        } catch (error) {
            setConnResults((prev) => ({ ...prev, [service]: { success: false, testing: false } }));
            toast((error as Error).message, 'error');
            return null;
        }
    };

    return (
        <div className="app-shell">
            <aside className="app-sidebar">
                <div className="brand-lockup">
                    <span className="brand-mark">R</span>
                    <div>
                        <h1>Recomendarr</h1>
                        <p>Queue intelligence</p>
                    </div>
                </div>

                <nav className="nav-list">
                    {[
                        { id: 'dashboard', label: 'Dashboard' },
                        { id: 'recommendations', label: `Recommendations${counts.pending > 0 ? ` (${counts.pending})` : ''}` },
                        { id: 'library', label: `Library${counts.added > 0 ? ` (${counts.added})` : ''}` },
                        { id: 'logs', label: 'Logs' },
                        { id: 'settings', label: 'Settings' },
                    ].map((item) => (
                        <button
                            key={item.id}
                            type="button"
                            className={`nav-item ${page === item.id ? 'active' : ''}`}
                            onClick={() => setPage(item.id as Page)}
                        >
                            {item.label}
                        </button>
                    ))}
                </nav>

                <div className="sidebar-card">
                    <p className="section-kicker">Automation</p>
                    <h3>{dashboardSummary.automation.enabled ? 'Scheduler active' : 'Manual only'}</h3>
                    <p>{dashboardSummary.automation.nextRun || 'Enable scheduling in Settings to preview the next run.'}</p>
                </div>
            </aside>

            <main className="app-main">
                {page === 'dashboard' && (
                    <DashboardPage
                        summary={dashboardSummary}
                        pendingRecs={pendingPreviewRecs}
                        isRunning={isRunning}
                        onRun={runEngine}
                        onOpenRecommendations={() => setPage('recommendations')}
                        engineFilters={engineFilters}
                        setEngineFilters={setEngineFilters}
                    />
                )}

                {page === 'recommendations' && (
                    <RecommendationsWorkspace
                        recs={recs}
                        counts={counts}
                        filter={filter}
                        setFilter={setFilter}
                        feedbackProfile={dashboardSummary.feedbackProfile}
                        loading={loading}
                        listLoading={listLoading}
                        loadingMore={loadingMoreRecs}
                        hasMore={hasMoreRecs}
                        onLoadMore={loadMoreRecommendations}
                        onAction={handleAction}
                        onAddWatched={() => setWatchedSearchOpen(true)}
                        mode="queue"
                        search={queueSearch}
                        sort={queueSort}
                        matchingCount={matchingCount}
                        onSearchChange={setQueueSearch}
                        onSortChange={setQueueSort}
                        onBulkAction={handleBulkAction}
                        onBulkAdd={(recommendations) => void openBulkAddModal(recommendations)}
                        mutatingIds={mutatingIds}
                        mutationBusy={mutatingIds.size > 0}
                    />
                )}

                {page === 'library' && (
                    <RecommendationsWorkspace
                        key="library"
                        recs={recs}
                        counts={counts}
                        filter={filter}
                        setFilter={setFilter}
                        feedbackProfile={dashboardSummary.feedbackProfile}
                        loading={loading}
                        listLoading={listLoading}
                        loadingMore={loadingMoreRecs}
                        hasMore={hasMoreRecs}
                        onLoadMore={loadMoreRecommendations}
                        onAction={handleAction}
                        onAddWatched={() => setWatchedSearchOpen(true)}
                        mode="library"
                    />
                )}

                {page === 'logs' && (
                    <LogsPage
                        logs={logs}
                        logFilter={logFilter}
                        setLogFilter={setLogFilter}
                        onRefresh={fetchLogs}
                        onClear={clearLogs}
                    />
                )}

                {page === 'settings' && (
                    <SettingsPage
                        connResults={connResults}
                        onTest={testConnection}
                        toast={toast}
                        dashboardSummary={dashboardSummary}
                    />
                )}
            </main>

            <nav className="bottom-nav">
                {[
                    { id: 'dashboard', label: 'Dashboard' },
                    { id: 'recommendations', label: 'Queue' },
                    { id: 'library', label: 'Library' },
                    { id: 'logs', label: 'Logs' },
                    { id: 'settings', label: 'Settings' },
                ].map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        className={`bottom-nav-item ${page === item.id ? 'active' : ''}`}
                        onClick={() => setPage(item.id as Page)}
                    >
                        {item.label}
                    </button>
                ))}
            </nav>

            <AddToLibraryModal
                recommendation={modalRec}
                count={bulkModalRecs.length || 1}
                resultDetails={bulkAddErrors}
                profiles={arrProfiles}
                folders={arrFolders}
                selectedProfile={selectedProfile}
                selectedFolder={selectedFolder}
                searchForContent={searchForContent}
                loading={modalLoading}
                submitting={addingToLibrary}
                onProfileChange={setSelectedProfile}
                onFolderChange={setSelectedFolder}
                onSearchChange={setSearchForContent}
                onClose={() => { setModalRec(null); setBulkModalRecs([]); setBulkAddErrors([]); }}
                onSubmit={confirmAdd}
            />

            <FeedbackModal
                recommendation={feedbackRec}
                feedbackReason={feedbackReason}
                feedbackNotes={feedbackNotes}
                saving={savingFeedback}
                onReasonChange={setFeedbackReason}
                onNotesChange={setFeedbackNotes}
                onClose={() => { setFeedbackRec(null); setBulkFeedbackIds([]); }}
                onSubmit={submitFeedback}
            />

            <WatchedSearchModal
                open={watchedSearchOpen}
                onClose={() => setWatchedSearchOpen(false)}
                onAdded={handleWatchedAdded}
            />

            <div className="toast-container">
                {undoEntry && (
                    <div className="toast info toast-action">
                        <span>{undoEntry.message}</span>
                        <button type="button" onClick={undoLastAction} disabled={mutatingIds.size > 0}>Undo</button>
                    </div>
                )}
                {toasts.map((item) => (
                    <div key={item.id} className={`toast ${item.type}`}>
                        {item.msg}
                    </div>
                ))}
            </div>
        </div>
    );
}

function LogsPage({
    logs,
    logFilter,
    setLogFilter,
    onRefresh,
    onClear,
}: {
    logs: LogEntry[];
    logFilter: string;
    setLogFilter: (value: string) => void;
    onRefresh: () => void;
    onClear: () => void;
}) {
    return (
        <div className="page-stack">
            <div className="page-header refined">
                <div>
                    <p className="page-kicker">Observability</p>
                    <h2>Logs</h2>
                    <p>Inspect engine, scheduler, and notification activity without leaving the app.</p>
                </div>
                <div className="page-actions">
                    <button className="btn btn-ghost" onClick={onRefresh}>Refresh</button>
                    <button className="btn btn-danger" onClick={onClear}>Clear logs</button>
                </div>
            </div>

            <div className="filter-tabs wide">
                {['all', 'INFO', 'WARN', 'ERROR', 'DEBUG'].map((level) => (
                    <button
                        key={level}
                        className={`filter-tab ${logFilter === level ? 'active' : ''}`}
                        onClick={() => setLogFilter(level)}
                    >
                        {level}
                    </button>
                ))}
            </div>

            {logs.length === 0 ? (
                <div className="empty-state refined">
                    <div className="empty-icon">Logs</div>
                    <h3>No log entries yet</h3>
                    <p>Run the engine or test a connection to populate the activity stream.</p>
                </div>
            ) : (
                <div className="log-entries refined">
                    {logs.map((log) => (
                        <div key={log.id} className="log-entry">
                            <span className={`log-level ${log.level}`}>{log.level}</span>
                            <span className="log-time">{new Date(log.timestamp).toLocaleString()}</span>
                            <span className="log-source">[{log.source}]</span>
                            <span className="log-message">{log.message}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
