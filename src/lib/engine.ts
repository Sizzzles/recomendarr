import { createMediaServerConnector } from './media-server';
import { getRecommendationsForItem, getTmdbExternalIds, searchTmdb, discoverByFilters, getTmdbCredits, searchTmdbKeyword, discoverByKeywords, discoverByCrew } from './tmdb';
import { getAiRecommendations, generateTasteProfile, TasteProfile } from './ai-recommender';
import { addMovieToRadarr, getAllRadarrMovies } from './radarr';
import { addSeriesToSonarr, getAllSonarrSeries } from './sonarr';
import { addRecommendationWithResult, addLog, getFeedbackProfile, getRecommendationById, getWatchedMediaSignalSets, syncWatchedMediaState, updateRecommendationStatus } from './database';
import { getConfig } from './config';
import { notifyRunResult } from './notifications';
import type { FeedbackProfile, Recommendation, WatchedItem } from './types';
import { startEngineRun, type EngineRunTracker } from './engine-run-tracker';
import { ServiceAttemptAccumulator } from './service-health-observer';
import packageJson from '../../package.json';

export interface EngineFilters {
    genres?: string[];
    language?: string;
    yearMin?: number;
    yearMax?: number;
    mediaType?: 'movie' | 'series' | 'all';
    vibePrompt?: string;
    minRating?: number;
    providers?: number[];
}

interface LibrarySets {
    radarrTmdbIds: Set<number>;
    radarrTitles: Set<string>;
    sonarrTvdbIds: Set<number>;
    sonarrTitles: Set<string>;
    watchedTitles: Set<string>;
    watchedTmdbIds: Set<number>;
    watchedTvdbIds: Set<number>;
    watchedImdbIds: Set<string>;
}

async function inferPreferredLanguages(items: WatchedItem[]): Promise<string[]> {
    const counts = new Map<string, number>();

    for (const item of items.slice(0, 10)) {
        let language = item.language?.toLowerCase();

        if (!language) {
            try {
                const type = item.mediaType === 'movie' ? 'movie' : 'tv';
                const tmdbResult = await searchTmdb(item.title, type);
                language = tmdbResult?.original_language?.toLowerCase();
                if (language) {
                    item.language = language;
                }
            } catch {
                // Ignore lookup failures while building language preferences
            }
        }

        if (!language) {
            continue;
        }

        counts.set(language, (counts.get(language) || 0) + 1);
    }

    const rankedLanguages = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([language]) => language);

    const nonEnglish = rankedLanguages.filter((language) => language !== 'en');
    return nonEnglish.length > 0
        ? [...nonEnglish, ...rankedLanguages.filter((language) => language === 'en')]
        : rankedLanguages;
}

// ============================================
// Recommendation Engine — Orchestrator
// ============================================

export interface RunResult {
    watchedCount: number;
    tmdbRecommendations: number;
    aiRecommendations: number;
    totalNew: number;
    addedToArr: number;
    errors: string[];
}

let isRunning = false;

function scoreRecommendation(
    rec: Recommendation,
    feedbackProfile: FeedbackProfile,
    preferredLanguages: string[] = []
): number {
    let score = rec.voteAverage ? rec.voteAverage / 10 : 0;

    if (rec.source === 'ai') score += 0.4;

    const recGenres = (rec.genres || []).map((genre) => genre.toLowerCase());
    for (const genre of feedbackProfile.preferredGenres) {
        if (recGenres.includes(genre)) score += 1.25;
    }
    for (const genre of feedbackProfile.avoidedGenres) {
        if (recGenres.includes(genre)) score -= 1.5;
    }

    if (feedbackProfile.preferredMediaTypes.includes(rec.mediaType)) score += 0.75;
    if (feedbackProfile.avoidedMediaTypes.includes(rec.mediaType)) score -= 1.0;

    if (rec.year && feedbackProfile.feedbackReasons.too_old && rec.year < 2005) {
        score -= Math.min(2, feedbackProfile.feedbackReasons.too_old * 0.4);
    }

    if (feedbackProfile.rejectedTitles.includes(rec.title.toLowerCase())) {
        score -= 100;
    }

    const recLanguage = rec.language?.toLowerCase();
    if (recLanguage && preferredLanguages.includes(recLanguage)) {
        score += recLanguage === 'en' ? 0.2 : 0.9;
    }

    if (
        recLanguage === 'en' &&
        preferredLanguages.some((language) => language !== 'en') &&
        !preferredLanguages.includes('en')
    ) {
        score -= 0.5;
    }

    return score;
}

export function getIsRunning(): boolean {
    return isRunning;
}

