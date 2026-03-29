import { state, persistPreferences } from '../../../shared/state.js';

const LEGACY_SETTINGS_STORAGE_KEY = 'qualifile-sync-manager-settings-v1';
const GLOBAL_PREFERENCES_STORAGE_KEY = 'qualifile-preferences';
const DEFAULT_REFRESH_INTERVAL_MS = 7000;
const ALLOWED_REFRESH_INTERVALS = [7000, 10000, 15000, 30000];
const ALLOWED_COLOR_STYLES = new Set(['pill', 'row']);

const DEFAULT_SYNC_MANAGER_PREFERENCES = Object.freeze({
    autoRefreshEnabled: true,
    autoRefreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
    showAdvancedRowActions: false,
    projectColorStyle: 'pill',
    activityPanelVisibleByDefault: true,
});

function normalizeRefreshIntervalMs(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_REFRESH_INTERVAL_MS;
    }
    const normalized = Math.round(parsed);
    if (ALLOWED_REFRESH_INTERVALS.includes(normalized)) {
        return normalized;
    }
    if (normalized < ALLOWED_REFRESH_INTERVALS[0]) {
        return ALLOWED_REFRESH_INTERVALS[0];
    }
    return ALLOWED_REFRESH_INTERVALS[ALLOWED_REFRESH_INTERVALS.length - 1];
}

function normalizeProjectColorStyle(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (ALLOWED_COLOR_STYLES.has(normalized)) {
        return normalized;
    }
    return DEFAULT_SYNC_MANAGER_PREFERENCES.projectColorStyle;
}

function normalizePreferences(value) {
    const candidate = value && typeof value === 'object' ? value : {};
    return {
        autoRefreshEnabled: Boolean(
            candidate.autoRefreshEnabled ?? DEFAULT_SYNC_MANAGER_PREFERENCES.autoRefreshEnabled,
        ),
        autoRefreshIntervalMs: normalizeRefreshIntervalMs(candidate.autoRefreshIntervalMs),
        showAdvancedRowActions: Boolean(
            candidate.showAdvancedRowActions ?? DEFAULT_SYNC_MANAGER_PREFERENCES.showAdvancedRowActions,
        ),
        projectColorStyle: normalizeProjectColorStyle(candidate.projectColorStyle),
        activityPanelVisibleByDefault: Boolean(
            candidate.activityPanelVisibleByDefault
                ?? DEFAULT_SYNC_MANAGER_PREFERENCES.activityPanelVisibleByDefault,
        ),
    };
}

function loadGlobalPreferencesPayload() {
    try {
        const raw = window.localStorage.getItem(GLOBAL_PREFERENCES_STORAGE_KEY);
        if (!raw) {
            return {};
        }
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_error) {
        return {};
    }
}

function loadLegacyPreferences() {
    try {
        const raw = window.localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }
        return {
            autoRefreshEnabled: Boolean(parsed.auto_refresh_enabled),
            autoRefreshIntervalMs: parsed.auto_refresh_interval_ms,
            showAdvancedRowActions: Boolean(parsed.show_advanced_row_actions),
            projectColorStyle: parsed.project_color_style,
            activityPanelVisibleByDefault: DEFAULT_SYNC_MANAGER_PREFERENCES.activityPanelVisibleByDefault,
        };
    } catch (_error) {
        return null;
    }
}

export function getDefaultSyncManagerPreferences() {
    return { ...DEFAULT_SYNC_MANAGER_PREFERENCES };
}

export function getSyncManagerPreferences() {
    if (!state.settings) {
        state.settings = {};
    }
    const normalized = normalizePreferences(state.settings.syncManager);
    state.settings.syncManager = normalized;
    return { ...normalized };
}

export function setSyncManagerPreferences(nextPreferences, { persist = true } = {}) {
    const current = getSyncManagerPreferences();
    const normalized = normalizePreferences({ ...current, ...(nextPreferences || {}) });
    if (!state.settings) {
        state.settings = {};
    }
    state.settings.syncManager = normalized;
    if (persist) {
        persistPreferences();
    }
    return { ...normalized };
}

export function migrateLegacySyncManagerPreferences() {
    const globalPayload = loadGlobalPreferencesPayload();
    const hasGlobalSyncManagerSettings = globalPayload
        && typeof globalPayload.syncManager === 'object'
        && globalPayload.syncManager !== null;

    const legacy = loadLegacyPreferences();
    if (legacy && !hasGlobalSyncManagerSettings) {
        const migrated = setSyncManagerPreferences(legacy, { persist: true });
        try {
            window.localStorage.removeItem(LEGACY_SETTINGS_STORAGE_KEY);
        } catch (_error) {
            // Ignore best-effort cleanup failures.
        }
        return migrated;
    }

    if (!hasGlobalSyncManagerSettings && legacy === null) {
        setSyncManagerPreferences(getDefaultSyncManagerPreferences(), { persist: false });
    }

    try {
        window.localStorage.removeItem(LEGACY_SETTINGS_STORAGE_KEY);
    } catch (_error) {
        // Ignore best-effort cleanup failures.
    }
    return getSyncManagerPreferences();
}

