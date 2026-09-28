import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ConnectionTestResult } from '../src/components/app/connection-test-result';
import {
    getServiceGuidance,
    getServiceGuidanceId,
    getServiceTestAccessibleName,
} from '../src/components/app/service-guidance';
import { DEFAULT_SETTINGS_FORM } from '../src/components/app/models';

describe('service guidance', () => {
    it('provides unique service test names and stable guidance relationships', () => {
        expect(getServiceTestAccessibleName('mediaServer')).toBe('Test media server connection');
        expect(getServiceTestAccessibleName('sonarr')).toBe('Test Sonarr connection');
        expect(getServiceTestAccessibleName('radarr')).toBe('Test Radarr connection');
        expect(getServiceTestAccessibleName('ai')).toBe('Test AI provider connection');
        expect(getServiceTestAccessibleName('discord')).toBe('Send Discord test notification');
        expect(getServiceTestAccessibleName('telegram')).toBe('Send Telegram test notification');

        expect(getServiceGuidanceId('mediaServer')).toBe('media-server-guidance');
        expect(getServiceGuidanceId('telegram')).toBe('telegram-guidance');
    });

    it('distinguishes authenticated and manual Plex requirements', () => {
        expect(getServiceGuidance('mediaServer', { ...DEFAULT_SETTINGS_FORM, media_server_type: 'plex' }, true).join(' '))
            .toContain('authenticated server');
        expect(getServiceGuidance('mediaServer', { ...DEFAULT_SETTINGS_FORM, media_server_type: 'plex' }, false).join(' '))
            .toContain('server URL and Plex token');
    });

    it('describes actual media, Arr, AI, notification, scheduler, and TMDb requirements', () => {
        expect(getServiceGuidance('mediaServer', { ...DEFAULT_SETTINGS_FORM, media_server_type: 'jellyfin' }, false).join(' '))
            .toContain('server URL and API key');
        expect(getServiceGuidance('sonarr', DEFAULT_SETTINGS_FORM, false).join(' '))
            .toMatch(/URL and API key.*quality profile and root folder/i);
        expect(getServiceGuidance('radarr', DEFAULT_SETTINGS_FORM, false).join(' '))
            .toMatch(/URL and API key.*quality profile and root folder/i);
        expect(getServiceGuidance('tmdb', DEFAULT_SETTINGS_FORM, false).join(' '))
            .toMatch(/optional.*built-in key/i);
        expect(getServiceGuidance('ai', { ...DEFAULT_SETTINGS_FORM, ai_enabled: 'true' }, false).join(' '))
            .toContain('Provider URL, model, and API key are required');
        expect(getServiceGuidance('discord', { ...DEFAULT_SETTINGS_FORM, discord_enabled: 'true' }, false).join(' '))
            .toContain('webhook URL is required');
        expect(getServiceGuidance('telegram', { ...DEFAULT_SETTINGS_FORM, telegram_enabled: 'true' }, false).join(' '))
            .toContain('bot token and chat ID are required');
        expect(getServiceGuidance('scheduler', { ...DEFAULT_SETTINGS_FORM, scheduler_enabled: 'true' }, false).join(' '))
            .toContain('valid cron schedule is required');
    });
});

describe('inline connection result', () => {
    it('renders idle, testing, success, and failure with textual status', () => {
        expect(renderToStaticMarkup(createElement(ConnectionTestResult, { result: undefined }))).toContain('Not tested');
        expect(renderToStaticMarkup(createElement(ConnectionTestResult, { result: { testing: true } }))).toContain('Testing connection');
        expect(renderToStaticMarkup(createElement(ConnectionTestResult, { result: { testing: false, success: true, data: { success: true, message: 'Connected to Sonarr' } } })))
            .toContain('Connected to Sonarr');
        expect(renderToStaticMarkup(createElement(ConnectionTestResult, { result: { testing: false, success: false, data: { success: false, message: 'Check URL and API key' } } })))
            .toContain('Check URL and API key');
    });
});