export async function runRecommendationEngine(
    filters?: EngineFilters,
    source: 'manual' | 'scheduled' = 'manual'
): Promise<RunResult> {
    if (isRunning) {
        throw new Error('Recommendation engine is already running');
    }

    const runTracker: EngineRunTracker = startEngineRun(source, { engineVersion: packageJson.version });
    const runId = runTracker.getRun().id;
    isRunning = true;
    const result: RunResult = {
        watchedCount: 0,
        tmdbRecommendations: 0,
        aiRecommendations: 0,
        totalNew: 0,
        addedToArr: 0,
        errors: [],
    };
    let radarrHealth: ServiceAttemptAccumulator | null = null;
    let sonarrHealth: ServiceAttemptAccumulator | null = null;

    try {
        runTracker.startStage('preparing');
        addLog({
            level: 'INFO',
            message: `🚀 Starting recommendation engine run (${source})`,
            source: 'engine',
            details: JSON.stringify({ event: 'run_start', source, runId }),
        });

        // Step 0: Pre-fetch full Sonarr & Radarr libraries for duplicate checking
        const library: LibrarySets = {
            radarrTmdbIds: new Set<number>(),
            radarrTitles: new Set<string>(),
            sonarrTvdbIds: new Set<number>(),
            sonarrTitles: new Set<string>(),
            watchedTitles: new Set<string>(),
            watchedTmdbIds: new Set<number>(),
            watchedTvdbIds: new Set<number>(),
            watchedImdbIds: new Set<string>(),
        };

        const cfg = getConfig();
        const initialRadarr = { url: cfg.radarr.url, apiKey: cfg.radarr.apiKey };
        const initialSonarr = { url: cfg.sonarr.url, apiKey: cfg.sonarr.apiKey };
        radarrHealth = new ServiceAttemptAccumulator('radarr', 'engine', undefined, undefined, () => {
            const current = getConfig().radarr; return current.url === initialRadarr.url && current.apiKey === initialRadarr.apiKey;
        });
        sonarrHealth = new ServiceAttemptAccumulator('sonarr', 'engine', undefined, undefined, () => {
            const current = getConfig().sonarr; return current.url === initialSonarr.url && current.apiKey === initialSonarr.apiKey;
        });
        try {
            const radarrMovies = await getAllRadarrMovies();
            if (cfg.radarr.url && cfg.radarr.apiKey) { radarrHealth.recordSuccess(); runTracker.recordAttempt('preparing', 'success'); }
            for (const m of radarrMovies) {
                if (m.tmdbId) library.radarrTmdbIds.add(m.tmdbId);
                library.radarrTitles.add(m.title.toLowerCase());
            }
            addLog({ level: 'INFO', message: `📚 Loaded ${radarrMovies.length} movies from Radarr library`, source: 'engine' });
        } catch (err) {
            if (cfg.radarr.url && cfg.radarr.apiKey) { radarrHealth.recordFailure('Could not load Radarr library'); runTracker.recordAttempt('preparing', 'failure', `Radarr library: ${(err as Error).message}`); }
            addLog({ level: 'WARN', message: `Could not load Radarr library: ${(err as Error).message}`, source: 'engine' });
        }

        try {
            const sonarrSeries = await getAllSonarrSeries();
            if (cfg.sonarr.url && cfg.sonarr.apiKey) { sonarrHealth.recordSuccess(); runTracker.recordAttempt('preparing', 'success'); }
            for (const s of sonarrSeries) {
                if (s.tvdbId) library.sonarrTvdbIds.add(s.tvdbId);
                library.sonarrTitles.add(s.title.toLowerCase());
            }
            addLog({ level: 'INFO', message: `📚 Loaded ${sonarrSeries.length} series from Sonarr library`, source: 'engine' });
        } catch (err) {
            if (cfg.sonarr.url && cfg.sonarr.apiKey) { sonarrHealth.recordFailure('Could not load Sonarr library'); runTracker.recordAttempt('preparing', 'failure', `Sonarr library: ${(err as Error).message}`); }
            addLog({ level: 'WARN', message: `Could not load Sonarr library: ${(err as Error).message}`, source: 'engine' });
        }
        runTracker.completeStage('preparing');

        // Step 1: Fetch watch history
        runTracker.startStage('syncing_watch_history');
        const connector = createMediaServerConnector();
        const initialMedia = { ...cfg.mediaServer };
        const mediaHealth = new ServiceAttemptAccumulator('media_server', 'engine', undefined, undefined, () => JSON.stringify(getConfig().mediaServer) === JSON.stringify(initialMedia));
        let watchHistory: WatchedItem[];

        try {
            watchHistory = await connector.getWatchHistory(cfg.app.watchHistoryLimit);
            mediaHealth.recordSuccess('Watch history query succeeded');
            runTracker.recordAttempt('syncing_watch_history', 'success');
            result.watchedCount = watchHistory.length;
            runTracker.updateSummary({ watchedItemsProcessed: watchHistory.length });
            // Add watched titles to the exclusion set
            for (const w of watchHistory) {
                library.watchedTitles.add(w.title.toLowerCase());
            }
            syncWatchedMediaState(watchHistory);
            const watchedSignals = getWatchedMediaSignalSets();
            library.watchedTmdbIds = watchedSignals.tmdbIds;
            library.watchedTvdbIds = watchedSignals.tvdbIds;
            library.watchedImdbIds = watchedSignals.imdbIds;
            for (const title of watchedSignals.titles) {
                library.watchedTitles.add(title);
            }
            addLog({ level: 'INFO', message: `📺 Found ${watchHistory.length} watched items`, source: 'engine' });
        } catch (err) {
            mediaHealth.recordFailure('Watch history query failed');
            mediaHealth.flush();
            const msg = `Failed to fetch watch history: ${(err as Error).message}`;
            result.errors.push(msg);
            runTracker.recordAttempt('syncing_watch_history', 'failure', msg);
            runTracker.completeStage('syncing_watch_history');
            runTracker.finish({
                coreCompleted: false,
                coreFailure: {
                    stage: 'syncing_watch_history',
                    message: msg,
                    alreadyCounted: true,
                    stoppedReason: 'Run stopped after watch-history synchronization failed',
                },
            });
            addLog({ level: 'ERROR', message: msg, source: 'engine' });
            return result;
        }
        mediaHealth.flush();
        runTracker.completeStage('syncing_watch_history');

        if (watchHistory.length === 0) {
            for (const stage of ['building_context', 'discovering_candidates', 'ai_recommendations', 'processing_candidates', 'auto_adding'] as const) {
                runTracker.skipStage(stage, 'No watch history was available');
            }
            runTracker.startStage('finishing');
            runTracker.completeStage('finishing');
            runTracker.finish({ coreCompleted: true });
            addLog({ level: 'WARN', message: 'No watch history found. Skipping.', source: 'engine' });
            return result;
        }

        // Step 2: Get TMDb recommendations
        const allTmdbRecs: Recommendation[] = [];
        const maxPerItem = Math.ceil(cfg.app.maxRecommendationsPerRun / Math.min(watchHistory.length, 10));

        runTracker.startStage('building_context');
        // Filter watch history by media type if filter is set
        let filteredHistory = watchHistory;
        if (filters?.mediaType && filters.mediaType !== 'all') {
            filteredHistory = watchHistory.filter(item => item.mediaType === filters.mediaType);
            if (filteredHistory.length === 0) filteredHistory = watchHistory; // fallback
            addLog({ level: 'INFO', message: `🔍 Filtered watch history to ${filteredHistory.length} ${filters.mediaType} items`, source: 'engine' });
        }

        // Smart Sampling: create a diverse mix of highest-rated, rewatched, and recent items
        const scoredHistory = filteredHistory.map(item => {
            const ratingScore = item.rating ? item.rating * 2 : 0; // rating usually 0-10, so 0-20 points
            const playScore = item.playCount ? Math.min(item.playCount, 5) : 0; // up to 5 points
            const recencyScore = item.lastPlayedDate 
                ? Math.max(0, 5 - (Date.now() - new Date(item.lastPlayedDate).getTime()) / (1000 * 60 * 60 * 24 * 30)) // up to 5 points (decay over 5 months)
                : 0;
            return { item, score: ratingScore + playScore + recencyScore + Math.random() * 2 };
        });
        
        // Sort by score desc to get the most significant items
        scoredHistory.sort((a, b) => b.score - a.score);
        
        // Take top 10 from scored history
        const sampledItems = scoredHistory.slice(0, 10).map(s => s.item);
        runTracker.updateSummary({ historyItemsSampled: sampledItems.length });
        addLog({ level: 'INFO', message: `🎲 Smart sampled ${sampledItems.length} items to generate baseline recommendations`, source: 'engine' });

        const preferredLanguages = filters?.language && filters.language !== 'all'
            ? [filters.language.toLowerCase()]
            : await inferPreferredLanguages(sampledItems);
        if (preferredLanguages.length > 0) {
            addLog({
                level: 'INFO',
                message: `🌐 Language preference signal detected: ${preferredLanguages.join(', ')}`,
                source: 'engine',
            });
        }

        const feedbackProfile = getFeedbackProfile();
        runTracker.completeStage('building_context');
        runTracker.startStage('discovering_candidates');
        const initialTmdbKey = cfg.tmdb.apiKey;
        const tmdbHealth = new ServiceAttemptAccumulator('tmdb', 'engine', undefined, undefined, () => getConfig().tmdb.apiKey === initialTmdbKey);
        for (const item of sampledItems) {
            try {
                const recs = await getRecommendationsForItem(item, maxPerItem, true);
                tmdbHealth.recordSuccess(); runTracker.recordAttempt('discovering_candidates', 'success');
                allTmdbRecs.push(...recs);
            } catch (err) {
                tmdbHealth.recordFailure('TMDb recommendation query failed');
                runTracker.recordAttempt('discovering_candidates', 'failure', `TMDb error for "${item.title}": ${(err as Error).message}`);
                result.errors.push(`TMDb error for "${item.title}": ${(err as Error).message}`);
            }
        }

        // Step 2b: Filter-driven discovery via TMDb /discover endpoint
        if (
            (filters && (filters.genres?.length || filters.yearMin || filters.yearMax || (filters.language && filters.language !== 'all') || (filters.mediaType && filters.mediaType !== 'all')))
            || preferredLanguages.length > 0
        ) {
            try {
                addLog({ level: 'INFO', message: `🔍 Running filter-driven TMDb discovery...`, source: 'engine' });
                const discoverRecs = await discoverByFilters({
                    genres: filters?.genres,
                    language: filters?.language,
                    preferredLanguages,
                    yearMin: filters?.yearMin,
                    yearMax: filters?.yearMax,
                    mediaType: filters?.mediaType,
                    minRating: filters?.minRating,
                    providers: filters?.providers,
                }, cfg.app.maxRecommendationsPerRun, true);
                allTmdbRecs.push(...discoverRecs);
                tmdbHealth.recordSuccess(); runTracker.recordAttempt('discovering_candidates', 'success');
                addLog({ level: 'INFO', message: `🔍 Filter discovery added ${discoverRecs.length} recommendations`, source: 'engine' });
            } catch (err) {
                tmdbHealth.recordFailure('TMDb discovery query failed');
                runTracker.recordAttempt('discovering_candidates', 'failure', `TMDb discover error: ${(err as Error).message}`);
                result.errors.push(`TMDb discover error: ${(err as Error).message}`);
            }
        }

        result.tmdbRecommendations = allTmdbRecs.length;
        addLog({ level: 'INFO', message: `🎯 TMDb found ${allTmdbRecs.length} recommendations`, source: 'engine' });

        // Step 2c: Creator Following (Director extraction for Top 2 movies)
        try {
            const topMovies = scoredHistory.filter(s => s.item.mediaType === 'movie' && s.item.tmdbId).slice(0, 2);
            for (const s of topMovies) {
                const credits = await getTmdbCredits(s.item.tmdbId!, 'movie', true);
                if (credits && credits.crew) {
                    const director = credits.crew.find((crewMember) => crewMember.job === 'Director');
                    if (director) {
                        addLog({ level: 'INFO', message: `🎬 Creator Following: Discovering works by ${director.name} (from ${s.item.title})`, source: 'engine' });
                        const directorRecs = await discoverByCrew(director.id, 'movie', director.name, 3, preferredLanguages, true);
                        tmdbHealth.recordSuccess(); runTracker.recordAttempt('discovering_candidates', 'success');
                        allTmdbRecs.push(...directorRecs);
                    }
                }
            }
        } catch (err) {
            tmdbHealth.recordFailure('TMDb creator discovery failed');
            runTracker.recordAttempt('discovering_candidates', 'failure', `Creator following error: ${(err as Error).message}`);
            result.errors.push(`Creator following error: ${(err as Error).message}`);
        }

        // Step 3: Get AI recommendations (with Taste Profile generation)
        runTracker.startStage('ai_recommendations');
        let aiRecs: Recommendation[] = [];
        let tasteProfile: TasteProfile | null = null;
        const aiCfg = getConfig().ai;
        if (aiCfg.enabled && aiCfg.providerUrl && aiCfg.model && aiCfg.apiKey) {
            const initialAi = { ...aiCfg };
            const aiHealth = new ServiceAttemptAccumulator('ai', 'engine', undefined, undefined, () => JSON.stringify(getConfig().ai) === JSON.stringify(initialAi));
            try {
                addLog({ level: 'INFO', message: `🧠 Generating Taste Profile...`, source: 'engine' });
                tasteProfile = await generateTasteProfile(watchHistory, true);
                
                const rejectedTitles = feedbackProfile.rejectedTitles;

                aiRecs = await getAiRecommendations(watchHistory, tasteProfile, 10, filters, rejectedTitles, feedbackProfile, true);
                aiHealth.recordSuccess(); runTracker.recordAttempt('ai_recommendations', 'success');
                result.aiRecommendations = aiRecs.length;
                addLog({ level: 'INFO', message: `🤖 AI generated ${aiRecs.length} recommendations`, source: 'engine' });
            } catch (err) {
                aiHealth.recordFailure('AI recommendation request failed');
                runTracker.recordAttempt('ai_recommendations', 'failure', `AI error: ${(err as Error).message}`);
                result.errors.push(`AI error: ${(err as Error).message}`);
            }
            aiHealth.flush();
            runTracker.completeStage('ai_recommendations');
        } else {
            runTracker.skipStage('ai_recommendations', 'AI is disabled or not configured');
        }

        // Step 3b: Dynamic Keyword Discovery
        if (tasteProfile && tasteProfile.keywords && tasteProfile.keywords.length > 0) {
            try {
                addLog({ level: 'INFO', message: `🔍 Running dynamic keyword discovery for: ${tasteProfile.keywords.join(', ')}`, source: 'engine' });
                const keywordIds: number[] = [];
                for (const kw of tasteProfile.keywords) {
                    const id = await searchTmdbKeyword(kw, true);
                    if (id) keywordIds.push(id);
                }
                if (keywordIds.length > 0) {
                    const kwMovieRecs = await discoverByKeywords(keywordIds, 'movie', 5, preferredLanguages, true);
                    const kwTvRecs = await discoverByKeywords(keywordIds, 'series', 5, preferredLanguages, true);
                    allTmdbRecs.push(...kwMovieRecs, ...kwTvRecs);
                    tmdbHealth.recordSuccess(); runTracker.recordAttempt('discovering_candidates', 'success');
                    addLog({ level: 'INFO', message: `🔍 Keyword discovery added ${kwMovieRecs.length + kwTvRecs.length} recommendations`, source: 'engine' });
                }
            } catch (err) {
                tmdbHealth.recordFailure('TMDb keyword discovery failed');
                runTracker.recordAttempt('discovering_candidates', 'failure', `Keyword discovery error: ${(err as Error).message}`);
                result.errors.push(`Keyword discovery error: ${(err as Error).message}`);
            }
        }
        tmdbHealth.flush();
        runTracker.completeStage('discovering_candidates');
        runTracker.recordCandidateCounts({ tmdbCandidates: allTmdbRecs.length, aiCandidates: aiRecs.length });

        // Step 4: Merge, deduplicate, and save
        runTracker.startStage('processing_candidates');
        const allRecs = [...allTmdbRecs, ...aiRecs]
            .toSorted((a, b) => scoreRecommendation(b, feedbackProfile, preferredLanguages) - scoreRecommendation(a, feedbackProfile, preferredLanguages));
        const seen = new Set<string>();
        const newRecommendations: Recommendation[] = [];

        for (const rec of allRecs) {
            const key = rec.tmdbId ? `tmdb:${rec.tmdbId}` : `title:${rec.title.toLowerCase()}`;
            if (seen.has(key)) { runTracker.recordCandidateDisposition('duplicate'); continue; }
            seen.add(key);

            // Resolve missing metadata (poster, overview, genres) via TMDb
            if (!rec.posterUrl || !rec.tmdbId || !rec.language || !rec.genres?.length || !rec.overview || !rec.voteAverage) {
                const type = rec.mediaType === 'movie' ? 'movie' : 'tv';
                const tmdbResult = await searchTmdb(rec.title, type);

                if (tmdbResult) {
                    rec.tmdbId = tmdbResult.id;
                    rec.language = rec.language || tmdbResult.original_language;
                    rec.overview = rec.overview || tmdbResult.overview;
                    rec.posterUrl = rec.posterUrl || (tmdbResult.poster_path
                        ? `https://image.tmdb.org/t/p/w500${tmdbResult.poster_path}`
                        : undefined);
                    rec.voteAverage = rec.voteAverage || tmdbResult.vote_average;
                    rec.genres = rec.genres?.length ? rec.genres : (
                        tmdbResult.genre_ids?.map((id: number) => {
                            const GENRE_MAP: Record<number, string> = {
                                28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy',
                                80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
                                14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
                                9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 53: 'Thriller',
                                10752: 'War', 37: 'Western', 10759: 'Action & Adventure',
                                10765: 'Sci-Fi & Fantasy',
                            };
                            return GENRE_MAP[id] || '';
                        }).filter(Boolean)
                    );
                    rec.year = rec.year || (tmdbResult.release_date
                        ? parseInt(tmdbResult.release_date.substring(0, 4))
                        : tmdbResult.first_air_date
                            ? parseInt(tmdbResult.first_air_date.substring(0, 4))
                            : undefined);
                }

                // If we still don't have a poster and have a tmdbId, try getting details directly
                if ((!rec.posterUrl || !rec.language) && rec.tmdbId) {
                    try {
                        const detailType = rec.mediaType === 'movie' ? 'movie' : 'tv';
                        const detailResult = await searchTmdb(rec.title, detailType);
                        if (detailResult?.poster_path) {
                            rec.posterUrl = `https://image.tmdb.org/t/p/w500${detailResult.poster_path}`;
                        }
                        if (detailResult?.original_language && !rec.language) rec.language = detailResult.original_language;
                        if (detailResult && !rec.overview) rec.overview = detailResult.overview;
                        if (detailResult && !rec.voteAverage) rec.voteAverage = detailResult.vote_average;
                    } catch { /* ignore */ }
                }
            }

            // Check if already in Sonarr/Radarr library (using pre-fetched sets)
            let alreadyExists = false;
            const titleLower = rec.title.toLowerCase();

            if (rec.mediaType === 'movie') {
                // Check by TMDb ID first, then by title
                if (rec.tmdbId && (library.radarrTmdbIds.has(rec.tmdbId) || library.watchedTmdbIds.has(rec.tmdbId))) {
                    alreadyExists = true;
                } else if (library.radarrTitles.has(titleLower)) {
                    alreadyExists = true;
                }
            } else if (rec.mediaType === 'series') {
                // Resolve TVDB ID if needed
                if (!rec.tvdbId && rec.tmdbId) {
                    try {
                        const ext = await getTmdbExternalIds(rec.tmdbId, 'tv');
                        rec.tvdbId = ext.tvdb_id;
                    } catch { /* ignore */ }
                }
                // Check by TVDB ID first, then by title
                if (rec.tvdbId && (library.sonarrTvdbIds.has(rec.tvdbId) || library.watchedTvdbIds.has(rec.tvdbId))) {
                    alreadyExists = true;
                } else if (library.sonarrTitles.has(titleLower)) {
                    alreadyExists = true;
                }
            }

            // Also skip if title matches something already watched
            if (library.watchedTitles.has(titleLower) || (rec.imdbId && library.watchedImdbIds.has(rec.imdbId.toLowerCase()))) {
                alreadyExists = true;
            }
            if (alreadyExists) {
                runTracker.recordCandidateDisposition('existing_or_watched');
                addLog({ level: 'DEBUG', message: `Skipping "${rec.title}" — already in library or watched`, source: 'engine' });
                continue;
            }

            if (feedbackProfile.rejectedTitles.includes(titleLower)) {
                runTracker.recordCandidateDisposition('rejected_title');
                addLog({ level: 'DEBUG', message: `Skipping "${rec.title}" â€” explicitly rejected`, source: 'engine' });
                continue;
            }

            // Apply user filters
            if (filters) {
                // Genre filter
                if (filters.genres && filters.genres.length > 0) {
                    const recGenres = (rec.genres || []).map(g => g.toLowerCase());
                    const matchesGenre = filters.genres.some((fg: string) => recGenres.includes(fg.toLowerCase()));
                    if (!matchesGenre) {
                        runTracker.recordCandidateDisposition('user_filter');
                        addLog({ level: 'DEBUG', message: `Filtered out "${rec.title}" — does not match genre filter`, source: 'engine' });
                        continue;
                    }
                }
                if (filters.language && filters.language !== 'all') {
                    if (!rec.language || rec.language.toLowerCase() !== filters.language.toLowerCase()) {
                        runTracker.recordCandidateDisposition('user_filter');
                        addLog({ level: 'DEBUG', message: `Filtered out "${rec.title}" — language ${rec.language} doesn't match filter ${filters.language}`, source: 'engine' });
                        continue;
                    }
                }

                // Year range filter
                if (rec.year) {
                    if (filters.yearMin && rec.year < filters.yearMin) {
                        runTracker.recordCandidateDisposition('user_filter');
                        addLog({ level: 'DEBUG', message: `Filtered out "${rec.title}" (${rec.year}) — before year range`, source: 'engine' });
                        continue;
                    }
                    if (filters.yearMax && rec.year > filters.yearMax) {
                        runTracker.recordCandidateDisposition('user_filter');
                        addLog({ level: 'DEBUG', message: `Filtered out "${rec.title}" (${rec.year}) — after year range`, source: 'engine' });
                        continue;
                    }
                }
                // Media type filter
                if (filters.mediaType && filters.mediaType !== 'all' && rec.mediaType !== filters.mediaType) {
                    runTracker.recordCandidateDisposition('user_filter');
                    addLog({ level: 'DEBUG', message: `Filtered out "${rec.title}" — type ${rec.mediaType} doesn't match filter ${filters.mediaType}`, source: 'engine' });
                    continue;
                }
            }

            // Save to DB
            const saved = addRecommendationWithResult(rec);
            runTracker.recordCandidateDisposition(saved.inserted ? 'saved' : 'existing_or_watched');
            // "New" and auto-add both mean a row inserted during this run.
            if (saved.inserted) newRecommendations.push(saved.recommendation);
        }
        runTracker.completeStage('processing_candidates');

        result.totalNew = newRecommendations.length;
        addLog({ level: 'INFO', message: `💾 Saved ${newRecommendations.length} new unique recommendations`, source: 'engine' });

        // Step 5: Auto-add if configured
        const schedulerCfg = getConfig().scheduler;
        if (schedulerCfg.autoAdd) {
            runTracker.startStage('auto_adding');
            let applicableAutoAddAttempts = 0;
            for (const rec of newRecommendations) {
                try {
                    if (rec.mediaType === 'movie' && rec.tmdbId) {
                        if (!cfg.radarr.url || !cfg.radarr.apiKey) continue;
                        applicableAutoAddAttempts += 1;
                        runTracker.updateSummary({ autoAddAttempted: runTracker.getRun().summary.autoAddAttempted + 1 });
                        const res = await addMovieToRadarr(rec.tmdbId);
                        if (res.success) {
                            radarrHealth.recordSuccess('Radarr operation succeeded');
                            runTracker.recordAttempt('auto_adding', 'success');
                            updateRecommendationStatus(rec.id!, 'added');
                            result.addedToArr++;
                            runTracker.updateSummary({ addedToArr: result.addedToArr });
                        } else { radarrHealth.recordFailure(res.message); runTracker.recordAttempt('auto_adding', 'failure', res.message); }
                    } else if (rec.mediaType === 'series' && rec.tvdbId) {
                        if (!cfg.sonarr.url || !cfg.sonarr.apiKey) continue;
                        applicableAutoAddAttempts += 1;
                        runTracker.updateSummary({ autoAddAttempted: runTracker.getRun().summary.autoAddAttempted + 1 });
                        const res = await addSeriesToSonarr(rec.tvdbId);
                        if (res.success) {
                            sonarrHealth.recordSuccess('Sonarr operation succeeded');
                            runTracker.recordAttempt('auto_adding', 'success');
                            updateRecommendationStatus(rec.id!, 'added');
                            result.addedToArr++;
                            runTracker.updateSummary({ addedToArr: result.addedToArr });
                        } else { sonarrHealth.recordFailure(res.message); runTracker.recordAttempt('auto_adding', 'failure', res.message); }
                    }
                } catch (err) {
                    if (rec.mediaType === 'movie') radarrHealth.recordFailure('Radarr add operation failed');
                    else sonarrHealth.recordFailure('Sonarr add operation failed');
                    runTracker.recordAttempt('auto_adding', 'failure', `Add error for "${rec.title}": ${(err as Error).message}`);
                    result.errors.push(`Add error for "${rec.title}": ${(err as Error).message}`);
                }
            }
            if (applicableAutoAddAttempts === 0) runTracker.skipStage('auto_adding', 'No applicable configured Arr service');
            else runTracker.completeStage('auto_adding');
            addLog({ level: 'INFO', message: `📥 Auto-added ${result.addedToArr} items to Sonarr/Radarr`, source: 'engine' });
        } else runTracker.skipStage('auto_adding', 'Automatic adding is disabled');

        runTracker.startStage('finishing');
        radarrHealth.flush();
        sonarrHealth.flush();
        addLog({
            level: 'INFO',
            message: `✅ Run complete (${source}): ${result.totalNew} new recommendations, ${result.addedToArr} added`,
            source: 'engine',
            details: JSON.stringify({
                event: 'run_complete',
                source,
                totalNew: result.totalNew,
                addedToArr: result.addedToArr,
                errors: result.errors.length,
                runId,
            }),
        });

        await notifyRunResult(result, source);
        runTracker.completeStage('finishing');
        runTracker.finish({ coreCompleted: true });

        return result;
    } catch (error) {
        runTracker.finish({ coreCompleted: false, fatalError: (error as Error).message });
        throw error;
    } finally {
        radarrHealth?.flush();
        sonarrHealth?.flush();
        isRunning = false;
    }
}

