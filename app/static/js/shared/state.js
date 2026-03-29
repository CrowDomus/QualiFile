/**
 * Central store for user preferences and UI state.
 */

import { normalizePath } from './paths.js';

const STORAGE_KEY = 'qualifile-preferences';
const ALLOWED_THEMES = new Set(['light', 'dark', 'light+', 'dark+']);
let preferenceSyncHandler = null;

/** Load persisted preferences from localStorage. */
function loadPreferences() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        return JSON.parse(raw);
    } catch (error) {
        console.warn('Unable to load preferences', error);
        return {};
    }
}

const preferences = loadPreferences();
const appElement = document.getElementById('app');
const portableFlag = appElement?.dataset?.portable === 'true';

function normalizeTheme(value) {
    if (ALLOWED_THEMES.has(value)) {
        return value;
    }
    return 'light';
}

const DEFAULT_SORT = { key: 'name', direction: 'ascending' };

function normalizeSort(value) {
    if (!value || typeof value !== 'object') {
        return { ...DEFAULT_SORT };
    }
    const key = typeof value.key === 'string' && value.key ? value.key : DEFAULT_SORT.key;
    const direction = value.direction === 'descending' ? 'descending' : DEFAULT_SORT.direction;
    return { key, direction };
}

function normalizeViewMode(value) {
    return value === 'grid' ? 'grid' : 'list';
}

function normalizeTagDisplayMode(value) {
    return value === 'dots' ? 'dots' : 'full';
}

function normalizeGreenshotEnabled(value, path) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
            return true;
        }
        if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
            return false;
        }
    }
    return Boolean((path || '').trim());
}

function normalizeOfficePreviewQuality(value, fallback = 'fast') {
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'fast' || normalized === 'standard') {
            return normalized;
        }
    }
    return fallback === 'fast' ? 'fast' : 'standard';
}

function normalizeSyncManagerRefreshInterval(value, fallback = 7000) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    const normalized = Math.round(parsed);
    const allowed = [7000, 10000, 15000, 30000];
    if (allowed.includes(normalized)) {
        return normalized;
    }
    if (normalized < allowed[0]) {
        return allowed[0];
    }
    return allowed[allowed.length - 1];
}

function normalizeSyncManagerProjectColorStyle(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'pill' || normalized === 'row') {
        return normalized;
    }
    return 'pill';
}

function resolveSyncManagerSettings(pref = {}) {
    const candidate = pref && typeof pref === 'object' ? pref : {};
    return {
        autoRefreshEnabled:
            candidate.autoRefreshEnabled === undefined ? true : !!candidate.autoRefreshEnabled,
        autoRefreshIntervalMs: normalizeSyncManagerRefreshInterval(
            candidate.autoRefreshIntervalMs,
            7000,
        ),
        showAdvancedRowActions:
            candidate.showAdvancedRowActions === undefined ? false : !!candidate.showAdvancedRowActions,
        projectColorStyle: normalizeSyncManagerProjectColorStyle(candidate.projectColorStyle),
        activityPanelVisibleByDefault:
            candidate.activityPanelVisibleByDefault === undefined
                ? true
                : !!candidate.activityPanelVisibleByDefault,
    };
}

function resolveColumns(pref = {}) {
    return {
        name: true,
        type: pref.type ?? false,
        size: pref.size ?? false,
        created: pref.created ?? false,
        modified: pref.modified ?? false,
    };
}

function resolveSettingsPanel(pref = {}) {
    return {
        activeSection: typeof pref.activeSection === 'string' ? pref.activeSection : 'general',
    };
}

function resolveLayout(pref) {
    const candidate = pref && typeof pref === 'object' ? pref : {};
    return {
        tree: candidate.tree ?? true,
        list: candidate.list ?? true,
        preview: candidate.preview ?? true,
    };
}

function resolveMergeDefaults(pref) {
    const candidate = pref && typeof pref === 'object' ? pref : {};
    return {
        paperSize: candidate.paperSize || 'A4',
        orientation: candidate.orientation || 'portrait',
        margin: candidate.margin ?? 10,
        fit: candidate.fit || 'contain',
        phraseAlignment: candidate.phraseAlignment || 'left',
        pageNumbers: candidate.pageNumbers ?? false,
        captionFontSizePt: normalizeMergeCaptionFontSizePt(candidate.captionFontSizePt, 14),
    };
}

function normalizeMergeCaptionFontSizePt(value, fallback = 14) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const rounded = Math.round(parsed);
    return Math.max(6, Math.min(48, rounded));
}

