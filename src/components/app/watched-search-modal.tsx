'use client';

import { FormEvent, useEffect, useState } from 'react';
import Image from 'next/image';
import type { Recommendation } from '@/lib/types';

interface WatchedSearchModalProps {
    open: boolean;
    onClose: () => void;
    onAdded: (message: string) => void;
}

export function WatchedSearchModal({ open, onClose, onAdded }: WatchedSearchModalProps) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<Recommendation[]>([]);
    const [searching, setSearching] = useState(false);
    const [addingId, setAddingId] = useState<number | null>(null);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!open) {
            setQuery('');
            setResults([]);
            setError('');
        }
    }, [open]);

    if (!open) return null;

    const search = async (event: FormEvent) => {
        event.preventDefault();
        const trimmed = query.trim();
        if (!trimmed) return;
        setSearching(true);
        setError('');
        try {
            const params = new URLSearchParams({ query: trimmed });
            const response = await fetch(`/api/watched?${params}`);
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Search failed');
            setResults(data.results || []);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSearching(false);
        }
    };

    const add = async (recommendation: Recommendation) => {
        setAddingId(recommendation.tmdbId || null);
        setError('');
        try {
            const response = await fetch('/api/watched', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recommendation }),
            });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.error || 'Could not add watched title');
            onAdded(data.message || `${recommendation.title} added to Watched`);
            onClose();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setAddingId(null);
        }
    };

    return (
        <div className="sheet-overlay" onClick={() => addingId === null && onClose()}>
            <div className="sheet-card watched-search-sheet" onClick={(event) => event.stopPropagation()}>
                <div className="sheet-header">
                    <div>
                        <p className="sheet-eyebrow">Lifetime history</p>
                        <h3>Add a watched title</h3>
                    </div>
                    <button className="sheet-close" onClick={onClose} aria-label="Close watched search">x</button>
                </div>

                <div className="sheet-body">
                    <form className="watched-search-form" onSubmit={search}>
                        <input
                            type="search"
                            placeholder="Search for a movie or series"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            autoFocus
                        />
                        <button className="btn btn-primary" type="submit" disabled={searching || !query.trim()}>
                            {searching ? 'Searching...' : 'Search'}
                        </button>
                    </form>

                    {error && <p className="workspace-feedback-note">{error}</p>}
                    {!searching && results.length === 0 && query.trim() && !error && (
                        <p className="helper-copy">Search TMDb to find a movie or series you have watched.</p>
                    )}

                    <div className="watched-search-results">
                        {results.map((result) => (
                            <div className="watched-search-result" key={`${result.mediaType}-${result.tmdbId}`}>
                                {result.posterUrl ? (
                                    <Image src={result.posterUrl} alt="" width={54} height={78} unoptimized />
                                ) : (
                                    <div className="watched-search-poster-placeholder">No poster</div>
                                )}
                                <div>
                                    <strong>{result.title}</strong>
                                    <p>{result.mediaType === 'movie' ? 'Movie' : 'Series'}{result.year ? ` · ${result.year}` : ''}</p>
                                </div>
                                <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    disabled={addingId !== null}
                                    onClick={() => add(result)}
                                >
                                    {addingId === result.tmdbId ? 'Adding...' : 'Add to Watched'}
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
