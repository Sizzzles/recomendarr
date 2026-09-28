import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { getDatabase, getFeedbackProfile, getRecommendationCounts } from '@/lib/database';
import { getSchedulerSnapshot } from '@/lib/scheduler';
import { getRecentEngineRuns } from '@/lib/engine-runs';

export async function GET() {
    try {
        const db = getDatabase();
        const config = getConfig();
        const counts = getRecommendationCounts();
        const feedbackProfile = getFeedbackProfile();
        const durableRun = getRecentEngineRuns(1)[0] || null;
        const lastRun = durableRun ? {
            timestamp: durableRun.completedAt || durableRun.startedAt,
            source: durableRun.trigger,
            watched: durableRun.summary.watchedItemsProcessed,
            tmdbRecommendations: durableRun.summary.tmdbCandidates,
            aiRecommendations: durableRun.summary.aiCandidates,
            filtered: durableRun.summary.recommendationsSaved,
            totalNew: durableRun.summary.recommendationsSaved,
            addedToArr: durableRun.summary.addedToArr,
            errors: durableRun.summary.errorCount,
            candidates: durableRun.summary.candidatesConsidered,
            status: durableRun.status === 'succeeded' ? 'success' : durableRun.status === 'partial' ? 'warning' : 'error',
        } : null;
        const scheduler = getSchedulerSnapshot();

        const newRecommendationsThisWeek = (
            db.prepare(
                "SELECT COUNT(*) as count FROM recommendations WHERE datetime(created_at) >= datetime('now', '-7 days')"
            ).get() as { count: number }
        ).count;

        const topSources = (
            db.prepare(
                'SELECT source, COUNT(*) as count FROM recommendations GROUP BY source ORDER BY count DESC'
            ).all() as Array<{ source: 'tmdb' | 'ai'; count: number }>
        ).map((entry) => ({
            ...entry,
            percentage: counts.total > 0 ? Math.round((entry.count / counts.total) * 100) : 0,
        }));

        const approvalBase = counts.added + counts.rejected;
        const approvalRate = approvalBase > 0 ? Math.round((counts.added / approvalBase) * 100) : 0;
        const activeChannels = Number(config.notifications.discordEnabled) + Number(config.notifications.telegramEnabled);

        return NextResponse.json({
            approvalRate,
            newRecommendationsThisWeek,
            topSources,
            lastRun,
            pipeline: {
                watched: lastRun?.watched || 0,
                candidates: lastRun?.candidates || 0,
                filtered: lastRun?.filtered || lastRun?.totalNew || 0,
                pending: counts.pending,
                added: counts.added,
            },
            automation: {
                enabled: scheduler.enabled,
                cronSchedule: scheduler.cronSchedule,
                nextRun: scheduler.nextRun,
                autoAdd: scheduler.autoAdd,
                activeChannels,
                discordHealthy: config.notifications.discordEnabled && Boolean(config.notifications.discordWebhookUrl),
                telegramHealthy: config.notifications.telegramEnabled && Boolean(config.notifications.telegramBotToken && config.notifications.telegramChatId),
            },
            feedbackProfile,
        });
    } catch (err) {
        return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
}