function normalizePositiveInteger(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    if (num <= 0) return null;
    return Math.round(num);
}

function canonicalPath(path) {
    const normalized = normalizePath(path);
    return normalized || '.';
}

const initialPath = canonicalPath('.');

export const state = {
    root: document.getElementById('app')?.dataset.root || '.',
    isPortable: portableFlag,
    currentPath: initialPath,
    includeSubfolders: false,
    items: [],
    subfolders: [],
    tags: [],
    tagAssignments: {},
    validation: {},
    tagDisplayMode: preferences.tagDisplayMode === 'dots' ? 'dots' : 'full',
    selection: new Set(),
    clipboard: null,
    sort: preferences.sort || { key: 'name', direction: 'ascending' },
    viewMode: preferences.viewMode || 'list',
    theme: normalizeTheme(preferences.theme),
    categorizeFiles: preferences.categorizeFiles ?? false,
    columns: resolveColumns(preferences.columns),
    layout: resolveLayout(preferences.layout),
    filters: {
        scope: 'current',
        tags: [],
        modifiedPreset: 'any',
        modifiedFrom: '',
        modifiedTo: '',
        folderName: '',
    },
    designMode: preferences.designMode === 'compact' ? 'compact' : 'expanded',
    sidebarPinned: preferences.sidebarPinned !== false,
    sidebarCompactLocked: preferences.sidebarCompactLocked === true,
    settingsPanel: resolveSettingsPanel(preferences.settingsPanel),
    navigation: {
        stack: [initialPath],
        index: 0,
    },
    settings: {
        softDelete: preferences.softDelete !== undefined ? preferences.softDelete : true,
        mergeDefaults: resolveMergeDefaults(preferences.mergeDefaults),
        preview: {
            showMetadata: preferences.preview?.showMetadata ?? false,
            officeQuality: normalizeOfficePreviewQuality(preferences.preview?.officeQuality, 'fast'),
        },
        tags: {
            hierarchyView: Boolean(preferences.tags?.hierarchyView),
        },
        screenshot: {
            mode: preferences.screenshot?.mode || 'rectangle',
            promptDetails: Boolean(preferences.screenshot?.promptDetails),
        },
        syncManager: resolveSyncManagerSettings(preferences.syncManager),
        greenshot: {
            path: (preferences.greenshot?.path || '').trim(),
            hotkey: preferences.greenshot?.hotkey || '',
            delay: (() => {
                const raw = preferences.greenshot?.delay;
                const value = typeof raw === 'number' ? raw : Number(raw);
                if (!Number.isFinite(value)) return 350;
                return Math.max(0, Math.round(value));
            })(),
            enabled: normalizeGreenshotEnabled(preferences.greenshot?.enabled, preferences.greenshot?.path || ''),
        },
        projects: (() => {
            const raw = preferences.projects || {};
            const legacy = raw.showExtraColumns;
            let showExtraColumns;
            if (legacy && typeof legacy === 'object') {
                showExtraColumns = {
                    description: !!legacy.description,
                    root: !!legacy.root,
                    parent: legacy.parent === undefined ? undefined : !!legacy.parent,
                    status: legacy.status === undefined ? true : !!legacy.status,
                    created: !!legacy.created,
                    modified: !!legacy.modified,
                };
            } else {
                const flag = legacy === true;
                showExtraColumns = {
                    description: flag,
                    root: flag,
                    parent: flag,
                    status: true,
                    created: flag,
                    modified: flag,
                };
            }
            const notePreviewLines = (() => {
                const rawLines = raw.notePreviewLines;
                const parsed = Number(rawLines);
                if (!Number.isFinite(parsed)) return 1;
                return Math.min(10, Math.max(1, Math.round(parsed)));
            })();
            const compactTaskPreview =
                raw.compactTaskPreview === undefined ? true : !!raw.compactTaskPreview;
            const projectColorStyle = (() => {
                const allowed = new Set(['none', 'row', 'pill']);
                const candidate =
                    typeof raw.projectColorStyle === 'string' ? raw.projectColorStyle.toLowerCase() : '';
                return allowed.has(candidate) ? candidate : 'pill';
            })();
            const taskHierarchyView =
                typeof raw.taskHierarchyView === 'boolean'
                    ? raw.taskHierarchyView
                    : typeof raw.timelineHierarchyView === 'boolean'
                      ? raw.timelineHierarchyView
                      : false;
            const legacyTimelineCollapsed = (() => {
                const rawCollapsed =
                    raw.timelineHierarchyCollapsedKeys || raw.timelineHierarchyCollapsed || raw.timelineHierarchy;
                if (Array.isArray(rawCollapsed)) {
                    return rawCollapsed.filter((key) => typeof key === 'string' && key);
                }
                if (rawCollapsed && typeof rawCollapsed === 'object') {
                    return Object.keys(rawCollapsed).filter((key) => rawCollapsed[key]);
                }
                return [];
            })();
            const collapsedSource =
                raw.taskHierarchyCollapsed && typeof raw.taskHierarchyCollapsed === 'object'
                    ? raw.taskHierarchyCollapsed
                    : Object.fromEntries(legacyTimelineCollapsed.map((key) => [key, true]));
            const collapsed = (() => {
                if (!collapsedSource || typeof collapsedSource !== 'object') return {};
                const entries = Object.entries(collapsedSource || {}).filter(
                    ([key, value]) => typeof key === 'string' && value === true,
                );
                return Object.fromEntries(entries.slice(0, 200));
            })();
            const deriveLayoutModeFromAux = (placement, tab) => {
                if (placement === 'hidden') return 'projects';
                if (placement === 'bottom' && tab === 'timeline') return 'both';
                if (placement === 'bottom' && tab === 'tasks') return 'tasks';
                if (placement === 'right' && tab === 'tasks') return 'tasks';
                return 'tasks';
            };
            const legacyLayoutMode = (() => {
                const allowed = new Set(['tasks', 'timeline', 'both', 'projects']);
                const candidate = typeof raw.layoutMode === 'string' ? raw.layoutMode.toLowerCase() : '';
                if (allowed.has(candidate)) return candidate;
                if (raw.previewPane === false) return 'projects';
                if (raw.previewPane === true) return 'tasks';
                return 'tasks';
            })();
            const legacyDefaults = (() => {
                switch (legacyLayoutMode) {
                    case 'timeline':
                        return { auxPlacement: 'bottom', auxTab: 'timeline' };
                    case 'projects':
                        return { auxPlacement: 'hidden', auxTab: 'tasks' };
                    case 'tasks':
                        return { auxPlacement: 'right', auxTab: 'tasks' };
                    case 'both':
                    default:
                        return { auxPlacement: 'bottom', auxTab: 'timeline' };
                }
            })();
            const auxPlacementRaw = typeof raw.auxPlacement === 'string' ? raw.auxPlacement.toLowerCase() : '';
            const auxTabRaw = typeof raw.auxTab === 'string' ? raw.auxTab.toLowerCase() : '';
            const hasAuxPlacement =
                auxPlacementRaw === 'right' || auxPlacementRaw === 'bottom' || auxPlacementRaw === 'hidden';
            const hasAuxTab = auxTabRaw === 'tasks' || auxTabRaw === 'timeline';
            const auxPlacement = hasAuxPlacement ? auxPlacementRaw : legacyDefaults.auxPlacement;
            const auxTab = hasAuxTab ? auxTabRaw : legacyDefaults.auxTab;
            const layoutMode =
                hasAuxPlacement || hasAuxTab
                    ? deriveLayoutModeFromAux(auxPlacement, auxTab)
                    : legacyLayoutMode;
            const paneSizes = (() => {
                const sizes = raw.paneSizes && typeof raw.paneSizes === 'object' ? raw.paneSizes : {};
                const normalized = {};
                const projectWidth = normalizePositiveInteger(sizes.projectsWidthPx);
                const taskWidth = normalizePositiveInteger(sizes.tasksWidthPx);
                const timelineHeight = normalizePositiveInteger(sizes.timelineHeightPx);
                const timelineLeftWidth = normalizePositiveInteger(
                    sizes.timelineLeftWidthPx ?? sizes.timelineLeftWidth,
                );
                if (projectWidth) normalized.projectsWidthPx = projectWidth;
                if (taskWidth) normalized.tasksWidthPx = taskWidth;
                if (timelineHeight) normalized.timelineHeightPx = timelineHeight;
                if (timelineLeftWidth) normalized.timelineLeftWidthPx = timelineLeftWidth;
                return normalized;
            })();
            const timelineSelectionMode =
                raw.timelineSelectionMode === 'custom' ? 'custom' : 'followMainSelection';
            const timelineProjectSelection = Array.isArray(raw.timelineProjectSelection)
                ? raw.timelineProjectSelection.filter((id) => typeof id === 'string' && id.trim())
                : [];
            const timelineVisibleColumns =
                raw.timelineVisibleColumns && typeof raw.timelineVisibleColumns === 'object'
                    ? {
                          project: raw.timelineVisibleColumns.project !== false,
                          start: raw.timelineVisibleColumns.start !== false,
                          end: raw.timelineVisibleColumns.end !== false,
                          duration: raw.timelineVisibleColumns.duration !== false,
                      }
                    : { project: true, start: true, end: true, duration: true };
            const timelineShowBarLabels = !!raw.timelineShowBarLabels;
            const timelineHighlightRows = !!raw.timelineHighlightRows;
            const timelineOpenTaskOnClick = !!raw.timelineOpenTaskOnClick;
            const timelineHierarchyLinkStyle = (() => {
                const allowed = new Set(['hover', 'bracket', 'none']);
                const candidate =
                    typeof raw.timelineHierarchyLinkStyle === 'string'
                        ? raw.timelineHierarchyLinkStyle.toLowerCase()
                        : '';
                return allowed.has(candidate) ? candidate : 'hover';
            })();
            return {
                nestedView: raw.nestedView ?? false,
                includeChildEntries: !!raw.includeChildEntries,
                taskHierarchyView,
                taskHierarchyCollapsed: collapsed,
                layoutMode,
                auxPlacement,
                auxTab,
                paneSizes,
                previewPane: auxPlacement !== 'hidden' && auxTab === 'tasks',
                previewMode: raw.previewMode === 'note' ? 'note' : 'task',
                showArchivedTasks: !!raw.showArchivedTasks,
                notePreviewLines,
                compactTaskPreview,
                projectColorStyle,
                showExtraColumns,
                timelineSelectionMode,
                timelineProjectSelection,
                timelineVisibleColumns,
                timelineShowBarLabels,
                timelineHighlightRows,
                timelineOpenTaskOnClick,
                timelineHierarchyLinkStyle,
            };
        })(),
    },
};