// Approve and add a single recommendation
export interface AddOptions {
    qualityProfileId?: number;
    rootFolderPath?: string;
    searchForContent?: boolean;
}

export async function approveAndAdd(
    recommendationId: string,
    options: AddOptions = {}
): Promise<{ success: boolean; message: string }> {
    const rec = getRecommendationById(recommendationId);
    if (!rec) return { success: false, message: 'Recommendation not found' };

    try {
        if (rec.mediaType === 'movie') {
            // Use title-based Radarr lookup to verify correct movie
            const { lookupMovieByTerm } = await import('./radarr');
            const searchResults = await lookupMovieByTerm(rec.title);

            // Find the best match by title
            let matchedMovie = searchResults.find(
                (m: Record<string, unknown>) =>
                    (m.title as string || '').toLowerCase() === rec.title.toLowerCase()
            );

            // If no exact match, try fuzzy on first result
            if (!matchedMovie && searchResults.length > 0) {
                const firstResult = searchResults[0] as Record<string, unknown>;
                const firstTitle = (firstResult.title as string || '').toLowerCase();
                const recTitle = rec.title.toLowerCase();
                if (firstTitle.includes(recTitle) || recTitle.includes(firstTitle)) {
                    matchedMovie = firstResult;
                }
            }

            if (matchedMovie) {
                const correctTmdbId = matchedMovie.tmdbId as number;
                if (correctTmdbId) {
                    addLog({
                        level: 'INFO',
                        message: `Radarr matched "${rec.title}" → "${matchedMovie.title}" (tmdb:${correctTmdbId})`,
                        source: 'engine'
                    });

                    const result = await addMovieToRadarr(
                        correctTmdbId,
                        options.qualityProfileId,
                        options.rootFolderPath,
                        options.searchForContent
                    );
                    if (result.success) {
                        updateRecommendationStatus(recommendationId, 'added');
                        return { success: true, message: result.message };
                    }
                    return result;
                }
            }

            // Fallback: use TMDb ID directly if title search didn't work
            if (rec.tmdbId) {
                addLog({
                    level: 'WARN',
                    message: `Title search didn't match for "${rec.title}", falling back to tmdb:${rec.tmdbId}`,
                    source: 'engine'
                });
                const result = await addMovieToRadarr(
                    rec.tmdbId,
                    options.qualityProfileId,
                    options.rootFolderPath,
                    options.searchForContent
                );
                if (result.success) {
                    updateRecommendationStatus(recommendationId, 'added');
                    return { success: true, message: result.message };
                }
                return result;
            }
            return { success: false, message: `Could not find "${rec.title}" in Radarr lookup` };
        } else if (rec.mediaType === 'series') {
            // Use title-based Sonarr lookup (more reliable than TMDb's TVDb IDs)
            const { lookupSeriesByTerm } = await import('./sonarr');
            const searchResults = await lookupSeriesByTerm(rec.title);

            // Find the best match by title
            let matchedSeries = searchResults.find(
                (s: Record<string, unknown>) =>
                    (s.title as string || '').toLowerCase() === rec.title.toLowerCase()
            );

            // If no exact match, try a fuzzy match on the first result
            if (!matchedSeries && searchResults.length > 0) {
                const firstResult = searchResults[0] as Record<string, unknown>;
                const firstTitle = (firstResult.title as string || '').toLowerCase();
                const recTitle = rec.title.toLowerCase();
                // Only accept if the title is reasonably similar
                if (firstTitle.includes(recTitle) || recTitle.includes(firstTitle)) {
                    matchedSeries = firstResult;
                }
            }

            if (!matchedSeries) {
                // Fallback: try TVDb lookup if available
                if (rec.tvdbId) {
                    const result = await addSeriesToSonarr(
                        rec.tvdbId,
                        options.qualityProfileId,
                        options.rootFolderPath,
                        options.searchForContent
                    );
                    if (result.success) {
                        updateRecommendationStatus(recommendationId, 'added');
                    }
                    return result;
                }
                return { success: false, message: `Could not find "${rec.title}" in Sonarr lookup` };
            }

            // Use the TVDb ID from Sonarr's own lookup (most reliable)
            const correctTvdbId = matchedSeries.tvdbId as number;
            if (!correctTvdbId) {
                return { success: false, message: `No TVDb ID found for "${rec.title}"` };
            }

            addLog({
                level: 'INFO',
                message: `Sonarr matched "${rec.title}" → "${matchedSeries.title}" (tvdb:${correctTvdbId})`,
                source: 'engine'
            });

            const result = await addSeriesToSonarr(
                correctTvdbId,
                options.qualityProfileId,
                options.rootFolderPath,
                options.searchForContent
            );
            if (result.success) {
                updateRecommendationStatus(recommendationId, 'added');
                return { success: true, message: result.message };
            }
            return result;
        }
        return { success: false, message: 'Unknown media type' };
    } catch (err) {
        return { success: false, message: (err as Error).message };
    }
}

