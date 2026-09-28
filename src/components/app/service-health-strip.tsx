'use client';

import type { EffectiveServiceHealth } from '@/lib/engine-observability-types';

const LABELS = { media_server: 'Media', tmdb: 'TMDb', ai: 'AI', sonarr: 'Sonarr', radarr: 'Radarr' };

export function ServiceHealthStrip({ services, rich = false }: { services: EffectiveServiceHealth[]; rich?: boolean }) {
    return <section className={`service-health-strip ${rich ? 'rich' : 'compact'}`} aria-label="Service health">
        {services.map(item => <div key={item.service} className={`service-health-item health-${item.state}`}
            aria-label={`${LABELS[item.service]}: ${item.state}. ${item.reason}`}>
            <span className="health-badge-dot" aria-hidden="true" />
            <div><strong>{LABELS[item.service]}</strong>{rich && <small>{item.reason}</small>}</div>
            <span>{item.state.replace('_', ' ')}</span>
        </div>)}
    </section>;
}