function hasOwn(payload, key) {
    return Object.prototype.hasOwnProperty.call(payload, key);
}

export function registerPreferenceSyncHandler(handler) {
    preferenceSyncHandler = typeof handler === 'function' ? handler : null;
}

export function applyPortablePreferences(payload) {
    if (!payload || typeof payload !== 'object') {
        return;
    }
    if (hasOwn(payload, 'sort')) {
        state.sort = normalizeSort(payload.sort);
    }
    if (hasOwn(payload, 'viewMode')) {
        state.viewMode = normalizeViewMode(payload.viewMode);
    }
    if (hasOwn(payload, 'theme')) {
        state.theme = normalizeTheme(payload.theme);
    }
    if (hasOwn(payload, 'categorizeFiles')) {
        state.categorizeFiles = payload.categorizeFiles ?? false;
    }
    if (hasOwn(payload, 'tagDisplayMode')) {
        state.tagDisplayMode = normalizeTagDisplayMode(payload.tagDisplayMode);
    }
    if (hasOwn(payload, 'columns')) {
        state.columns = resolveColumns(payload.columns || {});
    }
    if (hasOwn(payload, 'layout')) {
        state.layout = resolveLayout(payload.layout);
    }
    if (hasOwn(payload, 'designMode')) {
        state.designMode = payload.designMode === 'compact' ? 'compact' : 'expanded';
    }
    if (hasOwn(payload, 'sidebarPinned')) {
        state.sidebarPinned = payload.sidebarPinned !== false;
    }
    if (hasOwn(payload, 'sidebarCompactLocked')) {
        state.sidebarCompactLocked = payload.sidebarCompactLocked === true;
    }
    if (hasOwn(payload, 'softDelete')) {
        state.settings.softDelete =
            payload.softDelete === undefined || payload.softDelete === null
                ? true
                : !!payload.softDelete;
    }
    if (hasOwn(payload, 'mergeDefaults')) {
        state.settings.mergeDefaults = resolveMergeDefaults(payload.mergeDefaults);
    }
    if (hasOwn(payload, 'preview')) {
        const preview = payload.preview;
        const showMetadata =
            preview && typeof preview === 'object' ? preview.showMetadata : null;
        state.settings.preview.showMetadata = Boolean(showMetadata);
        const officeQuality =
            preview && typeof preview === 'object' ? preview.officeQuality : null;
        state.settings.preview.officeQuality = normalizeOfficePreviewQuality(
            officeQuality,
            state.settings.preview.officeQuality || 'fast',
        );
    }
    if (hasOwn(payload, 'tags')) {
        const tags = payload.tags;
        const hierarchyView =
            tags && typeof tags === 'object' ? tags.hierarchyView : null;
        state.settings.tags.hierarchyView = Boolean(hierarchyView);
    }
    if (hasOwn(payload, 'greenshot')) {
        const greenshot = payload.greenshot;
        if (greenshot && typeof greenshot === 'object') {
            const nextPath = (greenshot.path ?? state.settings.greenshot.path ?? '').toString().trim();
            state.settings.greenshot = {
                path: nextPath,
                hotkey: (greenshot.hotkey ?? state.settings.greenshot.hotkey ?? '').toString(),
                delay: (() => {
                    const raw = greenshot.delay ?? state.settings.greenshot.delay;
                    const value = typeof raw === 'number' ? raw : Number(raw);
                    if (!Number.isFinite(value)) return 350;
                    return Math.max(0, Math.round(value));
                })(),
                enabled: normalizeGreenshotEnabled(greenshot.enabled, nextPath),
            };
        }
    }
    if (hasOwn(payload, 'syncManager')) {
        state.settings.syncManager = resolveSyncManagerSettings(payload.syncManager);
    }
}