export interface BulkAddOptions extends AddOptions {
    mediaType: 'movie' | 'series';
}

export interface BulkAddResult {
    results: Array<{ id: string; outcome: 'added' | 'failed' | 'unchanged'; message: string }>;
    totals: { added: number; failed: number; unchanged: number };
}

export class BulkAddValidationError extends Error {
    readonly code = 'INVALID_BATCH';
}

export async function approveAndAddMany(
    recommendationIds: string[],
    options: BulkAddOptions,
    processItem: (id: string, options: AddOptions) => Promise<{ success: boolean; message: string }> = approveAndAdd,
): Promise<BulkAddResult> {
    const ids = Array.from(new Set(recommendationIds.map(id => id.trim()).filter(Boolean)));
    if (ids.length === 0 || ids.length > 100) throw new BulkAddValidationError('Bulk Add requires 1 to 100 unique recommendation IDs');
    const recommendations = ids.map(id => getRecommendationById(id));
    if (recommendations.some(item => !item)) throw new BulkAddValidationError('One or more recommendations were not found');
    if (recommendations.some(item => item!.mediaType !== options.mediaType)) throw new BulkAddValidationError('Bulk Add requires every recommendation to use the same media type');
    if (recommendations.some(item => item!.status !== 'pending')) throw new BulkAddValidationError('Bulk Add is available only for pending recommendations');

    const results: BulkAddResult['results'] = [];
    for (const id of ids) {
        try {
            const result = await processItem(id, options);
            results.push({ id, outcome: result.success ? 'added' : 'failed', message: result.message });
        } catch (error) {
            results.push({ id, outcome: 'failed', message: (error as Error).message });
        }
    }
    return {
        results,
        totals: {
            added: results.filter(item => item.outcome === 'added').length,
            failed: results.filter(item => item.outcome === 'failed').length,
            unchanged: results.filter(item => item.outcome === 'unchanged').length,
        },
    };
}
