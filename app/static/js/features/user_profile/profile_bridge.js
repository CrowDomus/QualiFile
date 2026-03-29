import { registerPreferenceSyncHandler } from '../../shared/state.js';
import { requestJson } from '../../shared/api.js';
import { hydratePortablePreferences } from './preference_hydration.js';

const PROFILE_ENDPOINT = '/api/profile';
const ENABLED_MODES = new Set(['shadow', 'on']);
const SYNC_DELAY_MS = 150;
const ERROR_LOG_INTERVAL_MS = 30000;

let pendingPayload = null;
let syncTimer = null;
let syncInFlight = false;
let lastSyncErrorAt = 0;
let profileActive = false;

function getProfileMode() {
    const root = document.documentElement;
    const raw = root?.dataset?.profileMode || document.body?.dataset?.profileMode || '';
    return String(raw || '').trim().toLowerCase();
}

function logSyncError(error) {
    const now = Date.now();
    if (now - lastSyncErrorAt < ERROR_LOG_INTERVAL_MS) {
        return;
    }
    lastSyncErrorAt = now;
    console.warn('Unable to sync profile preferences', error);
}

async function flushSync() {
    if (syncInFlight || !pendingPayload) {
        return;
    }
    const payload = pendingPayload;
    pendingPayload = null;
    syncInFlight = true;
    try {
        await requestJson(PROFILE_ENDPOINT, {
            method: 'PATCH',
            body: JSON.stringify({ portable_preferences: payload }),
        });
    } catch (error) {
        logSyncError(error);
    } finally {
        syncInFlight = false;
    }
    if (pendingPayload) {
        scheduleSync(pendingPayload);
    }
}

function scheduleSync(payload) {
    pendingPayload = payload;
    if (syncTimer) {
        return;
    }
    syncTimer = setTimeout(() => {
        syncTimer = null;
        flushSync();
    }, SYNC_DELAY_MS);
}

export async function initProfilePreferencesBridge() {
    const mode = getProfileMode();
    if (!ENABLED_MODES.has(mode)) {
        return;
    }
    document.addEventListener('qualifile:profile-change', (event) => {
        profileActive = Boolean(event.detail?.profile);
    });
    registerPreferenceSyncHandler((payload) => {
        if (payload && typeof payload === 'object') {
            if (!profileActive) {
                return null;
            }
            scheduleSync(payload);
        }
        return null;
    });
    if (mode !== 'on') {
        return;
    }
    try {
        const response = await requestJson(PROFILE_ENDPOINT);
        if (!response || !response.profile) {
            return;
        }
        profileActive = true;
        const portable = response.portable_preferences || {};
        if (portable && typeof portable === 'object') {
            hydratePortablePreferences(portable);
        }
    } catch (error) {
        console.warn('Unable to load profile preferences', error);
    }
}