/** Persist user preferences to localStorage. */
export function persistPreferences() {
    state.columns.name = true;
    const payload = {
        sort: state.sort,
        viewMode: state.viewMode,
        theme: state.theme,
        categorizeFiles: !!state.categorizeFiles,
        tagDisplayMode: state.tagDisplayMode,
        softDelete: state.settings.softDelete,
        mergeDefaults: state.settings.mergeDefaults,
        columns: state.columns,
        layout: state.layout,
        preview: state.settings.preview,
        screenshot: state.settings.screenshot,
        syncManager: state.settings.syncManager,
        greenshot: state.settings.greenshot,
        tags: state.settings.tags,
        projects: state.settings.projects,
        designMode: state.designMode,
        sidebarPinned: state.sidebarPinned !== false,
        sidebarCompactLocked: state.sidebarCompactLocked === true,
    };
    const collapsed = {};
    payload.settingsPanel = {
        activeSection: state.settingsPanel?.activeSection || 'general',
        collapsed,
    };
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
        console.warn('Unable to persist preferences', error);
    }
    if (preferenceSyncHandler) {
        try {
            const result = preferenceSyncHandler(payload);
            if (result && typeof result.catch === 'function') {
                result.catch((error) => {
                    console.warn('Unable to sync preferences', error);
                });
            }
        } catch (error) {
            console.warn('Unable to sync preferences', error);
        }
    }
}

