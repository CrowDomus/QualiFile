export const ACTIVITY_LAYOUT_STORAGE_KEY = 'qualifile-sync-manager-layout-v1';
export const ACTIVITY_DEFAULT_PANEL_WIDTH = 360;
export const ACTIVITY_MIN_PANEL_WIDTH = 288;
export const ACTIVITY_MAX_PANEL_WIDTH = 544;

function parsePanelWidth(value, fallback = ACTIVITY_DEFAULT_PANEL_WIDTH) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(
        ACTIVITY_MAX_PANEL_WIDTH,
        Math.max(ACTIVITY_MIN_PANEL_WIDTH, Math.round(parsed)),
    );
}

export function clampActivityPanelWidth(value, fallback = ACTIVITY_DEFAULT_PANEL_WIDTH) {
    return parsePanelWidth(value, fallback);
}

function readPanelWidthFromStorage(storage, keyName, payloadKey = 'panel_width') {
    if (!storage || !keyName) {
        return null;
    }
    try {
        const raw = storage.getItem(keyName);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }
        if (parsed[payloadKey] === undefined) {
            return null;
        }
        return parsePanelWidth(parsed[payloadKey], null);
    } catch (_error) {
        return null;
    }
}

export function restoreActivityPanelWidth({
    layoutStorageKey = ACTIVITY_LAYOUT_STORAGE_KEY,
    legacySessionStorageKey = '',
} = {}) {
    const localWidth = readPanelWidthFromStorage(window.localStorage, layoutStorageKey, 'panel_width');
    if (Number.isFinite(localWidth)) {
        return localWidth;
    }
    const legacyWidth = readPanelWidthFromStorage(window.sessionStorage, legacySessionStorageKey, 'width');
    if (Number.isFinite(legacyWidth)) {
        persistActivityPanelWidth(legacyWidth, { layoutStorageKey });
        return legacyWidth;
    }
    return ACTIVITY_DEFAULT_PANEL_WIDTH;
}

export function persistActivityPanelWidth(
    width,
    { layoutStorageKey = ACTIVITY_LAYOUT_STORAGE_KEY } = {},
) {
    const normalizedWidth = parsePanelWidth(width);
    try {
        window.localStorage.setItem(
            layoutStorageKey,
            JSON.stringify({ panel_width: normalizedWidth }),
        );
    } catch (_error) {
        // Local storage is best effort only.
    }
    return normalizedWidth;
}

