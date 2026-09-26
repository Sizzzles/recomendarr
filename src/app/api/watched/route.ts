import { NextResponse } from 'next/server';
import { addWatchedRecommendation } from '@/lib/database';
import { getTmdbExternalIds, searchTmdbTitles } from '@/lib/tmdb';
import type { Recommendation } from '@/lib/types';

export async function GET(request: Request) {
    try {
        const query = new URL(request.url).searchParams.get('query')?.trim() || '';
        if (!query) {
            return NextResponse.json({ results: [] });
        }

        const results = await searchTmdbTitles(query);
        return NextResponse.json({ results });
    } catch (err) {
        return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const recommendation = body.recommendation as Recommendation | undefined;
        if (
            !recommendation?.title ||
            !recommendation.tmdbId ||
            !['movie', 'series'].includes(recommendation.mediaType)
        ) {
            return NextResponse.json({ error: 'A valid TMDb movie or series is required' }, { status: 400 });
        }

        const tmdbType = recommendation.mediaType === 'movie' ? 'movie' : 'tv';
        const externalIds = await getTmdbExternalIds(recommendation.tmdbId, tmdbType);
        const saved = addWatchedRecommendation({
            ...recommendation,
            tvdbId: externalIds.tvdb_id,
            imdbId: externalIds.imdb_id,
            source: 'tmdb',
            status: 'watched',
        });

        return NextResponse.json({
            success: true,
            recommendation: saved,
            message: `${saved.title} added to Watched`,
        });
    } catch (err) {
        return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
}