/** Replace the current selection with the provided paths. */
export function setSelection(paths) {
    state.selection = new Set(paths);
}

/** Clear all selected items. */
export function clearSelection() {
    state.selection.clear();
}

/** Return the selection as an array. */
export function selectionArray() {
    return Array.from(state.selection);
}

/** Update the active folder path and subfolder toggle. */
export function updateCurrentPath(path, includeSubfolders = false) {
    state.currentPath = canonicalPath(path);
    state.includeSubfolders = includeSubfolders;
}

export function recordNavigation(path) {
    const canonical = canonicalPath(path);
    const { navigation } = state;
    if (!navigation) return;
    const current = navigation.stack[navigation.index];
    if (current === canonical) {
        return;
    }
    navigation.stack = navigation.stack.slice(0, navigation.index + 1);
    navigation.stack.push(canonical);
    navigation.index = navigation.stack.length - 1;
}

export function canNavigateBack() {
    return state.navigation?.index > 0;
}

export function canNavigateForward() {
    if (!state.navigation) return false;
    return state.navigation.index < state.navigation.stack.length - 1;
}

export function stepBackInHistory() {
    if (!canNavigateBack()) return null;
    state.navigation.index -= 1;
    return state.navigation.stack[state.navigation.index] || '.';
}

export function stepForwardInHistory() {
    if (!canNavigateForward()) return null;
    state.navigation.index += 1;
    return state.navigation.stack[state.navigation.index] || '.';
}

/** Store clipboard metadata for copy/move operations. */
export function setClipboard(data) {
    if (!data) {
        state.clipboard = null;
        return;
    }
    const items = Array.isArray(data.items) ? [...new Set(data.items.map(String))] : [];
    state.clipboard = {
        operation: data.operation === 'move' ? 'move' : 'copy',
        items,
        kind: data.kind || 'mixed',
        source: data.source || null,
        timestamp: Date.now(),
    };
}

/** Retrieve the currently stored clipboard payload. */
export function getClipboard() {
    if (!state.clipboard) return null;
    return { ...state.clipboard, items: [...state.clipboard.items] };
}

/** Clear the clipboard payload. */
export function clearClipboard() {
    state.clipboard = null;
}
