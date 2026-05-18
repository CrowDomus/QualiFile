import { openFolderPicker } from '../filesystem/folder_picker.js';
import { state, persistPreferences } from '../../shared/state.js';
import { initTheme } from '../../shared/theme.js';
import { fetchProjectEntries, createProjectEntry, updateProjectEntry, deleteProjectEntry } from './entries.js';
import { createLinkedNote, ensureLinkedNotes, getLinkedNotesCache } from './linked_notes.js';
import { openProjectFilePicker } from './file_picker.js';
import { requestJson } from '../../shared/api.js';
import { initToast, showToast } from '../../shared/ui.js';
import { pickReadableTextColor } from '../../shared/color-utils.js';
import { normalizePath } from '../../shared/paths.js';
import {
    chooseDisableActiveAlertAction,
    createTaskReminderFormController,
    isDisableChoiceRequiredError,
} from '../task_alerts/reminder_form.js';
import { initTimelineController } from '../timeline/index.js';
import { initTimelineHeaderControls } from '../timeline/header_controls.js';

const tableBody = document.getElementById('projects-body');
const emptyRow = document.getElementById('projects-empty');
const form = document.getElementById('project-form');
const modalElement = document.getElementById('project-modal');
const modalError = document.getElementById('project-form-error');
const nameInput = document.getElementById('project-name');
const descriptionInput = document.getElementById('project-description');
const rootInput = document.getElementById('project-root');
const browseButton = document.getElementById('project-root-browse');
const parentSelect = document.getElementById('project-parent');
const statusSelect = document.getElementById('project-status');
const colorInput = document.getElementById('project-color');
const colorPalette = document.getElementById('project-color-palette');
const colorValueBadge = document.getElementById('project-color-value');
const colorClearButton = document.getElementById('project-color-clear');
const saveButton = document.getElementById('project-save');
const tagsImportSection = document.getElementById('project-tags-import-section');
const tagsImportControls = document.getElementById('project-tags-import-controls');
const tagsImportEmptyNote = document.getElementById('project-tags-import-empty-note');
const tagsImportSource = document.getElementById('project-tags-import-source');
const tagsImportMode = document.getElementById('project-tags-import-mode');
const newButtons = [
    document.getElementById('action-new-project'),
    document.getElementById('action-new-project-secondary'),
];
const entryModalEl = document.getElementById('project-entry-modal');
const entryForm = document.getElementById('project-entry-form');
const entryModeSelect = document.getElementById('project-entry-mode');
const linkedNoteToggleWrap = document.getElementById('project-entry-linked-toggle-wrap');
const linkedNoteToggle = document.getElementById('project-entry-linked-toggle');
const linkedNoteHelp = document.getElementById('project-entry-linked-help');
const linkedNotePathWrap = document.getElementById('project-entry-linked-path-wrap');
const linkedNotePathInput = document.getElementById('project-entry-linked-path');
const linkedNoteTargetFolder = document.getElementById('project-entry-linked-target-folder');
const linkedNoteTargetFile = document.getElementById('project-entry-linked-target-file');
const linkedNoteBrowseButton = document.getElementById('project-entry-linked-browse');
const linkedNotePathHelp = document.getElementById('project-entry-linked-path-help');
const entryTitle = document.getElementById('project-entry-title');
const entryText = document.getElementById('project-entry-text');
const entryPriority = document.getElementById('project-entry-priority');
const entryStatus = document.getElementById('project-entry-status');
const entryDeadline = document.getElementById('project-entry-deadline');
const entryStart = document.getElementById('project-entry-start');
const entryEnd = document.getElementById('project-entry-end');
const entryReminderWrap = document.querySelector('[data-field="reminder"]');
const entryReminderEnabled = document.getElementById('project-entry-reminder-enabled');
const entryReminderMode = document.getElementById('project-entry-reminder-mode');
const entryReminderDaysWrap = document.getElementById('project-entry-reminder-days-wrap');
const entryReminderDays = document.getElementById('project-entry-reminder-days-before');
const entryAutoRollupWrap = document.getElementById('entryAutoRollupWrap');
const entryAutoRollupDates = document.getElementById('entryAutoRollupDates');
const entryAutoRollupHelp = document.getElementById('entryAutoRollupHelp');
const entryColor = document.getElementById('project-entry-color');
const entryTitleInput = document.getElementById('project-entry-title-input');
const entryParentProjectSelect = document.getElementById('project-entry-parent-project');
const entryParentProjectSelectWrap = document.getElementById('project-entry-parent-project-select-wrap');
const entryParentProjectReadonlyWrap = document.getElementById('project-entry-parent-project-readonly-wrap');
const entryParentProjectReadonlyInput = document.getElementById('project-entry-parent-project-readonly');
const entryParentTaskSelect = document.getElementById('project-entry-parent-task');
const entryAlert = document.getElementById('project-entry-alert');
const entryAlertText = document.querySelector('#project-entry-alert .project-entry-alert-text');
const entryAlertDismiss = document.getElementById('project-entry-alert-dismiss');
const entrySaveButton = document.getElementById('project-entry-save');
const layoutToggleButton = document.getElementById('projects-layout-toggle');
const layoutPlacementOptions = document.querySelectorAll('.projects-layout-placement');
const layoutContentOptions = document.querySelectorAll('.projects-layout-content');
const auxTabButtons = document.querySelectorAll('.projects-aux-tab');
const columnsToggleButton = document.getElementById('projects-columns-toggle');
const columnsToggleGroup = document.getElementById('projects-columns-group');
const columnToggleInputs = document.querySelectorAll('[data-column-toggle]');
const selectAllCheckbox = document.getElementById('projects-select-all');
const projectsLayout = document.getElementById('projects-layout');
const projectsTop = document.getElementById('projects-top');
const projectsPane = document.getElementById('projects-pane');
const projectsPreview = document.getElementById('projects-preview');
const projectsTimeline = document.getElementById('projects-timeline');
const auxRightHost = document.getElementById('projects-aux-right-host');
const auxBottomHost = document.getElementById('projects-aux-bottom-host');
const timelineRoot = document.getElementById('timeline-root');
const timelineRangeLabel = document.getElementById('timeline-range-label');
const timelineProjectsToggle = document.getElementById('timeline-projects-toggle');
const timelineProjectsOptions = document.getElementById('timeline-projects-options');
const timelineProjectsClear = document.getElementById('timeline-projects-clear');
const timelineProjectsFollow = document.getElementById('timeline-projects-follow');
const timelineColumnsToggle = document.getElementById('timeline-columns-toggle');
const timelineColumnProject = document.getElementById('timeline-col-project');
const timelineColumnStart = document.getElementById('timeline-col-start');
const timelineColumnEnd = document.getElementById('timeline-col-end');
const timelineColumnDuration = document.getElementById('timeline-col-duration');
const timelineSettingBarLabels = document.getElementById('timeline-setting-bar-labels');
const timelineSettingHighlightRows = document.getElementById('timeline-setting-highlight-rows');
const timelineZoomOut = document.getElementById('timeline-zoom-out');
const timelineZoomIn = document.getElementById('timeline-zoom-in');
const timelineZoomSlider = document.getElementById('timeline-zoom-slider');
const timelineZoomFit = document.getElementById('timeline-zoom-fit');
const timelineZoomValue = document.getElementById('timeline-zoom-value');
const timelineFilterStatus = document.getElementById('timeline-filter-status');
const timelineFilterPriority = document.getElementById('timeline-filter-priority');
const timelineFilterHideUndated = document.getElementById('timeline-filter-hide-undated');
const timelineFilterShowArchived = document.getElementById('timeline-filter-show-archived');
const timelineFilterReset = document.getElementById('timeline-filter-reset');
const timelineFiltersToggle = document.getElementById('timeline-filters-toggle');
const timelineHierarchyEnabled = document.getElementById('timeline-hierarchy-enabled');
const verticalSplitter = document.getElementById('projects-vertical-splitter');
const horizontalSplitter = document.getElementById('projects-horizontal-splitter');
const previewTitle = document.getElementById('projects-preview-title');
const previewSubtitle = document.getElementById('projects-preview-subtitle');
const timelineHeaderControlsEl = document.getElementById('timeline-header-controls');
const timelineHeaderHost = document.getElementById('projects-timeline-header-host');
const previewTitleDefault = previewTitle?.textContent?.trim() || 'Tasks & Notes';
const timelineHeaderHome = timelineHeaderControlsEl ? timelineHeaderControlsEl.parentElement : null;
const previewModeBadge = document.getElementById('projects-preview-mode-badge');
const previewTabTasks = document.getElementById('projects-preview-tab-tasks');
const previewTabNotes = document.getElementById('projects-preview-tab-notes');
const previewArchivedToggle = document.getElementById('projects-preview-archived');
const previewArchivedWrapper = document.getElementById('projects-preview-archived-wrapper');
const previewNewButton = document.getElementById('projects-preview-new');
const previewFiltersToggleButton = document.getElementById('projects-preview-filters-toggle');
const previewFiltersContainer = document.getElementById('projects-preview-filters');
const previewFiltersResetButton = document.getElementById('projects-preview-filters-reset');
const previewTaskFilters = document.getElementById('projects-preview-task-filters');
const previewNoteFilters = document.getElementById('projects-preview-note-filters');
const filterTaskPriority = document.getElementById('filter-task-priority');
const filterTaskStatus = document.getElementById('filter-task-status');
const filterTaskProject = document.getElementById('filter-task-project');
const filterTaskStartFrom = document.getElementById('filter-task-start');
const filterTaskEndUntil = document.getElementById('filter-task-end');
const filterTaskMinDuration = document.getElementById('filter-task-duration-min');
const filterTaskMaxDuration = document.getElementById('filter-task-duration-max');
const filterNotePriority = document.getElementById('filter-note-priority');
const filterNoteProject = document.getElementById('filter-note-project');
const filterNoteCreatedFrom = document.getElementById('filter-note-created-from');
const filterNoteCreatedUntil = document.getElementById('filter-note-created-until');
const previewList = document.getElementById('projects-preview-list');
const previewPlaceholder = document.getElementById('projects-preview-placeholder');
const previewLoading = document.getElementById('projects-preview-loading');
const previewError = document.getElementById('projects-preview-error');
const inlineComposer = document.getElementById('project-inline-composer');
const inlineComposerTitle = document.getElementById('project-inline-composer-title');
const inlineComposerContext = document.getElementById('project-inline-composer-context');
const inlineComposerError = document.getElementById('project-inline-composer-error');
const inlineComposerClose = document.getElementById('project-inline-composer-close');
const inlineModeSelect = document.getElementById('project-inline-entry-mode');
const inlineTitleWrap = document.getElementById('project-inline-entry-title-wrap');
const inlineTitleInput = document.getElementById('project-inline-entry-title-input');
const inlineText = document.getElementById('project-inline-entry-text');
const inlineTextHelp = document.getElementById('project-inline-entry-text-help');
const inlinePriority = document.getElementById('project-inline-entry-priority');
const inlineStatusWrap = document.getElementById('project-inline-entry-status-wrap');
const inlineStatus = document.getElementById('project-inline-entry-status');
const inlineStartWrap = document.getElementById('project-inline-entry-start-wrap');
const inlineStart = document.getElementById('project-inline-entry-start');
const inlineEndWrap = document.getElementById('project-inline-entry-end-wrap');
const inlineEnd = document.getElementById('project-inline-entry-end');
const inlineCancelButton = document.getElementById('project-inline-entry-cancel');
const inlineSaveButton = document.getElementById('project-inline-entry-save');
const MIN_PROJECTS_WIDTH = 320;
const MIN_PREVIEW_WIDTH = 280;
const MIN_TIMELINE_HEIGHT = 220;
const MIN_TOP_HEIGHT = 320;
const TIMELINE_MIN_DAY_WIDTH = 8;
const TIMELINE_MAX_DAY_WIDTH = 120;
const TIMELINE_DEFAULT_DAY_WIDTH = 32;
const KEYBOARD_RESIZE_STEP = 12;
const AUX_PLACEMENT_LABELS = {
    right: 'Right',
    bottom: 'Bottom',
    hidden: 'Hidden',
};
const AUX_TAB_LABELS = {
    tasks: 'Tasks/Notes',
    timeline: 'Timeline',
};
const PREVIEW_AUX_TIMELINE_CLASS = 'projects-preview-aux-timeline';
const TIMELINE_RIGHT_CLASS = 'projects-timeline-right';
const noteViewModal = document.getElementById('project-note-view-modal');
const noteViewBody = document.getElementById('project-note-view-body');
const noteViewMeta = document.getElementById('project-note-view-meta');
const taskViewModal = document.getElementById('project-task-view-modal');
const taskViewTitle = document.getElementById('project-task-view-label');
const taskViewProject = document.getElementById('project-task-view-project');
const taskViewDescription = document.getElementById('project-task-view-description');
const taskViewBadges = document.getElementById('project-task-view-badges');
const taskViewDates = document.getElementById('project-task-view-dates');
const taskViewMeta = document.getElementById('project-task-view-meta');
const taskViewParent = document.getElementById('project-task-view-parent');
const taskViewCopy = document.getElementById('project-task-view-copy');
const taskViewColor = document.getElementById('project-task-view-color');
const reminderFormController = createTaskReminderFormController({
    container: entryReminderWrap,
    enabledInput: entryReminderEnabled,
    modeSelect: entryReminderMode,
    daysWrap: entryReminderDaysWrap,
    daysInput: entryReminderDays,
    endDateInput: entryEnd,
    showAlert: (message, isError) => showEntryAlert(message, isError),
});

let projects = [];
let editingId = null;
let colorPickerInput = null;
let colorTextInput = null;
let contextMenu = null;
let contextMenuList = null;
let activeEntryProject = null;
let activeEntryId = null;
let inlineComposerProjectId = null;
let inlineComposerMode = 'note';
let inlineComposerSaving = false;
let inlineComposerReturnFocus = null;
let selectedProjects = new Set();
let currentPreviewProjectId = null;
let currentPreviewMode = 'task';
let showArchivedTasks = false;
let lastSelectedProjectId = null;
const previewEntriesCache = new Map();
let taskFilters = {
    priority: '',
    status: '',
    project: 'all',
    startFrom: '',
    endUntil: '',
    minDurationDays: '',
    maxDurationDays: '',
};
let noteFilters = {
    priority: '',
    project: 'all',
    createdFrom: '',
    createdUntil: '',
};
let filtersVisible = false;
let previousPreviewScopeIds = new Set();
let collapsedTaskNodes = new Set();
let lastTaskTreeParents = new Set();
let lastTaskFilterSignature = JSON.stringify({ filters: taskFilters, showArchivedTasks });
let userCollapsedSinceLastFilterChange = false;
const TASK_COLLAPSE_CAP = 200;
let currentTaskKeys = new Set();
let timelineController = null;
let timelineNeedsRender = false;
let timelineHeaderControls = null;
let timelineRefreshHandle = null;
let timelineFiltersTouchedByUser = false;

function loadCollapsedTasks() {
    const settings = getProjectSettings();
    const entries =
        settings.taskHierarchyCollapsed && typeof settings.taskHierarchyCollapsed === 'object'
            ? settings.taskHierarchyCollapsed
            : {};
    return new Set(Object.keys(entries || {}).filter((key) => entries[key]));
}

function persistCollapsedTasks(validKeys = null) {
    const settings = getProjectSettings();
    const allowed = validKeys ? new Set(validKeys) : null;
    const next = [];
    collapsedTaskNodes.forEach((key) => {
        if (allowed && !allowed.has(key)) return;
        next.push(key);
    });
    const bounded = next.slice(0, TASK_COLLAPSE_CAP);
    settings.taskHierarchyCollapsed = Object.fromEntries(bounded.map((key) => [key, true]));
    persistPreferences();
}

collapsedTaskNodes = loadCollapsedTasks();

function defaultTaskFilters() {
    return {
        priority: '',
        status: '',
        project: 'all',
        startFrom: '',
        endUntil: '',
        minDurationDays: '',
        maxDurationDays: '',
    };
}

function defaultNoteFilters() {
    return {
        priority: '',
        project: 'all',
        createdFrom: '',
        createdUntil: '',
    };
}

function showFiltersPanel() {
    filtersVisible = true;
    const selectedIds = getSelectedProjectIdsForPreview();
    applyPreviewHeaderForSelection(selectedIds);
    renderPreviewContentForSelection(selectedIds);
}

function clampNotePreviewLines(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 1;
    return Math.min(10, Math.max(1, Math.round(parsed)));
}

function normalizeLayoutMode(mode, fallback = 'tasks') {
    const value = typeof mode === 'string' ? mode.toLowerCase() : '';
    if (value === 'tasks' || value === 'timeline' || value === 'both' || value === 'projects') {
        return value;
    }
    return fallback;
}

function normalizeAuxPlacement(value, fallback = 'right') {
    const normalized = typeof value === 'string' ? value.toLowerCase() : '';
    if (normalized === 'right' || normalized === 'bottom' || normalized === 'hidden') {
        return normalized;
    }
    return fallback;
}

function normalizeAuxTab(value, fallback = 'tasks') {
    const normalized = typeof value === 'string' ? value.toLowerCase() : '';
    if (normalized === 'tasks' || normalized === 'timeline') {
        return normalized;
    }
    return fallback;
}

function resolveLegacyAuxSettings(layoutMode) {
    switch (layoutMode) {
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
}

function deriveLegacyLayoutMode(auxPlacement, auxTab) {
    if (auxPlacement === 'hidden') return 'projects';
    if (auxPlacement === 'bottom' && auxTab === 'timeline') return 'both';
    if (auxPlacement === 'bottom' && auxTab === 'tasks') return 'tasks';
    if (auxPlacement === 'right' && auxTab === 'tasks') return 'tasks';
    return 'tasks';
}

function normalizePaneSize(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    if (num <= 0) return null;
    return Math.round(num);
}

function clampTimelineDayWidth(value, fallback = TIMELINE_DEFAULT_DAY_WIDTH) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(TIMELINE_MAX_DAY_WIDTH, Math.max(TIMELINE_MIN_DAY_WIDTH, Math.round(num)));
}
const FALLBACK_COLOR = '#1e88e5';
const STATUS_LABELS = {
    new: 'New',
    ongoing: 'Ongoing',
    completed: 'Completed',
};
const STATUS_STYLES = {
    new: 'bg-secondary-subtle text-secondary-emphasis',
    ongoing: 'bg-info-subtle text-info-emphasis',
    completed: 'bg-success-subtle text-success-emphasis',
};

function getProjectSettings() {
    state.settings = state.settings || {};
    state.settings.projects = state.settings.projects || {};
    const prefs = state.settings.projects;
    const legacyLayoutMode = normalizeLayoutMode(
        prefs.layoutMode,
        prefs.previewPane === false ? 'projects' : 'tasks',
    );
    const legacyDefaults = resolveLegacyAuxSettings(legacyLayoutMode);
    const rawAuxPlacement = typeof prefs.auxPlacement === 'string' ? prefs.auxPlacement.toLowerCase() : '';
    const rawAuxTab = typeof prefs.auxTab === 'string' ? prefs.auxTab.toLowerCase() : '';
    const hasAuxPlacement = rawAuxPlacement === 'right' || rawAuxPlacement === 'bottom' || rawAuxPlacement === 'hidden';
    const hasAuxTab = rawAuxTab === 'tasks' || rawAuxTab === 'timeline';
    prefs.auxPlacement = normalizeAuxPlacement(rawAuxPlacement, legacyDefaults.auxPlacement);
    prefs.auxTab = normalizeAuxTab(rawAuxTab, legacyDefaults.auxTab);
    prefs.layoutMode = hasAuxPlacement || hasAuxTab
        ? deriveLegacyLayoutMode(prefs.auxPlacement, prefs.auxTab)
        : legacyLayoutMode;
    prefs.previewPane = prefs.auxPlacement !== 'hidden' && prefs.auxTab === 'tasks';
    if (prefs.previewMode !== 'task' && prefs.previewMode !== 'note') {
        prefs.previewMode = 'task';
    }
    if (typeof prefs.includeChildEntries !== 'boolean') {
        prefs.includeChildEntries = false;
    }
    const hasTaskHierarchyView = typeof prefs.taskHierarchyView === 'boolean';
    const hasTaskHierarchyCollapsed =
        prefs.taskHierarchyCollapsed && typeof prefs.taskHierarchyCollapsed === 'object';
    const legacyTimelineView = typeof prefs.timelineHierarchyView === 'boolean' ? prefs.timelineHierarchyView : null;
    const legacyTimelineCollapsed = Array.isArray(prefs.timelineHierarchyCollapsed)
        ? prefs.timelineHierarchyCollapsed.filter((key) => typeof key === 'string' && key)
        : [];
    if (!hasTaskHierarchyView && typeof legacyTimelineView === 'boolean') {
        prefs.taskHierarchyView = legacyTimelineView;
    }
    if (
        (!hasTaskHierarchyCollapsed || Object.keys(prefs.taskHierarchyCollapsed || {}).length === 0) &&
        legacyTimelineCollapsed.length
    ) {
        prefs.taskHierarchyCollapsed = Object.fromEntries(legacyTimelineCollapsed.map((key) => [key, true]));
    }
    if (typeof prefs.taskHierarchyView !== 'boolean') {
        prefs.taskHierarchyView = false;
    }
    if (!prefs.taskHierarchyCollapsed || typeof prefs.taskHierarchyCollapsed !== 'object') {
        prefs.taskHierarchyCollapsed = {};
    }
    if (typeof prefs.showArchivedTasks !== 'boolean') {
        prefs.showArchivedTasks = false;
    }
    prefs.notePreviewLines = clampNotePreviewLines(prefs.notePreviewLines);
    if (typeof prefs.compactTaskPreview !== 'boolean') {
        prefs.compactTaskPreview = true;
    }
    if (typeof prefs.inlineComposerEnabled !== 'boolean') {
        prefs.inlineComposerEnabled = false;
    }
    const allowedProjectColorStyles = new Set(['none', 'row', 'pill']);
    const colorStyle =
        typeof prefs.projectColorStyle === 'string' ? prefs.projectColorStyle.toLowerCase() : '';
    prefs.projectColorStyle = allowedProjectColorStyles.has(colorStyle) ? colorStyle : 'pill';
    if (!prefs.showExtraColumns || typeof prefs.showExtraColumns !== 'object') {
        const legacy = prefs.showExtraColumns === true;
        prefs.showExtraColumns = {
            name: true,
            status: true,
            description: legacy,
            root: legacy,
            parent: legacy,
            created: legacy,
            modified: legacy,
        };
    }
    const defaults = {
        name: true,
        status: true,
        description: false,
        root: false,
        parent: false,
        created: false,
        modified: false,
    };
    prefs.showExtraColumns = {
        ...defaults,
        ...prefs.showExtraColumns,
        name: true,
        status: prefs.showExtraColumns.status !== undefined ? !!prefs.showExtraColumns.status : true,
        parent:
            prefs.showExtraColumns.parent !== undefined
                ? !!prefs.showExtraColumns.parent
                : defaults.parent,
    };
    if (prefs.timelineSelectionMode !== 'custom' && prefs.timelineSelectionMode !== 'followMainSelection') {
        prefs.timelineSelectionMode = 'followMainSelection';
    }
    if (!Array.isArray(prefs.timelineProjectSelection)) {
        prefs.timelineProjectSelection = [];
    } else {
        prefs.timelineProjectSelection = prefs.timelineProjectSelection.filter((id) => typeof id === 'string' && id);
    }
    if (!prefs.timelineVisibleColumns || typeof prefs.timelineVisibleColumns !== 'object') {
        prefs.timelineVisibleColumns = { project: true, start: true, end: true, duration: true };
    } else {
        prefs.timelineVisibleColumns = {
            project: prefs.timelineVisibleColumns.project !== false,
            start: prefs.timelineVisibleColumns.start !== false,
            end: prefs.timelineVisibleColumns.end !== false,
            duration: prefs.timelineVisibleColumns.duration !== false,
        };
    }
    if (typeof prefs.timelineShowBarLabels !== 'boolean') {
        prefs.timelineShowBarLabels = false;
    }
    if (typeof prefs.timelineHighlightRows !== 'boolean') {
        prefs.timelineHighlightRows = false;
    }
    if (typeof prefs.timelineOpenTaskOnClick !== 'boolean') {
        prefs.timelineOpenTaskOnClick = false;
    }
    const allowedTimelineLinkStyles = new Set(['hover', 'bracket', 'none']);
    const linkStyle =
        typeof prefs.timelineHierarchyLinkStyle === 'string'
            ? prefs.timelineHierarchyLinkStyle.toLowerCase()
            : '';
    prefs.timelineHierarchyLinkStyle = allowedTimelineLinkStyles.has(linkStyle) ? linkStyle : 'hover';
    prefs.timelineHideUndatedTasks = !!prefs.timelineHideUndatedTasks;
    prefs.timelineZoomMode = prefs.timelineZoomMode === 'manual' ? 'manual' : 'fit';
    prefs.timelineDayWidthPx = clampTimelineDayWidth(
        prefs.timelineDayWidthPx,
        TIMELINE_DEFAULT_DAY_WIDTH,
    );
    if (typeof prefs.nestedView !== 'boolean') prefs.nestedView = false;
    if (!prefs.paneSizes || typeof prefs.paneSizes !== 'object') {
        prefs.paneSizes = {};
    }
    const projectWidth = normalizePaneSize(prefs.paneSizes.projectsWidthPx);
    const taskWidth = normalizePaneSize(prefs.paneSizes.tasksWidthPx);
    const timelineHeight = normalizePaneSize(prefs.paneSizes.timelineHeightPx);
    const timelineLeftWidth = normalizePaneSize(
        prefs.paneSizes.timelineLeftWidthPx ?? prefs.paneSizes.timelineLeftWidth,
    );
    prefs.paneSizes = {};
    if (projectWidth) prefs.paneSizes.projectsWidthPx = projectWidth;
    if (taskWidth) prefs.paneSizes.tasksWidthPx = taskWidth;
    if (timelineHeight) prefs.paneSizes.timelineHeightPx = timelineHeight;
    if (timelineLeftWidth) prefs.paneSizes.timelineLeftWidthPx = timelineLeftWidth;
    return prefs;
}

function getNotePreviewLineCount() {
    const prefs = getProjectSettings();
    return clampNotePreviewLines(prefs.notePreviewLines);
}

function getLayoutMode() {
    const settings = getProjectSettings();
    return normalizeLayoutMode(settings.layoutMode, 'tasks');
}

function getAuxPlacement() {
    const settings = getProjectSettings();
    return normalizeAuxPlacement(settings.auxPlacement, 'right');
}

function getAuxTab() {
    const settings = getProjectSettings();
    return normalizeAuxTab(settings.auxTab, 'tasks');
}

function isAuxVisible() {
    return getAuxPlacement() !== 'hidden';
}

function isAuxPlacementRight() {
    return isAuxVisible() && getAuxPlacement() === 'right';
}

function isAuxPlacementBottom() {
    return isAuxVisible() && getAuxPlacement() === 'bottom';
}

function shouldShowTop() {
    return getLayoutMode() !== 'timeline';
}

function isPreviewVisible() {
    return isAuxVisible() && getAuxTab() === 'tasks';
}

function isTimelineVisible() {
    return isAuxVisible() && getAuxTab() === 'timeline';
}

function buildNotePreviewText(text, maxLines) {
    const limit = clampNotePreviewLines(maxLines);
    const content = typeof text === 'string' ? text : '';
    if (!content.trim()) {
        return { preview: '(No description)', limit, truncated: false };
    }
    const normalized = content.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    const previewLines = lines.slice(0, limit);
    let preview = previewLines.join('\n');
    const truncated = lines.length > limit;
    if (truncated) {
        preview += '...';
    }
    if (!preview.trim()) {
        preview = '(No description)';
    }
    return { preview, limit, truncated };
}

function bootstrapModal(element) {
    if (!element) return null;
    // @ts-ignore - bootstrap injected globally
    return bootstrap.Modal.getOrCreateInstance(element);
}

function renderParentOptions(excludeId = null) {
    if (!parentSelect) return;
    parentSelect.innerHTML = '<option value="">None</option>';
    projects.forEach((project) => {
        if (excludeId && project.id === excludeId) return;
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = project.name || project.id;
        parentSelect.appendChild(option);
    });
}

function projectHasRootPath(project) {
    if (!project) return false;
    return Boolean(String(project.root_path || '').trim());
}

function hasProjectModalRootPath() {
    return Boolean(rootInput?.value.trim());
}

function renderTagImportSourceOptions({ excludeProjectId = null, selectedSourceId = '' } = {}) {
    if (!tagsImportSource) return;
    tagsImportSource.innerHTML = '';
    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = '(None)';
    tagsImportSource.appendChild(noneOption);
    projects.forEach((project) => {
        if (!projectHasRootPath(project)) return;
        if (excludeProjectId && project.id === excludeProjectId) return;
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = project.name || project.id;
        tagsImportSource.appendChild(option);
    });
    tagsImportSource.value = selectedSourceId || '';
}

function updateTagImportSectionVisibility() {
    if (!tagsImportSection) return;
    const rootConfigured = hasProjectModalRootPath();
    tagsImportControls?.classList.toggle('d-none', !rootConfigured);
    tagsImportEmptyNote?.classList.toggle('d-none', rootConfigured);
    if (tagsImportSource) {
        tagsImportSource.disabled = !rootConfigured;
        if (!rootConfigured) {
            tagsImportSource.value = '';
        }
    }
    if (tagsImportMode) {
        tagsImportMode.disabled = !rootConfigured;
        if (!rootConfigured) {
            tagsImportMode.value = 'append';
        }
    }
}

function resetTagImportControls({ excludeProjectId = null } = {}) {
    if (tagsImportMode) {
        tagsImportMode.value = 'append';
    }
    renderTagImportSourceOptions({ excludeProjectId, selectedSourceId: '' });
    updateTagImportSectionVisibility();
}

function getTagImportSelection() {
    if (!hasProjectModalRootPath()) return null;
    const sourceProjectId = (tagsImportSource?.value || '').trim();
    if (!sourceProjectId) return null;
    const mode = (tagsImportMode?.value || 'append').toLowerCase() === 'replace' ? 'replace' : 'append';
    return { sourceProjectId, mode };
}

function parentName(id) {
    if (!id) return '';
    const match = projects.find((p) => p.id === id);
    return match ? match.name : '';
}

function normalizeStatus(value) {
    const text = (value ?? '').toString().trim().toLowerCase();
    if (text === 'ongoing' || text === 'completed' || text === 'new') {
        return text;
    }
    return 'new';
}

function renderStatusBadge(status) {
    const normalized = normalizeStatus(status);
    const badge = document.createElement('span');
    badge.className = `badge rounded-pill ${STATUS_STYLES[normalized] || STATUS_STYLES.new}`;
    badge.textContent = STATUS_LABELS[normalized] || STATUS_LABELS.new;
    return badge;
}

function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function toISODate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
}

function taskNodeKey(projectId, taskId) {
    return `${projectId || ''}::${taskId || ''}`;
}

function compareTasksByDate(a, b) {
    const aStart = parseDateSafe(a.task.start_date);
    const bStart = parseDateSafe(b.task.start_date);
    const aCreated = parseDateSafe(a.task.created_at);
    const bCreated = parseDateSafe(b.task.created_at);
    const aVal = aStart ? aStart.getTime() : aCreated ? aCreated.getTime() : 0;
    const bVal = bStart ? bStart.getTime() : bCreated ? bCreated.getTime() : 0;
    return aVal - bVal;
}

function buildProjectOrderNested() {
    const byId = new Map();
    const children = new Map();
    projects.forEach((project) => {
        byId.set(project.id, project);
        const parentKey = project.parent_id || null;
        if (!children.has(parentKey)) {
            children.set(parentKey, []);
        }
        children.get(parentKey).push(project);
    });
    const compareByName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    children.forEach((list) => list.sort(compareByName));
    const ordered = [];
    const traverse = (list, depth) => {
        list.forEach((project) => {
            ordered.push({ project, depth });
            const childList = children.get(project.id) || [];
            if (childList.length) {
                traverse(childList, depth + 1);
            }
        });
    };
    const roots = projects
        .filter((project) => {
            if (!project.parent_id) return true;
            return !byId.has(project.parent_id);
        })
        .sort(compareByName);
    roots.sort(compareByName);
    traverse(roots, 0);
    return ordered;
}

function resolveColumnPreferences(settings, isDualMode) {
    const prefs = getProjectSettings();
    if (!isDualMode) {
        return { name: true, status: true, description: true, root: true, parent: true, created: true, modified: true };
    }
    const base = {
        name: true,
        status: true,
        description: false,
        root: false,
        parent: false,
        created: false,
        modified: false,
    };
    const merged = {
        ...base,
        ...(prefs.showExtraColumns || {}),
    };
    merged.name = true;
    if (prefs.showExtraColumns && prefs.showExtraColumns.status !== undefined) {
        merged.status = !!prefs.showExtraColumns.status;
    }
    return merged;
}

function renderProjects() {
    const settings = getProjectSettings();
    const colorStyle = settings.projectColorStyle;
    const isDualMode = isAuxPlacementRight();
    const previewVisible = isPreviewVisible();
    const columnPrefs = resolveColumnPreferences(settings, isDualMode);
    const nested = Boolean(settings.nestedView);
    if (isDualMode) {
        settings.showExtraColumns = columnPrefs;
    }
    if (!tableBody) return;
    tableBody.innerHTML = '';
    if (!projects.length) {
        if (emptyRow) {
            emptyRow.classList.remove('d-none');
            tableBody.appendChild(emptyRow);
        }
        applyProjectsLayout(null, columnPrefs, nested);
        updateSelectAllCheckbox();
        return;
    }
    if (emptyRow) {
        emptyRow.classList.add('d-none');
    }
    const rows = nested ? buildProjectOrderNested() : projects.map((project) => ({ project, depth: 0 }));
    rows.forEach(({ project, depth }) => {
        const tr = document.createElement('tr');
        tr.dataset.projectId = project.id;
        const normalizedColor = normalizeHexColor(project.color);
        if (normalizedColor) {
            tr.dataset.projectColor = normalizedColor;
            tr.style.setProperty('--project-color', normalizedColor);
            if (colorStyle === 'row') {
                tr.classList.add('project-row-colored');
            }
        }

        const selectCell = document.createElement('td');
        selectCell.classList.add('text-center');
        const selectInput = document.createElement('input');
        selectInput.type = 'checkbox';
        selectInput.className = 'form-check-input project-select';
        selectInput.checked = selectedProjects.has(project.id);
        selectCell.appendChild(selectInput);

        const nameCell = document.createElement('td');
        const wrapper = document.createElement('div');
        wrapper.className = 'project-name-wrapper';
        if (depth) {
            wrapper.style.setProperty('--project-depth', depth);
            wrapper.dataset.depth = String(depth);
        }
        const nameBlock = document.createElement('div');
        nameBlock.className = 'project-name-block';
        const nameLabel = document.createElement('div');
        nameLabel.className = 'project-name';
        if (colorStyle === 'pill') {
            const pill = document.createElement('span');
            pill.className = 'project-name-pill';
            pill.textContent = project.name;
            if (normalizedColor) {
                pill.style.setProperty('--project-color', normalizedColor);
                pill.style.setProperty('--project-pill-text', pickReadableTextColor(normalizedColor));
            }
            nameLabel.appendChild(pill);
        } else {
            nameLabel.textContent = project.name;
        }
        nameBlock.appendChild(nameLabel);
        if (project.root_path && isDualMode && !columnPrefs.root) {
            const rootInline = document.createElement('div');
            rootInline.className = 'project-root-inline';
            rootInline.textContent = project.root_path;
            nameBlock.appendChild(rootInline);
        }
        wrapper.appendChild(nameBlock);
        nameCell.appendChild(wrapper);

        const descCell = document.createElement('td');
        descCell.dataset.column = 'description';
        descCell.dataset.optional = 'true';
        descCell.classList.add('d-none', 'd-md-table-cell');
        descCell.textContent = project.description || '';

        const statusCell = document.createElement('td');
        statusCell.dataset.column = 'status';
        statusCell.dataset.optional = 'true';
        statusCell.classList.add('project-status');
        statusCell.appendChild(renderStatusBadge(project.status));

        const rootCell = document.createElement('td');
        rootCell.dataset.column = 'root';
        rootCell.dataset.optional = 'true';
        rootCell.classList.add('project-root');
        if (project.root_path) {
            const rootLabel = document.createElement('span');
            rootLabel.className = 'project-root-label';
            rootLabel.textContent = project.root_path;
            rootCell.appendChild(rootLabel);
        } else {
            rootCell.classList.add('text-muted');
            rootCell.textContent = 'Not set';
        }

        const parentCell = document.createElement('td');
        parentCell.dataset.column = 'parent';
        parentCell.dataset.optional = 'true';
        parentCell.classList.add('d-none', 'd-lg-table-cell');
        parentCell.textContent = parentName(project.parent_id) || 'None';

        const createdCell = document.createElement('td');
        createdCell.dataset.column = 'created';
        createdCell.dataset.optional = 'true';
        createdCell.classList.add('d-none', 'd-lg-table-cell');
        createdCell.textContent = formatDate(project.created_at);

        const modifiedCell = document.createElement('td');
        modifiedCell.dataset.column = 'modified';
        modifiedCell.dataset.optional = 'true';
        modifiedCell.classList.add('d-none', 'd-lg-table-cell');
        modifiedCell.textContent = formatDate(project.updated_at);

        const actionsCell = document.createElement('td');
        actionsCell.classList.add('text-end');
        const hasRoot = Boolean(project.root_path);
        const openDisabled = hasRoot ? '' : 'disabled';
        const openButtonClass = hasRoot
            ? 'btn btn-primary btn-sm project-action-open project-action-open-ready rounded-pill'
            : 'btn btn-outline-secondary btn-sm project-action-open project-action-open-missing-root rounded-pill';
        actionsCell.innerHTML = `
            <div class="project-actions btn-group" role="group">
                <button class="${openButtonClass}" data-action="open" ${openDisabled}>Open</button>
                <div class="btn-group project-action-menu position-static" role="group">
                    <button class="btn btn-outline-secondary btn-sm rounded-pill project-action-menu-toggle dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false" aria-label="More actions">...</button>
                    <ul class="dropdown-menu dropdown-menu-end">
                        <li><button class="dropdown-item" type="button" data-action="edit">Edit</button></li>
                        <li><button class="dropdown-item text-danger" type="button" data-action="delete">Delete</button></li>
                    </ul>
                </div>
            </div>
        `;
        const openButton = actionsCell.querySelector('.project-action-open');
        if (openButton) {
            openButton.title = hasRoot
                ? `Open ${project.root_path}`
                : 'Set a root folder to enable opening.';
            if (!hasRoot) {
                openButton.setAttribute('aria-disabled', 'true');
            }
        }
        const isSelected = selectedProjects.has(project.id);
        if (isSelected) {
            tr.classList.add('table-active');
        }

        tr.append(selectCell, nameCell, statusCell, descCell, rootCell, parentCell, createdCell, modifiedCell, actionsCell);
        tableBody.appendChild(tr);
    });
    applyProjectsLayout(null, columnPrefs, nested);
    updateSelectAllCheckbox();
}

function toggleColumnVisibility(isDualMode, columnPrefs, nestedView) {
    const optionalHeaders = document.querySelectorAll('#projects-table th[data-optional="true"]');
    const optionalCells = document.querySelectorAll('#projects-table td[data-column]');
    const shouldHide = (column) => {
        if (!isDualMode) return false;
        if (column === 'name') return false;
        const pref = columnPrefs[column];
        if (pref === undefined) return false;
        return !pref;
    };
    optionalHeaders.forEach((header) => {
        const col = header.dataset.column;
        const hide = shouldHide(col);
        if (hide) {
            header.style.setProperty('display', 'none', 'important');
        } else {
            header.style.removeProperty('display');
        }
    });
    optionalCells.forEach((cell) => {
        const col = cell.dataset.column;
        const hide = shouldHide(col);
        if (hide) {
            cell.style.setProperty('display', 'none', 'important');
        } else {
            cell.style.removeProperty('display');
        }
    });
}

function projectById(projectId) {
    return projects.find((p) => p.id === projectId) || null;
}

function getTimelineSelectionMode() {
    const prefs = getProjectSettings();
    return prefs.timelineSelectionMode === 'custom' ? 'custom' : 'followMainSelection';
}

function getTimelineCustomSelection() {
    const prefs = getProjectSettings();
    const validIds = new Set(projects.map((p) => p.id));
    return (prefs.timelineProjectSelection || []).filter((id) => validIds.has(id));
}

function getTimelineSelectedProjectIds() {
    return getTimelineSelectionMode() === 'custom' ? getTimelineCustomSelection() : getSelectedProjectIdsForPreview();
}

function getTimelineUiPrefs() {
    const prefs = getProjectSettings();
    return {
        visibleColumns: { ...(prefs.timelineVisibleColumns || {}) },
        showBarLabels: !!prefs.timelineShowBarLabels,
        highlightRows: !!prefs.timelineHighlightRows,
    };
}

function getTimelineFilterPrefs() {
    const prefs = getProjectSettings();
    return {
        hideUndated: !!prefs.timelineHideUndatedTasks,
    };
}

function getTimelineHierarchyPrefs() {
    const prefs = getProjectSettings();
    const collapsed =
        prefs.taskHierarchyCollapsed && typeof prefs.taskHierarchyCollapsed === 'object'
            ? Object.keys(prefs.taskHierarchyCollapsed || {}).filter((key) => prefs.taskHierarchyCollapsed[key])
            : [];
    return {
        enabled: !!prefs.taskHierarchyView,
        collapsed: new Set(collapsed.filter((key) => typeof key === 'string' && key)),
    };
}

function getTimelineZoomPrefs() {
    const prefs = getProjectSettings();
    return {
        zoomMode: prefs.timelineZoomMode === 'manual' ? 'manual' : 'fit',
        dayWidthPx: clampTimelineDayWidth(prefs.timelineDayWidthPx, TIMELINE_DEFAULT_DAY_WIDTH),
    };
}

function scheduleTimelineRefresh() {
    if (timelineRefreshHandle) return;
    timelineRefreshHandle = requestAnimationFrame(() => {
        timelineRefreshHandle = null;
        refreshTimeline();
    });
}

function setTimelineUiPrefs(next = {}) {
    const prefs = getProjectSettings();
    if (next.visibleColumns) {
        prefs.timelineVisibleColumns = {
            ...prefs.timelineVisibleColumns,
            ...next.visibleColumns,
        };
    }
    if (typeof next.showBarLabels === 'boolean') {
        prefs.timelineShowBarLabels = next.showBarLabels;
    }
    if (typeof next.highlightRows === 'boolean') {
        prefs.timelineHighlightRows = next.highlightRows;
    }
    persistPreferences();
    refreshTimeline();
}

function setTimelineZoomPrefs(next = {}, options = {}) {
    const prefs = getProjectSettings();
    if (next.zoomMode) {
        prefs.timelineZoomMode = next.zoomMode === 'manual' ? 'manual' : 'fit';
    }
    if (typeof next.dayWidthPx === 'number') {
        prefs.timelineDayWidthPx = clampTimelineDayWidth(
            next.dayWidthPx,
            prefs.timelineDayWidthPx || TIMELINE_DEFAULT_DAY_WIDTH,
        );
    }
    persistPreferences();
    if (options.deferRefresh) {
        scheduleTimelineRefresh();
    } else {
        refreshTimeline();
    }
}

function setTimelineHideUndated(value) {
    const prefs = getProjectSettings();
    prefs.timelineHideUndatedTasks = !!value;
    persistPreferences();
    refreshTimeline();
}

function setTimelineHierarchyPrefs(next = {}, options = {}) {
    const prefs = getProjectSettings();
    const hasCollapsed = !!next.collapsed;
    if (hasCollapsed) {
        const nextList = Array.isArray(next.collapsed) ? next.collapsed : Array.from(next.collapsed || []);
        const filtered = nextList.filter((key) => typeof key === 'string' && key);
        collapsedTaskNodes = new Set(filtered);
        userCollapsedSinceLastFilterChange = true;
        persistCollapsedTasks(options.validKeys ?? null);
    }
    if (typeof next.enabled === 'boolean') {
        prefs.taskHierarchyView = next.enabled;
        if (!next.enabled && !hasCollapsed) {
            collapsedTaskNodes.clear();
            persistCollapsedTasks(currentTaskKeys);
        } else if (!hasCollapsed) {
            persistPreferences();
        }
    }
    if (options.deferRefresh) {
        scheduleTimelineRefresh();
    } else {
        refreshTimeline();
    }
    if (isPreviewVisible()) {
        const selectedIds = getSelectedProjectIdsForPreview();
        renderPreviewContentForSelection(selectedIds, getEffectivePreviewProjectIds(selectedIds));
    }
    syncTimelineHierarchyControls();
}

function toggleTimelineHierarchyCollapsed(taskKey) {
    if (!taskKey) return;
    const prefs = getProjectSettings();
    if (collapsedTaskNodes.has(taskKey)) {
        collapsedTaskNodes.delete(taskKey);
    } else {
        collapsedTaskNodes.add(taskKey);
    }
    prefs.taskHierarchyView = true;
    userCollapsedSinceLastFilterChange = true;
    // Persist collapsed keys so hierarchy state survives refreshes.
    persistCollapsedTasks();
    refreshTimeline();
    if (isPreviewVisible()) {
        const selectedIds = getSelectedProjectIdsForPreview();
        renderPreviewContentForSelection(selectedIds, getEffectivePreviewProjectIds(selectedIds));
    }
    syncTimelineHierarchyControls();
}

function updateTimelineFiltersActiveState() {
    const prefs = getTimelineFilterPrefs();
    const hasStatus = !!(taskFilters.status || '');
    const hasPriority = !!(taskFilters.priority || '');
    const hasTimelineActiveFilters = hasStatus || hasPriority || prefs.hideUndated || showArchivedTasks;
    // Highlight only when the user interacted with timeline filters.
    const active = timelineFiltersTouchedByUser && hasTimelineActiveFilters;
    if (timelineFiltersToggle) {
        timelineFiltersToggle.classList.toggle('active', active);
        timelineFiltersToggle.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
}

function syncTimelineFilterControls() {
    const prefs = getTimelineFilterPrefs();
    if (timelineFilterStatus) timelineFilterStatus.value = taskFilters.status ?? '';
    if (timelineFilterPriority) timelineFilterPriority.value = taskFilters.priority ?? '';
    if (timelineFilterShowArchived) timelineFilterShowArchived.checked = !!showArchivedTasks;
    if (timelineFilterHideUndated) timelineFilterHideUndated.checked = !!prefs.hideUndated;
    updateTimelineFiltersActiveState();
}

function syncTimelineHierarchyControls() {
    if (!timelineHierarchyEnabled) return;
    const prefs = getTimelineHierarchyPrefs();
    timelineHierarchyEnabled.checked = prefs.enabled;
}

function setTimelineSelection(ids) {
    const prefs = getProjectSettings();
    const validIds = new Set(projects.map((p) => p.id));
    prefs.timelineSelectionMode = 'custom';
    prefs.timelineProjectSelection = Array.from(new Set((ids || []).filter((id) => validIds.has(id))));
    persistPreferences();
    renderTimelineProjectOptions();
    refreshTimeline();
}

function setTimelineFollowMain(enabled) {
    const prefs = getProjectSettings();
    prefs.timelineSelectionMode = enabled ? 'followMainSelection' : 'custom';
    if (!enabled && (!prefs.timelineProjectSelection || !prefs.timelineProjectSelection.length)) {
        prefs.timelineProjectSelection = getSelectedProjectIdsForPreview();
    }
    persistPreferences();
    renderTimelineProjectOptions();
    refreshTimeline();
}

function syncTimelineToggleLabel() {
    if (!timelineProjectsToggle) return;
    const mode = getTimelineSelectionMode();
    const selection = getTimelineSelectedProjectIds();
    const label =
        mode === 'followMainSelection'
            ? `Projects: ${selection.length ? `${selection.length} selected` : 'Follow selection'}`
            : selection.length === 1
                ? `Projects: ${projectById(selection[0])?.name || selection[0]}`
                : `Projects: ${selection.length || 0} selected`;
    timelineProjectsToggle.textContent = label;
}

function renderTimelineProjectOptions() {
    if (!timelineProjectsOptions) return;
    const mode = getTimelineSelectionMode();
    const prefs = getProjectSettings();
    const validCustom = getTimelineCustomSelection();
    const customSelection = new Set(validCustom);
    const mainSelection = new Set(getSelectedProjectIdsForPreview());
    if (mode === 'custom' && Array.isArray(prefs.timelineProjectSelection) && prefs.timelineProjectSelection.length !== validCustom.length) {
        prefs.timelineProjectSelection = [...customSelection];
        persistPreferences();
    }
    timelineProjectsOptions.innerHTML = '';
    if (!projects.length) {
        const empty = document.createElement('div');
        empty.className = 'text-muted small';
        empty.textContent = 'No projects yet.';
        timelineProjectsOptions.appendChild(empty);
    } else {
        projects.forEach((project) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'form-check';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.className = 'form-check-input';
            input.id = `timeline-project-${project.id}`;
            input.value = project.id;
            const isChecked = mode === 'custom' ? customSelection.has(project.id) : mainSelection.has(project.id);
            input.checked = isChecked;
            input.disabled = mode !== 'custom';
            input.addEventListener('change', (event) => handleTimelineOptionToggle(project.id, event.target.checked));
            const label = document.createElement('label');
            label.className = 'form-check-label';
            label.setAttribute('for', input.id);
            label.textContent = project.name || project.id;
            wrapper.append(input, label);
            timelineProjectsOptions.appendChild(wrapper);
        });
    }
    if (timelineProjectsFollow) {
        timelineProjectsFollow.checked = mode !== 'custom';
    }
    if (timelineProjectsClear) {
        const disableClear = mode !== 'custom' || customSelection.size === 0;
        timelineProjectsClear.disabled = disableClear;
        timelineProjectsClear.classList.toggle('disabled', disableClear);
    }
    syncTimelineToggleLabel();
}

function setupTimelineHeaderControls() {
    if (!timelineColumnsToggle) return;
    const initial = getTimelineUiPrefs();
    timelineHeaderControls = initTimelineHeaderControls({
        columnCheckboxes: {
            project: timelineColumnProject,
            start: timelineColumnStart,
            end: timelineColumnEnd,
            duration: timelineColumnDuration,
        },
        initialPrefs: initial,
        onChange: (next) => setTimelineUiPrefs(next),
    });
}

function syncTimelineZoomControls() {
    const { zoomMode, dayWidthPx } = getTimelineZoomPrefs();
    if (timelineZoomSlider) {
        timelineZoomSlider.value = dayWidthPx;
    }
    if (timelineZoomValue) {
        timelineZoomValue.textContent = zoomMode === 'fit' ? 'Auto' : `${dayWidthPx}px`;
    }
    if (timelineZoomFit) {
        const isFit = zoomMode === 'fit';
        timelineZoomFit.classList.toggle('active', isFit);
        timelineZoomFit.setAttribute('aria-pressed', isFit ? 'true' : 'false');
    }
}

function setupTimelineZoomControls() {
    if (!timelineZoomSlider || !timelineZoomOut || !timelineZoomIn || !timelineZoomFit) return;
    const adjust = (delta) => {
        const { dayWidthPx } = getTimelineZoomPrefs();
        const nextWidth = clampTimelineDayWidth(dayWidthPx + delta, dayWidthPx);
        setTimelineZoomPrefs({ zoomMode: 'manual', dayWidthPx: nextWidth });
        syncTimelineZoomControls();
    };
    timelineZoomOut.addEventListener('click', () => adjust(-4));
    timelineZoomIn.addEventListener('click', () => adjust(4));
    timelineZoomSlider.addEventListener('input', (event) => {
        const value = clampTimelineDayWidth(event.target.value, TIMELINE_DEFAULT_DAY_WIDTH);
        setTimelineZoomPrefs({ zoomMode: 'manual', dayWidthPx: value }, { deferRefresh: true });
        syncTimelineZoomControls();
    });
    timelineZoomFit.addEventListener('click', () => {
        setTimelineZoomPrefs({ zoomMode: 'fit' });
        syncTimelineZoomControls();
    });
    syncTimelineZoomControls();
}

function setupTimelineFilterControls() {
    const rerenderPreview = () => {
        const ids = getSelectedProjectIdsForPreview();
        if (ids.length) {
            renderPreviewContentForSelection(ids);
        }
    };
    timelineFilterStatus?.addEventListener('change', () => {
        timelineFiltersTouchedByUser = true;
        taskFilters.status = timelineFilterStatus.value || '';
        if ((taskFilters.status || '').toLowerCase() === 'closed' && !showArchivedTasks) {
            setShowArchived(true);
        }
        syncTaskFilterControls();
        markTaskFiltersChanged();
        rerenderPreview();
    });
    timelineFilterPriority?.addEventListener('change', () => {
        timelineFiltersTouchedByUser = true;
        taskFilters.priority = timelineFilterPriority.value || '';
        syncTaskFilterControls();
        markTaskFiltersChanged();
        rerenderPreview();
    });
    timelineFilterShowArchived?.addEventListener('change', (event) => {
        timelineFiltersTouchedByUser = true;
        setShowArchived(!!event.target.checked);
        syncTaskFilterControls();
    });
    timelineFilterHideUndated?.addEventListener('change', (event) => {
        timelineFiltersTouchedByUser = true;
        setTimelineHideUndated(!!event.target.checked);
        syncTimelineFilterControls();
    });
    timelineFilterReset?.addEventListener('click', (event) => {
        event.preventDefault();
        timelineFiltersTouchedByUser = false;
        resetTaskFilters();
        setTimelineHideUndated(false);
        setShowArchived(false);
        syncTaskFilterControls();
        rerenderPreview();
    });
    syncTimelineFilterControls();
}

function setupTimelineHierarchyControls() {
    syncTimelineHierarchyControls();
}

function handleTimelineOptionToggle(projectId, checked) {
    if (getTimelineSelectionMode() !== 'custom') {
        setTimelineFollowMain(false);
    }
    const selection = new Set(getTimelineCustomSelection());
    if (checked) selection.add(projectId);
    else selection.delete(projectId);
    setTimelineSelection([...selection]);
}

function clearTimelineSelection() {
    setTimelineSelection([]);
}

function refreshTimeline(forceReload = false) {
    if (!timelineController || !timelineRoot) return;
    if (timelineRefreshHandle) {
        cancelAnimationFrame(timelineRefreshHandle);
        timelineRefreshHandle = null;
    }
    const zoomPrefs = getTimelineZoomPrefs();
    timelineRoot.dataset.timelineZoomMode = zoomPrefs.zoomMode;
    syncTimelineZoomControls();
    syncTimelineFilterControls();
    syncTimelineHierarchyControls();
    if (timelineHeaderControls) {
        timelineHeaderControls.update(getTimelineUiPrefs());
    }
    const selection = getTimelineSelectedProjectIds();
    syncTimelineToggleLabel();
    if (timelineRangeLabel) {
        timelineRangeLabel.textContent = selection.length ? `${selection.length} project${selection.length === 1 ? '' : 's'}` : '';
    }
    timelineController.setProjects(projects, false);
    timelineController.setSelection(selection, false);
    timelineNeedsRender = !isTimelineVisible();
    if (timelineNeedsRender) return;
    const refreshPromise = timelineController.refresh({ forceReload });
    if (refreshPromise?.finally) {
        refreshPromise.finally(() => syncTimelineHierarchyControls());
    }
}

function ensureTimelineVisibleRender() {
    if (!timelineNeedsRender) return;
    if (!isTimelineVisible()) return;
    timelineNeedsRender = false;
    refreshTimeline();
}

function openTimelineTask(projectId, taskId) {
    if (!projectId || !taskId) return;
    void (async () => {
        try {
            await ensurePreviewEntriesForProjects([projectId]);
        } catch (error) {
            console.warn('Unable to refresh task before opening', error);
        }
        const task = previewEntriesCache.get(projectId)?.tasks?.find((t) => t.id === taskId);
        if (task) {
            void showTaskView(task, projectId);
        }
    })();
}

function setPreviewMode(mode) {
    const next = mode === 'note' ? 'note' : 'task';
    currentPreviewMode = next;
    const settings = getProjectSettings();
    settings.previewMode = next;
    persistPreferences();
    const selectedIds = getSelectedProjectIdsForPreview();
    const effectiveIds = getEffectivePreviewProjectIds(selectedIds);
    ensureValidProjectFilterForMode(effectiveIds);
    renderPreviewContentForSelection(selectedIds, effectiveIds);
}

function setShowArchived(value) {
    showArchivedTasks = !!value;
    const settings = getProjectSettings();
    settings.showArchivedTasks = showArchivedTasks;
    persistPreferences();
    markTaskFiltersChanged();
    if (!showArchivedTasks && (taskFilters.status || '').toLowerCase() === 'closed') {
        taskFilters.status = '';
        if (filterTaskStatus) filterTaskStatus.value = '';
    }
    if (previewArchivedToggle) {
        previewArchivedToggle.checked = showArchivedTasks;
    }
    syncTimelineFilterControls();
    const selectedIds = getSelectedProjectIdsForPreview();
    renderPreviewContentForSelection(selectedIds, getEffectivePreviewProjectIds(selectedIds));
}

function setTaskHierarchyEnabled(enabled) {
    const settings = getProjectSettings();
    const next = !!enabled;
    settings.taskHierarchyView = next;
    if (!next) {
        collapsedTaskNodes.clear();
        persistCollapsedTasks(currentTaskKeys);
    }
    userCollapsedSinceLastFilterChange = false;
    persistPreferences();
    refreshTimeline();
    const selectedIds = getSelectedProjectIdsForPreview();
    renderPreviewContentForSelection(selectedIds, getEffectivePreviewProjectIds(selectedIds));
    syncTimelineHierarchyControls();
}

function applyHierarchyCollapsed(nextKeys, options = {}) {
    const nextList = Array.isArray(nextKeys) ? nextKeys : Array.from(nextKeys || []);
    const filtered = nextList.filter((key) => typeof key === 'string' && key);
    collapsedTaskNodes = new Set(filtered);
    userCollapsedSinceLastFilterChange = options.markUser !== false;
    persistCollapsedTasks(options.validKeys ?? null);
    if (options.deferTimeline) {
        scheduleTimelineRefresh();
    } else {
        refreshTimeline();
    }
    if (options.refreshPreview) {
        const selectedIds = getSelectedProjectIdsForPreview();
        renderPreviewContentForSelection(selectedIds, getEffectivePreviewProjectIds(selectedIds));
    }
    syncTimelineHierarchyControls();
}

function expandAllTaskTree() {
    applyHierarchyCollapsed([], { validKeys: currentTaskKeys, refreshPreview: true });
}

function collapseAllTaskTree() {
    const nextKeys = [...lastTaskTreeParents].filter((key) => !currentTaskKeys.size || currentTaskKeys.has(key));
    applyHierarchyCollapsed(nextKeys, { validKeys: currentTaskKeys, refreshPreview: true });
}

function resetPreviewViews() {
    previewLoading?.classList.add('d-none');
    previewError?.classList.add('d-none');
    if (previewError) previewError.textContent = '';
    previewPlaceholder?.classList.add('d-none');
    previewList?.classList.add('d-none');
    if (previewList) previewList.innerHTML = '';
}

function renderPreviewPlaceholder(title, detail) {
    resetPreviewViews();
    if (previewPlaceholder) {
        previewPlaceholder.classList.remove('d-none');
        previewPlaceholder.innerHTML = `
            <div class="text-center">
                <div class="mb-1 fw-semibold">${title || 'Select a project'}</div>
                <p class="mb-0 small">${detail || 'Choose a project to see its tasks and notes.'}</p>
            </div>
        `;
    }
}

function renderPreviewError(message) {
    resetPreviewViews();
    if (previewError) {
        previewError.classList.add('d-none');
        previewError.textContent = '';
    }
    showToast(message || 'Unable to load entries.', true);
}

function renderPreviewLoading() {
    resetPreviewViews();
    previewLoading?.classList.remove('d-none');
}

function applyPreviewHeaderForSelection(selectedIds, effectiveIdsArg = null) {
    const selectedCount = selectedIds.length;
    const effectiveIds = effectiveIdsArg && effectiveIdsArg.length ? effectiveIdsArg : getEffectivePreviewProjectIds(selectedIds);
    const effectiveSet = new Set(effectiveIds);
    const extraCount = Math.max(0, effectiveSet.size - selectedCount);
    const activeProject = projectById(getActivePreviewProjectId());
    const modeLabel = currentPreviewMode === 'note' ? 'Notes' : 'Tasks';
    if (previewModeBadge) {
        previewModeBadge.textContent = modeLabel;
        previewModeBadge.classList.toggle('d-none', selectedCount === 0);
    }
    if (previewSubtitle) {
        let subtitleText = '';
        if (!selectedCount) {
            subtitleText = 'No project selected';
        } else if (selectedCount === 1 && activeProject) {
            subtitleText = activeProject.name || activeProject.id;
        } else {
            subtitleText = `${selectedCount} projects selected`;
        }
        if (getProjectSettings().includeChildEntries && extraCount > 0) {
            subtitleText = `${subtitleText} · Including ${extraCount} child project${extraCount === 1 ? '' : 's'}`;
        }
        previewSubtitle.textContent = subtitleText;
    }
    if (previewTabTasks) {
        previewTabTasks.classList.toggle('active', currentPreviewMode === 'task');
        previewTabTasks.setAttribute('aria-pressed', currentPreviewMode === 'task' ? 'true' : 'false');
    }
    if (previewTabNotes) {
        previewTabNotes.classList.toggle('active', currentPreviewMode === 'note');
        previewTabNotes.setAttribute('aria-pressed', currentPreviewMode === 'note' ? 'true' : 'false');
    }
    previewArchivedWrapper?.classList.remove('d-none');
    if (previewArchivedToggle) {
        previewArchivedToggle.checked = showArchivedTasks;
    }
    if (previewNewButton) {
        previewNewButton.disabled = selectedCount === 0 || !activeProject;
    }
    if (previewFiltersContainer) {
        const shouldShow = filtersVisible && selectedCount > 0;
        previewFiltersContainer.classList.toggle('d-none', !shouldShow);
    }
    if (previewFiltersToggleButton) {
        const active = filtersVisible && selectedCount > 0;
        previewFiltersToggleButton.classList.toggle('active', active);
        previewFiltersToggleButton.setAttribute('aria-pressed', active ? 'true' : 'false');
        previewFiltersToggleButton.disabled = selectedCount === 0;
    }
    syncProjectFilterOptions(selectedIds, effectiveIds);
    toggleFilterVisibility();
    updateHierarchyControls(selectedCount);
}

function chip(className, text) {
    const span = document.createElement('span');
    span.className = `projects-chip ${className}`;
    span.textContent = text;
    return span;
}

function statusChip(status) {
    const normalized = (status || 'none').toLowerCase();
    return chip(`status-${normalized}`, normalized === 'in_progress' ? 'In progress' : normalized === 'closed' ? 'Closed' : 'None');
}

function priorityChip(priority) {
    if (!priority) return null;
    const normalized = priority.toLowerCase();
    const map = { high: 'High', medium: 'Medium', low: 'Low' };
    return chip(`priority-${normalized}`, map[normalized] || normalized);
}

function dateRangeMeta(start, end) {
    if (!start && !end) return '';
    const startText = start ? formatDate(start) : '—';
    const endText = end ? formatDate(end) : '—';
    return `${startText} → ${endText}`;
}


function parseParentHintLabel(hint) {
    const raw = (hint || '').trim();
    if (!raw) return { project: '', task: '' };
    const emDashIndex = raw.indexOf('—');
    const enDashIndex = raw.indexOf('–');
    let splitIndex = emDashIndex >= 0 ? emDashIndex : enDashIndex;
    if (splitIndex < 0) {
        splitIndex = raw.indexOf(' - ');
    }
    const trimmed = (splitIndex >= 0 ? raw.slice(0, splitIndex) : raw).trim();
    if (!trimmed) return { project: '', task: '' };
    if (!trimmed.includes(':')) return { project: '', task: trimmed };
    const [project, ...rest] = trimmed.split(':');
    return { project: project.trim(), task: rest.join(':').trim() };
}

function buildPreviewActions(projectId, entry, type) {
    const container = document.createElement('div');
    container.className = 'projects-preview-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-outline-secondary btn-sm';
    editBtn.innerHTML = '✏️';
    editBtn.setAttribute('aria-label', 'Edit');
    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEntryModalForEntry(projectId, entry, type);
    });
    container.appendChild(editBtn);

    if (type === 'task' && entry.status !== 'closed') {
        const validateBtn = document.createElement('button');
        validateBtn.type = 'button';
        validateBtn.className = 'btn btn-outline-success btn-sm';
        validateBtn.innerHTML = '✔';
        validateBtn.setAttribute('aria-label', 'Mark as done');
        validateBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                await updateProjectEntry(projectId, entry.id, { status: 'closed', type: 'task' });
                await refreshPreviewForCurrentSelection([projectId], true);
            } catch (error) {
                renderPreviewError(error?.message || 'Unable to update task.');
            }
        });
        container.appendChild(validateBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-outline-danger btn-sm';
    deleteBtn.innerHTML = '🗑';
    deleteBtn.setAttribute('aria-label', 'Delete');
    deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteProjectEntryWithRefresh(projectId, entry.id, type, 'Delete this entry?');
    });
    container.appendChild(deleteBtn);
    return container;
}

function buildTaskCard(projectId, task, options = {}) {
    const {
        depth = 0,
        parentHint = '',
        isTree = false,
        effectiveRanges = null,
        compactTaskPreview = getProjectSettings().compactTaskPreview,
    } = options;
    const card = document.createElement('div');
    card.className = 'projects-preview-card';
    if (isTree) {
        card.classList.add('projects-preview-card-tree');
        card.style.setProperty('--task-depth', depth);
    }
    if (compactTaskPreview) {
        card.classList.add('projects-preview-card-compact');
    }
    card.dataset.projectId = projectId;
    card.dataset.entryId = task.id || '';
    card.dataset.entryType = 'task';
    const color = normalizeHexColor(task.color);
    if (color) {
        card.classList.add('accented');
        card.style.borderLeftColor = color;
        card.style.background = 'color-mix(in srgb, var(--bs-body-bg) 92%, ' + color + ')';
    }

    const header = document.createElement('div');
    header.className = 'projects-preview-card-header';
    const headerMain = document.createElement('div');
    headerMain.className = 'projects-preview-card-header-main';
    const title = document.createElement('p');
    title.className = 'projects-preview-card-title mb-0';
    title.textContent = (task.title || '').trim() || task.text || '(No title)';
    headerMain.appendChild(title);
    header.appendChild(headerMain);
    header.appendChild(buildPreviewActions(projectId, task, 'task'));
    card.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'projects-preview-card-meta';
    meta.appendChild(statusChip(task.status));
    const priority = priorityChip(task.priority);
    if (priority) meta.appendChild(priority);
    const taskKey = taskNodeKey(projectId, task.id);
    const effective = effectiveRanges?.get?.(taskKey);
    const useEffective = task.auto_rollup_dates && effective?.source === 'children' && effective?.startDate && effective?.endDate;
    const rangeStart = useEffective ? effective.startDate : task.auto_rollup_dates ? null : task.start_date;
    const rangeEnd = useEffective ? effective.endDate : task.auto_rollup_dates ? null : task.end_date;
    const range = dateRangeMeta(rangeStart, rangeEnd);
    if (range) {
        const rangeChip = chip('status-none meta-date');
        rangeChip.textContent = range;
        meta.appendChild(rangeChip);
    }
    if (compactTaskPreview) {
        headerMain.appendChild(meta);
    } else {
        card.appendChild(meta);
    }
    if (task.parent_task_id || parentHint) {
        const parentProjectId = task.parent_project_id || projectId;
        const parentTaskId = task.parent_task_id;
        const sameProject = parentProjectId === projectId;
        const parentProject = projectById(parentProjectId);
        const parsedHint = parseParentHintLabel(parentHint);
        const cachedParent = parentTaskId ? getCachedTask(parentProjectId, parentTaskId) : null;
        const cachedTitle = (cachedParent?.title || cachedParent?.text || '').trim();
        const taskLabel = cachedTitle || parsedHint.task || (parentTaskId ? `#${parentTaskId}` : '');
        const projectLabel = (parentProject?.name || parentProject?.id || parsedHint.project || parentProjectId || '').trim();
        const displayLabel = sameProject ? taskLabel : `${projectLabel} / ${taskLabel}`;
        const parentRow = document.createElement('div');
        parentRow.className = 'projects-preview-parent-row';
        const parentLink = document.createElement('button');
        parentLink.type = 'button';
        parentLink.className = 'projects-preview-parent-link';
        parentLink.textContent = displayLabel || (parentTaskId ? `#${parentTaskId}` : parentHint || '');
        parentLink.title = parentLink.textContent;
        if (!parentTaskId) {
            parentLink.disabled = true;
        } else {
            parentLink.addEventListener('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!previewEntriesCache.has(parentProjectId)) {
                    await ensurePreviewEntriesForProjects([parentProjectId]);
                }
                const resolved = getCachedTask(parentProjectId, parentTaskId);
                if (!resolved) {
                    showToast('Parent task not found.', true);
                    return;
                }
                void showTaskView(resolved, parentProjectId);
            });
        }
        parentRow.appendChild(parentLink);
        card.appendChild(parentRow);
    }
    card.addEventListener('click', (event) => {
        if (event.target.closest('.projects-preview-actions')) return;
        if (event.target.closest('.projects-preview-parent-link')) return;
        void showTaskView(task, projectId);
    });
    return card;
}

function buildNoteCard(projectId, note, previewLineLimit) {
    const previewContent = buildNotePreviewText(note.text, previewLineLimit);
    const card = document.createElement('div');
    card.className = 'projects-preview-card';
    card.dataset.projectId = projectId;
    card.dataset.entryId = note.id || '';
    card.dataset.entryType = 'note';
    const color = normalizeHexColor(note.color);
    if (color) {
        card.classList.add('accented');
        card.style.borderLeftColor = color;
        card.style.background = 'color-mix(in srgb, var(--bs-body-bg) 92%, ' + color + ')';
    }
    const header = document.createElement('div');
    header.className = 'projects-preview-card-header';
    const title = document.createElement('p');
    title.className = 'projects-preview-card-title mb-0 projects-preview-note-text';
    title.style.setProperty('--projects-note-lines', previewContent.limit);
    title.textContent = previewContent.preview;
    header.appendChild(title);
    header.appendChild(buildPreviewActions(projectId, note, 'note'));
    card.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'projects-preview-card-meta';
    const priority = priorityChip(note.priority);
    if (priority) meta.appendChild(priority);
    card.appendChild(meta);
    card.addEventListener('click', (event) => {
        if (event.target.closest('.projects-preview-actions')) return;
        showNoteView(note, projectById(projectId));
    });
    return card;
}

function buildLinkedNoteCard(projectId, linkedNote, previewLineLimit) {
    const note = linkedNote?.note || {};
    const previewContent = buildNotePreviewText(note.text, previewLineLimit);
    const card = document.createElement('div');
    card.className = 'projects-preview-card';
    const rawPath = typeof linkedNote?.path === 'string' ? linkedNote.path : '.';
    const normalizedPath = normalizePath(rawPath) || '.';
    const isDir = Boolean(linkedNote?.is_dir);
    card.dataset.projectId = projectId;
    card.dataset.linkedNote = '1';
    card.dataset.path = normalizedPath;
    card.dataset.isDir = isDir ? '1' : '0';
    const color = normalizeHexColor(note.color);
    if (color) {
        card.classList.add('accented');
        card.style.borderLeftColor = color;
        card.style.background = 'color-mix(in srgb, var(--bs-body-bg) 92%, ' + color + ')';
    }
    const header = document.createElement('div');
    header.className = 'projects-preview-card-header';
    const title = document.createElement('p');
    title.className = 'projects-preview-card-title mb-0 projects-preview-note-text';
    title.style.setProperty('--projects-note-lines', previewContent.limit);
    title.textContent = previewContent.preview;
    header.appendChild(title);
    const actions = document.createElement('div');
    actions.className = 'projects-preview-actions';
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'btn btn-outline-secondary btn-sm';
    openButton.innerHTML = '&#128279;';
    const openLabel = isDir ? 'Open in workspace' : 'Preview in workspace';
    openButton.setAttribute('aria-label', openLabel);
    openButton.setAttribute('title', openLabel);
    openButton.addEventListener('click', (event) => {
        event.stopPropagation();
        openLinkedNoteInWorkspace(projectId, { path: normalizedPath, is_dir: isDir });
    });
    actions.appendChild(openButton);
    header.appendChild(actions);
    card.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'projects-preview-card-meta';
    const priority = priorityChip(note.priority);
    if (priority) meta.appendChild(priority);
    card.appendChild(meta);
    card.addEventListener('click', (event) => {
        if (event.target.closest('.projects-preview-actions')) return;
        showNoteView(note, projectById(projectId));
    });
    return card;
}

function collectLinkedNoteItems(projectId) {
    const cached = getLinkedNotesCache(projectId);
    const linkedNotes = Array.isArray(cached?.linked_notes) ? cached.linked_notes : [];
    return linkedNotes
        .filter((item) => item && item.note)
        .map((item) => ({ projectId, note: item.note, linked: item }));
}

function buildAggregatedTaskItems(selectedIds) {
    const items = [];
    selectedIds.forEach((projectId) => {
        const cached = previewEntriesCache.get(projectId);
        const tasks = cached?.tasks || [];
        tasks.forEach((task) => items.push({ projectId, task }));
    });
    return items;
}

function collectCachedTaskItems(projectIds = null) {
    const items = [];
    const ids =
        Array.isArray(projectIds) && projectIds.length
            ? projectIds
            : Array.from(previewEntriesCache.keys());
    ids.forEach((projectId) => {
        const cached = previewEntriesCache.get(projectId);
        const tasks = cached?.tasks || [];
        tasks.forEach((task) => items.push({ projectId, task }));
    });
    return items;
}

function buildTaskTree(filteredItems, allItems) {
    const allMap = new Map();
    allItems.forEach((item) => {
        if (!item?.task?.id) return;
        allMap.set(taskNodeKey(item.projectId, item.task.id), item);
    });
    const nodes = new Map();
    filteredItems.forEach((item) => {
        if (!item?.task?.id) return;
        const key = taskNodeKey(item.projectId, item.task.id);
        nodes.set(key, { ...item, key, children: [], parentHint: '' });
    });
    const roots = [];
    nodes.forEach((node) => {
        const parentTaskId = node.task.parent_task_id;
        if (!parentTaskId) {
            roots.push(node);
            return;
        }
        const parentProjectId = node.task.parent_project_id || node.projectId;
        const parentKey = taskNodeKey(parentProjectId, parentTaskId);
        const parentNode = nodes.get(parentKey);
        if (parentNode && parentKey !== node.key) {
            parentNode.children.push(node);
        } else {
            const parentInScope = allMap.has(parentKey);
            node.parentHint = parentInScope ? 'Parent not shown (filtered/out of scope)' : 'Parent not shown (filtered/out of scope)';
            roots.push(node);
        }
    });
    const sorter = (a, b) => compareTasksByDate(a, b);
    const sortTree = (list) => {
        list.sort(sorter);
        list.forEach((child) => sortTree(child.children));
    };
    sortTree(roots);
    const parents = new Set();
    const collectParents = (list) => {
        list.forEach((node) => {
            if (node.children.length) {
                parents.add(node.key);
                collectParents(node.children);
            }
        });
    };
    collectParents(roots);
    return { roots, parents };
}

function renderTaskTreeNodes(roots, effectiveRanges, compactTaskPreview) {
    const rows = [];
    const renderNode = (node, depth, ancestors = new Set()) => {
        const isCycle = ancestors.has(node.key);
        const hasChildren = node.children.length > 0;
        const isCollapsed = collapsedTaskNodes.has(node.key);
        const row = document.createElement('div');
        row.className = 'projects-preview-tree-row';
        const toggleSlot = document.createElement('div');
        toggleSlot.className = 'projects-preview-tree-toggle-slot';
        if (hasChildren) {
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'projects-preview-tree-toggle';
            toggle.setAttribute('aria-label', isCollapsed ? 'Expand task children' : 'Collapse task children');
            toggle.textContent = isCollapsed ? '▸' : '▾';
                toggle.addEventListener('click', (event) => {
                    event.stopPropagation();
                    if (collapsedTaskNodes.has(node.key)) {
                        collapsedTaskNodes.delete(node.key);
                    } else {
                        collapsedTaskNodes.add(node.key);
                    }
                    userCollapsedSinceLastFilterChange = true;
                    persistCollapsedTasks(currentTaskKeys);
                    refreshTimeline();
                    const selectedIds = getSelectedProjectIdsForPreview();
                    const effectiveIds = getEffectivePreviewProjectIds(selectedIds);
                    renderPreviewContentForSelection(selectedIds, effectiveIds);
                });
            toggleSlot.appendChild(toggle);
        }
        row.appendChild(toggleSlot);
        const card = buildTaskCard(node.projectId, node.task, {
            depth,
            parentHint: node.parentHint || (isCycle ? 'Cycle detected' : ''),
            isTree: true,
            effectiveRanges,
            compactTaskPreview,
        });
        row.appendChild(card);
        rows.push(row);
        if (isCycle || isCollapsed) return;
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(node.key);
        node.children.forEach((child) => renderNode(child, depth + 1, nextAncestors));
    };
    roots.forEach((root) => renderNode(root, 0, new Set()));
    return rows;
}

function reconcileCollapsedState(validItems) {
    const validKeys = new Set(validItems.map((item) => taskNodeKey(item.projectId, item.task.id)));
    let changed = false;
    collapsedTaskNodes.forEach((key) => {
        if (!validKeys.has(key)) {
            collapsedTaskNodes.delete(key);
            changed = true;
        }
    });
    if (changed) {
        persistCollapsedTasks(validKeys);
    }
    return validKeys;
}

function autoExpandForFilters(filteredItems, allItems) {
    const signature = JSON.stringify({ filters: taskFilters, showArchivedTasks });
    if (signature === lastTaskFilterSignature) return;
    lastTaskFilterSignature = signature;
    userCollapsedSinceLastFilterChange = false;
    if (!getProjectSettings().taskHierarchyView) return;
    const map = new Map();
    allItems.forEach((item) => {
        if (!item?.task?.id) return;
        map.set(taskNodeKey(item.projectId, item.task.id), item);
    });
    const toExpand = new Set();
    filteredItems.forEach((item) => {
        let cursor = item;
        const seen = new Set();
        while (cursor?.task?.parent_task_id) {
            const parentKey = taskNodeKey(cursor.task.parent_project_id || cursor.projectId, cursor.task.parent_task_id);
            if (seen.has(parentKey)) break;
            seen.add(parentKey);
            const parent = map.get(parentKey);
            if (!parent) break;
            toExpand.add(parentKey);
            cursor = parent;
        }
    });
    let changed = false;
    toExpand.forEach((key) => {
        if (collapsedTaskNodes.has(key)) {
            collapsedTaskNodes.delete(key);
            changed = true;
        }
    });
    if (changed) {
        persistCollapsedTasks(currentTaskKeys.size ? currentTaskKeys : map.keys());
    }
}

function buildAggregatedNoteItems(selectedIds) {
    const items = [];
    selectedIds.forEach((projectId) => {
        const cached = previewEntriesCache.get(projectId);
        const notes = cached?.notes || [];
        notes.forEach((note) => items.push({ projectId, note }));
    });
    return items;
}

function getCachedTask(projectId, taskId) {
    const cached = previewEntriesCache.get(projectId);
    if (!cached?.tasks) return null;
    return cached.tasks.find((task) => task.id === taskId) || null;
}

function getCachedNote(projectId, noteId) {
    const cached = previewEntriesCache.get(projectId);
    if (!cached?.notes) return null;
    return cached.notes.find((note) => note.id === noteId) || null;
}

function removeEntryFromCache(projectId, entryId, type) {
    const cached = previewEntriesCache.get(projectId);
    if (!cached) return;
    if (type === 'task' && Array.isArray(cached.tasks)) {
        cached.tasks = cached.tasks.filter((t) => t.id !== entryId);
    }
    if (type === 'note' && Array.isArray(cached.notes)) {
        cached.notes = cached.notes.filter((n) => n.id !== entryId);
    }
    previewEntriesCache.set(projectId, cached);
}

async function deleteProjectEntryWithRefresh(projectId, entryId, type, confirmMessage) {
    if (!projectId || !entryId) return;
    const ok = confirmMessage ? await showConfirm(confirmMessage) : true;
    if (!ok) return;
    try {
        await deleteProjectEntry(projectId, entryId, type);
        removeEntryFromCache(projectId, entryId, type);
        await refreshPreviewForCurrentSelection([projectId], true);
        refreshTimeline(true);
    } catch (error) {
        showToast(error?.message || 'Unable to delete entry.', true);
    }
}

function parseDateSafe(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function computeEffectiveTaskRanges(items = []) {
    const nodes = new Map();
    items.forEach(({ projectId, task }) => {
        if (!task?.id) return;
        const key = taskNodeKey(projectId, task.id);
        nodes.set(key, {
            key,
            projectId,
            taskId: task.id,
            parentProjectId: task.parent_project_id || projectId || null,
            parentTaskId: task.parent_task_id || null,
            autoRollup: !!task.auto_rollup_dates,
            startDate: parseDateSafe(task.start_date),
            endDate: parseDateSafe(task.end_date),
        });
    });

    const parentKeyMap = new Map();
    nodes.forEach((node) => {
        if (!node.parentTaskId) {
            parentKeyMap.set(node.key, null);
            return;
        }
        const parentKey = taskNodeKey(node.parentProjectId || node.projectId, node.parentTaskId);
        parentKeyMap.set(node.key, nodes.has(parentKey) && parentKey !== node.key ? parentKey : null);
    });

    const cycleKeys = new Set();
    nodes.forEach((node) => {
        const seen = new Map();
        const path = [];
        let current = node.key;
        while (current) {
            if (seen.has(current)) {
                const startIndex = seen.get(current);
                for (let i = startIndex; i < path.length; i += 1) {
                    cycleKeys.add(path[i]);
                }
                break;
            }
            seen.set(current, path.length);
            path.push(current);
            const parentKey = parentKeyMap.get(current);
            if (!parentKey || !nodes.has(parentKey)) break;
            current = parentKey;
        }
    });

    const childrenMap = new Map();
    parentKeyMap.forEach((parentKey, childKey) => {
        if (!parentKey) return;
        const list = childrenMap.get(parentKey) || [];
        list.push(childKey);
        childrenMap.set(parentKey, list);
    });

    const memo = new Map();
    const compute = (key) => {
        if (memo.has(key)) return memo.get(key);
        if (cycleKeys.has(key)) {
            const result = { startDate: null, endDate: null, source: 'cycle' };
            memo.set(key, result);
            return result;
        }
        const node = nodes.get(key);
        if (!node) return null;
        const childKeys = childrenMap.get(key) || [];
        const childRanges = childKeys
            .map((childKey) => compute(childKey))
            .filter((range) => range && range.startDate && range.endDate);
        let result = null;
        if (node.autoRollup) {
            if (childRanges.length) {
                let minStart = childRanges[0].startDate;
                let maxEnd = childRanges[0].endDate;
                childRanges.forEach((range) => {
                    if (range.startDate < minStart) minStart = range.startDate;
                    if (range.endDate > maxEnd) maxEnd = range.endDate;
                });
                result = { startDate: minStart, endDate: maxEnd, source: 'children' };
            }
        } else if (node.startDate && node.endDate) {
            result = { startDate: node.startDate, endDate: node.endDate, source: 'self' };
        }
        memo.set(key, result);
        return result;
    };

    nodes.forEach((node) => {
        compute(node.key);
    });

    return { ranges: memo, children: childrenMap, cycleKeys };
}

function applyTaskFilters(items) {
    return items.filter(({ projectId, task }) => {
        const projectFilter = taskFilters.project;
        if (projectFilter && projectFilter !== 'all' && projectId !== projectFilter) return false;
        const priorityFilter = (taskFilters.priority || '').toLowerCase();
        if (priorityFilter && (task.priority || '').toLowerCase() !== priorityFilter) return false;
        const statusFilter = (taskFilters.status || '').toLowerCase();
        const status = (task.status || 'none').toLowerCase();
        if (statusFilter && statusFilter !== 'any' && statusFilter !== status) return false;
        const startDate = parseDateSafe(task.start_date);
        const endDate = parseDateSafe(task.end_date);
        if (taskFilters.startFrom) {
            const from = parseDateSafe(taskFilters.startFrom);
            if (from && (!startDate || startDate < from)) return false;
            if (!startDate && from) return false;
        }
        if (taskFilters.endUntil) {
            const until = parseDateSafe(taskFilters.endUntil);
            if (until && (!endDate || endDate > until)) return false;
            if (!endDate && until) return false;
        }
        const minDuration = taskFilters.minDurationDays;
        const maxDuration = taskFilters.maxDurationDays;
        const hasDurationFilter =
            (typeof minDuration === 'number' && Number.isFinite(minDuration)) ||
            (typeof maxDuration === 'number' && Number.isFinite(maxDuration));
        if (hasDurationFilter) {
            if (!startDate || !endDate) return false;
            const durationDays = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
            if (typeof minDuration === 'number' && Number.isFinite(minDuration) && durationDays < minDuration)
                return false;
            if (typeof maxDuration === 'number' && Number.isFinite(maxDuration) && durationDays > maxDuration)
                return false;
        }
        return true;
    });
}

function applyNoteFilters(items) {
    return items.filter(({ projectId, note }) => {
        const projectFilter = noteFilters.project;
        if (projectFilter && projectFilter !== 'all' && projectId !== projectFilter) return false;
        const priorityFilter = (noteFilters.priority || '').toLowerCase();
        if (priorityFilter && (note.priority || '').toLowerCase() !== priorityFilter) return false;
        const createdAt = parseDateSafe(note.created_at);
        if (noteFilters.createdFrom) {
            const from = parseDateSafe(noteFilters.createdFrom);
            if (from && (!createdAt || createdAt < from)) return false;
        }
        if (noteFilters.createdUntil) {
            const until = parseDateSafe(noteFilters.createdUntil);
            if (until && (!createdAt || createdAt > until)) return false;
        }
        return true;
    });
}

function markTaskFiltersChanged() {
    lastTaskFilterSignature = '';
    userCollapsedSinceLastFilterChange = false;
    scheduleTimelineRefresh();
}

function renderTasksListForSelection(selectedIds) {
    const allItems = buildAggregatedTaskItems(selectedIds);
    const effectiveRanges = computeEffectiveTaskRanges(collectCachedTaskItems()).ranges;
    const compactTaskPreview = getProjectSettings().compactTaskPreview;
    const items = applyTaskFilters(allItems);
    currentTaskKeys = reconcileCollapsedState(allItems);
    const hierarchyEnabled = Boolean(getProjectSettings().taskHierarchyView);
    const filteredForAutoExpand = showArchivedTasks
        ? items
        : items.filter((item) => (item.task.status || 'none').toLowerCase() !== 'closed');
    if (hierarchyEnabled && !userCollapsedSinceLastFilterChange) {
        autoExpandForFilters(filteredForAutoExpand, allItems);
        currentTaskKeys = reconcileCollapsedState(allItems);
    }
    const open = [];
    const archived = [];
    items.forEach((item) => {
        const status = (item.task.status || 'none').toLowerCase();
        if (status === 'closed') {
            archived.push(item);
        } else {
            open.push(item);
        }
    });
    open.sort(compareTasksByDate);
    archived.sort(compareTasksByDate);
    const list = [];
    if (hierarchyEnabled) {
        lastTaskTreeParents = new Set();
        const openTree = buildTaskTree(open, allItems);
        openTree.parents.forEach((key) => lastTaskTreeParents.add(key));
        const openNodes = renderTaskTreeNodes(openTree.roots, effectiveRanges, compactTaskPreview);
        openNodes.forEach((node) => list.push(node));
    } else {
        lastTaskTreeParents = new Set();
        open.forEach((item) =>
            list.push(buildTaskCard(item.projectId, item.task, { effectiveRanges, compactTaskPreview })),
        );
    }
    if (showArchivedTasks && archived.length) {
        const label = document.createElement('div');
        label.className = 'projects-preview-section-title';
        label.textContent = 'Archived';
        list.push(label);
        if (hierarchyEnabled) {
            const archivedTree = buildTaskTree(archived, allItems);
            archivedTree.parents.forEach((key) => lastTaskTreeParents.add(key));
            renderTaskTreeNodes(archivedTree.roots, effectiveRanges, compactTaskPreview).forEach((node) =>
                list.push(node),
            );
        } else {
            archived.forEach((item) =>
                list.push(buildTaskCard(item.projectId, item.task, { effectiveRanges, compactTaskPreview })),
            );
        }
    }
    return list;
}

function renderNotesListForSelection(selectedIds, effectiveIds = selectedIds) {
    const lineLimit = getNotePreviewLineCount();
    const sortNotesDesc = (a, b) => {
        const aCreated = parseDateSafe(a.note.created_at);
        const bCreated = parseDateSafe(b.note.created_at);
        const aVal = aCreated ? aCreated.getTime() : 0;
        const bVal = bCreated ? bCreated.getTime() : 0;
        return bVal - aVal;
    };
    const list = [];
    const appendSection = (labelText, items, buildCard, forceLabel = false, options = {}) => {
        if (!items.length && !forceLabel) return;
        const { sectionId = null, toggleKey = null } = options || {};
        const createLabel = () => {
            const label = document.createElement('div');
            label.className = 'projects-preview-section-title';
            label.textContent = labelText;
            if (sectionId && toggleKey) {
                label.classList.add('projects-preview-section-toggle');
                label.dataset.notesSectionToggle = toggleKey;
                label.setAttribute('role', 'button');
                label.setAttribute('aria-controls', sectionId);
                label.setAttribute('aria-expanded', 'true');
                label.tabIndex = 0;
            }
            return label;
        };
        const createContent = () => {
            const content = document.createElement('div');
            content.className = 'projects-preview-section-content';
            content.id = sectionId;
            return content;
        };
        if (!items.length) {
            if (forceLabel) {
                const label = createLabel();
                list.push(label);
                if (sectionId) {
                    list.push(createContent());
                }
            }
            return;
        }
        const open = [];
        const archived = [];
        items.forEach((item) => {
            const status = (item.note.status || 'none').toLowerCase();
            if (status === 'closed') {
                archived.push(item);
            } else {
                open.push(item);
            }
        });
        open.sort(sortNotesDesc);
        archived.sort(sortNotesDesc);
        if (!open.length && !(showArchivedTasks && archived.length)) {
            if (forceLabel) {
                const label = createLabel();
                list.push(label);
                if (sectionId) {
                    list.push(createContent());
                }
            }
            return;
        }
        const label = createLabel();
        list.push(label);
        const content = sectionId ? createContent() : null;
        if (content) {
            list.push(content);
        }
        const appendNode = (node) => {
            if (content) {
                content.appendChild(node);
            } else {
                list.push(node);
            }
        };
        open.forEach((item) => appendNode(buildCard(item)));
        if (showArchivedTasks && archived.length) {
            const archivedLabel = document.createElement('div');
            archivedLabel.className = 'projects-preview-section-title';
            archivedLabel.textContent = 'Archived';
            appendNode(archivedLabel);
            archived.forEach((item) => appendNode(buildCard(item)));
        }
    };

    if (selectedIds.length !== 1) {
        const items = applyNoteFilters(buildAggregatedNoteItems(effectiveIds));
        const open = [];
        const archived = [];
        items.forEach((item) => {
            const status = (item.note.status || 'none').toLowerCase();
            if (status === 'closed') {
                archived.push(item);
            } else {
                open.push(item);
            }
        });
        open.sort(sortNotesDesc);
        archived.sort(sortNotesDesc);
        open.forEach((item) => list.push(buildNoteCard(item.projectId, item.note, lineLimit)));
        if (showArchivedTasks && archived.length) {
            const label = document.createElement('div');
            label.className = 'projects-preview-section-title';
            label.textContent = 'Archived';
            list.push(label);
            archived.forEach((item) => list.push(buildNoteCard(item.projectId, item.note, lineLimit)));
        }
        return list;
    }

    const projectId = selectedIds[0];
    const project = projectById(projectId);
    const projectNotes = applyNoteFilters(buildAggregatedNoteItems(effectiveIds));
    const linkedNotes = project?.root_path ? applyNoteFilters(collectLinkedNoteItems(projectId)) : [];
    if (!projectNotes.length && !linkedNotes.length) {
        return list;
    }
    appendSection(
        'Project notes',
        projectNotes,
        (item) => buildNoteCard(item.projectId, item.note, lineLimit),
        linkedNotes.length > 0,
        { sectionId: 'project-notes-section-content', toggleKey: 'project' },
    );
    if (linkedNotes.length) {
        appendSection(
            'Linked notes (from workspace)',
            linkedNotes,
            (item) => buildLinkedNoteCard(projectId, item.linked, lineLimit),
            false,
            { sectionId: 'linked-notes-section-content', toggleKey: 'linked' },
        );
    }
    return list;
}

async function ensurePreviewEntriesForProjects(projectIds, force = false) {
    const targets = (projectIds || []).filter(Boolean);
    if (!targets.length) return;
    let showedLoading = false;
    const loaders = targets.map(async (projectId) => {
        if (!force && previewEntriesCache.has(projectId)) return;
        if (!showedLoading) {
            renderPreviewLoading();
            showedLoading = true;
        }
        try {
            const payload = await fetchProjectEntries(projectId);
            const entriesRaw = payload?.entries || payload || {};
            const tasks = Array.isArray(entriesRaw.tasks)
                ? entriesRaw.tasks
                : Array.isArray(entriesRaw.task)
                    ? entriesRaw.task
                    : [];
            const notes = Array.isArray(entriesRaw.notes)
                ? entriesRaw.notes
                : Array.isArray(entriesRaw.note)
                    ? entriesRaw.note
                    : [];
            previewEntriesCache.set(projectId, {
                tasks,
                notes,
            });
        } catch (error) {
            renderPreviewError(error?.message || 'Unable to load entries.');
        }
    });
    await Promise.all(loaders);
}

async function refreshPreviewForCurrentSelection(extraProjects = [], forceReload = true) {
    const selectedIds = getSelectedProjectIdsForPreview();
    if (!selectedIds.length) return;
    const effectiveIds = getEffectivePreviewProjectIds(selectedIds);
    const targets = new Set(effectiveIds);
    (extraProjects || []).forEach((id) => id && targets.add(id));
    await ensurePreviewEntriesForProjects([...targets], forceReload);
    renderPreviewContentForSelection(selectedIds, effectiveIds);
    refreshTimeline(forceReload);
}

function syncProjectFilterOptions(selectedIds, scopedIdsArg = null) {
    const scopedIds = scopedIdsArg && scopedIdsArg.length ? scopedIdsArg : selectedIds;
    const scopedList = scopedIds.map((id) => projectById(id)).filter(Boolean);
    const applyOptions = (select, currentValue, isTask) => {
        if (!select) return;
        const previous = currentValue;
        select.innerHTML = '';
        const allOption = document.createElement('option');
        allOption.value = 'all';
        allOption.textContent = 'All projects';
        select.appendChild(allOption);
        scopedList.forEach((project) => {
            const option = document.createElement('option');
            option.value = project.id;
            option.textContent = project.name || project.id;
            select.appendChild(option);
        });
        let nextValue = previous;
        const validIds = scopedList.map((p) => p.id);
        if (nextValue !== 'all' && !validIds.includes(nextValue)) {
            nextValue = 'all';
        }
        select.value = nextValue || 'all';
        select.disabled = scopedList.length <= 1;
        if (isTask) {
            taskFilters.project = select.value;
        } else {
            noteFilters.project = select.value;
        }
    };
    applyOptions(filterTaskProject, taskFilters.project, true);
    applyOptions(filterNoteProject, noteFilters.project, false);
}

function toggleFilterVisibility() {
    if (!previewFiltersContainer) return;
    const showTasks = currentPreviewMode === 'task';
    previewTaskFilters?.classList.toggle('d-none', !filtersVisible || !showTasks);
    previewNoteFilters?.classList.toggle('d-none', !filtersVisible || showTasks);
    if (filtersVisible) {
        if (showTasks) {
            syncTaskFilterControls();
        } else {
            syncNoteFilterControls();
        }
    }
}

function updateHierarchyControls(selectedCount = null) {
    void selectedCount;
}

function renderPreviewContentForSelection(selectedIds, effectiveSelection = null) {
    const effectiveIds = (() => {
        if (Array.isArray(effectiveSelection) && effectiveSelection.length) {
            return [...new Set(effectiveSelection)];
        }
        return getEffectivePreviewProjectIds(selectedIds);
    })();
    ensureValidProjectFilterForMode(effectiveIds);
    applyPreviewHeaderForSelection(selectedIds, effectiveIds);
    if (!isPreviewVisible()) {
        renderPreviewPlaceholder('Preview hidden', 'Switch to a layout with Tasks/Notes to see entries.');
        return;
    }
    if (!selectedIds.length) {
        renderPreviewPlaceholder('Select a project', 'Choose a project to see its tasks and notes.');
        return;
    }
    if (!effectiveIds.length) {
        renderPreviewPlaceholder('Select a project', 'Choose a project to see its tasks and notes.');
        return;
    }
    const missing = effectiveIds.some((id) => !previewEntriesCache.has(id));
    if (missing) {
        renderPreviewLoading();
        return;
    }
    let nodes = [];
    if (currentPreviewMode === 'note') {
        nodes = renderNotesListForSelection(selectedIds, effectiveIds);
    } else {
        nodes = renderTasksListForSelection(effectiveIds);
    }
    resetPreviewViews();
    if (!nodes.length) {
        renderPreviewPlaceholder(
            currentPreviewMode === 'note' ? 'No notes yet' : 'No tasks yet',
            currentPreviewMode === 'note' ? 'Use the Notes view to add context.' : 'Create tasks to track progress.'
        );
        return;
    }
    if (previewList) {
        nodes.forEach((node) => previewList.appendChild(node));
        previewList.classList.remove('d-none');
    }
}

function renderPreviewContent() {
    const selectedIds = getSelectedProjectIdsForPreview();
    const effectiveIds = getEffectivePreviewProjectIds(selectedIds);
    renderPreviewContentForSelection(selectedIds, effectiveIds);
}

function normalizeInlineEntryMode(mode) {
    return mode === 'note' ? 'note' : 'task';
}

function isInlineProjectComposerEnabled() {
    return Boolean(getProjectSettings().inlineComposerEnabled);
}

function isInlineProjectComposerVisible() {
    return Boolean(inlineComposer && !inlineComposer.classList.contains('d-none'));
}

function clearInlineComposerError() {
    inlineComposerError?.classList.add('d-none');
    if (inlineComposerError) inlineComposerError.textContent = '';
    inlineTitleInput?.classList.remove('is-invalid');
    inlineText?.classList.remove('is-invalid');
    inlineStart?.classList.remove('is-invalid');
    inlineEnd?.classList.remove('is-invalid');
}

function showInlineComposerError(message) {
    if (!inlineComposerError) {
        showToast(message || 'Unable to save entry.', true);
        return;
    }
    inlineComposerError.textContent = message || 'Unable to save entry.';
    inlineComposerError.classList.remove('d-none');
}

function setInlineComposerSaving(saving) {
    inlineComposerSaving = !!saving;
    if (inlineSaveButton) {
        inlineSaveButton.disabled = inlineComposerSaving;
        inlineSaveButton.textContent = inlineComposerSaving ? 'Saving...' : 'Save';
    }
    inlineCancelButton?.toggleAttribute('disabled', inlineComposerSaving);
    inlineComposerClose?.toggleAttribute('disabled', inlineComposerSaving);
}

function syncInlineComposerMode(mode) {
    const normalized = normalizeInlineEntryMode(mode);
    inlineComposerMode = normalized;
    if (inlineModeSelect && inlineModeSelect.value !== normalized) {
        inlineModeSelect.value = normalized;
    }
    const isTask = normalized === 'task';
    inlineTitleWrap?.classList.toggle('d-none', !isTask);
    inlineStatusWrap?.classList.toggle('d-none', !isTask);
    inlineStartWrap?.classList.toggle('d-none', !isTask);
    inlineEndWrap?.classList.toggle('d-none', !isTask);
    if (inlineTitleInput) {
        inlineTitleInput.required = isTask;
    }
    if (inlineText) {
        inlineText.rows = isTask ? 3 : 4;
        inlineText.placeholder = isTask ? 'Optional task details' : 'Required note text';
    }
    if (inlineTextHelp) {
        inlineTextHelp.textContent = isTask
            ? 'Optional for tasks.'
            : 'Required for notes.';
    }
    if (inlineComposerTitle) {
        inlineComposerTitle.textContent = isTask ? 'New task' : 'New note';
    }
}

function resetInlineComposerFields(mode = inlineComposerMode) {
    if (inlineTitleInput) inlineTitleInput.value = '';
    if (inlineText) inlineText.value = '';
    if (inlinePriority) inlinePriority.value = '';
    if (inlineStatus) inlineStatus.value = 'none';
    if (inlineStart) inlineStart.value = '';
    if (inlineEnd) inlineEnd.value = '';
    clearInlineComposerError();
    setInlineComposerSaving(false);
    syncInlineComposerMode(mode);
}

function focusInlineComposer() {
    const target = inlineComposerMode === 'task' ? inlineTitleInput : inlineText;
    setTimeout(() => target?.focus(), 0);
}

function ensurePreviewPaneForInlineComposer(mode) {
    if (getAuxPlacement() === 'hidden') {
        setAuxPlacement('right');
    }
    if (getAuxTab() !== 'tasks') {
        setAuxTab('tasks');
    }
    const normalized = normalizeInlineEntryMode(mode);
    if (currentPreviewMode !== normalized) {
        setPreviewMode(normalized);
    }
}

function selectProjectForInlineComposer(project) {
    if (!project?.id) return;
    const selectedIds = getSelectedProjectIdsForPreview();
    if (selectedIds.length === 1 && selectedIds[0] === project.id) {
        lastSelectedProjectId = project.id;
        return;
    }
    selectedProjects.clear();
    selectedProjects.add(project.id);
    lastSelectedProjectId = project.id;
    renderProjects();
    updateSelectAllCheckbox();
    updatePreviewSelection();
}

function showInlineProjectComposer(project, mode, { sourceElement = null } = {}) {
    if (!project || !inlineComposer) {
        openEntryModalForProject(project, mode);
        return;
    }
    const normalized = normalizeInlineEntryMode(mode);
    inlineComposerProjectId = project.id;
    inlineComposerReturnFocus = sourceElement || document.activeElement || null;
    selectProjectForInlineComposer(project);
    ensurePreviewPaneForInlineComposer(normalized);
    resetInlineComposerFields(normalized);
    if (inlineComposerContext) {
        inlineComposerContext.textContent = project.name || project.id || '';
    }
    inlineComposer.classList.remove('d-none');
    inlineComposer.setAttribute('aria-hidden', 'false');
    inlineComposer.scrollIntoView({ block: 'nearest' });
    focusInlineComposer();
}

function hideInlineProjectComposer({ reset = true, restoreFocus = false } = {}) {
    if (!inlineComposer) return;
    inlineComposer.classList.add('d-none');
    inlineComposer.setAttribute('aria-hidden', 'true');
    inlineComposerProjectId = null;
    setInlineComposerSaving(false);
    if (reset) {
        resetInlineComposerFields(inlineComposerMode);
    }
    if (restoreFocus && inlineComposerReturnFocus && typeof inlineComposerReturnFocus.focus === 'function') {
        inlineComposerReturnFocus.focus({ preventScroll: true });
    }
    inlineComposerReturnFocus = null;
}

function syncInlineComposerForSelection(selectedIds) {
    if (!isInlineProjectComposerVisible()) return;
    const activeId = getActivePreviewProjectId();
    if (selectedIds.length !== 1 || !activeId || activeId !== inlineComposerProjectId) {
        hideInlineProjectComposer({ restoreFocus: false });
    }
}

function buildInlineEntryPayload(project = null) {
    const mode = normalizeInlineEntryMode(inlineModeSelect?.value || inlineComposerMode);
    const text = inlineText?.value?.trim() || '';
    const projectColor = normalizeHexColor(project?.color);
    clearInlineComposerError();
    if (mode === 'note' && !text) {
        inlineText?.classList.add('is-invalid');
        return { ok: false, message: 'Description is required.' };
    }
    const payload = {
        type: mode,
        text,
        priority: inlinePriority?.value || null,
        color: projectColor || null,
    };
    if (mode === 'task') {
        const title = inlineTitleInput?.value?.trim() || '';
        if (!title) {
            inlineTitleInput?.classList.add('is-invalid');
            return { ok: false, message: 'Title is required for tasks.' };
        }
        if (title.length > 200) {
            inlineTitleInput?.classList.add('is-invalid');
            return { ok: false, message: 'Task title must be 200 characters or fewer.' };
        }
        const startValue = inlineStart?.value || '';
        const endValue = inlineEnd?.value || '';
        if (startValue && endValue && new Date(endValue) < new Date(startValue)) {
            inlineStart?.classList.add('is-invalid');
            inlineEnd?.classList.add('is-invalid');
            return { ok: false, message: 'End date cannot be earlier than start date.' };
        }
        payload.title = title;
        payload.status = inlineStatus?.value || 'none';
        payload.start_date = startValue || null;
        payload.end_date = endValue || null;
    } else {
        payload.parent_project_id = null;
        payload.parent_task_id = null;
    }
    return { ok: true, mode, payload };
}

async function handleInlineComposerSubmit(event) {
    event.preventDefault();
    if (inlineComposerSaving) return;
    const project = inlineComposerProjectId ? projectById(inlineComposerProjectId) : null;
    if (!project) {
        showInlineComposerError('Select a project before saving.');
        return;
    }
    const result = buildInlineEntryPayload(project);
    if (!result.ok) {
        showInlineComposerError(result.message);
        return;
    }
    setInlineComposerSaving(true);
    try {
        await createProjectEntry(project.id, result.payload);
        await refreshPreviewForCurrentSelection([project.id], true);
        showToast(result.mode === 'task' ? 'Task created.' : 'Note created.');
        resetInlineComposerFields(result.mode);
        inlineComposerProjectId = project.id;
        focusInlineComposer();
    } catch (error) {
        showInlineComposerError(error?.message || 'Unable to save entry.');
    } finally {
        setInlineComposerSaving(false);
    }
}

function routeProjectEntryCreate(project, mode, sourceElement = null) {
    const normalized = normalizeInlineEntryMode(mode);
    if (isInlineProjectComposerEnabled()) {
        showInlineProjectComposer(project, normalized, { sourceElement });
        return;
    }
    openEntryModalForProject(project, normalized);
}

function openEntryModalForEntry(projectId, entry, type) {
    const project = projectById(projectId);
    if (!project) return;
    openEntryModalForProject(project, type, entry);
}

function openEntryModalForProject(project, mode, entry = null) {
    if (!project || !entryModalEl || !entryForm) return;
    resetEntryForm();
    activeEntryProject = project;
    activeEntryId = entry?.id || null;
    setEntryModeOptions(project);
    const normalizedMode = mode === 'note' ? 'note' : 'task';
    if (entryModeSelect) {
        entryModeSelect.value = normalizedMode;
    }
    toggleEntryFields(normalizedMode);
    syncLinkedNoteControls(normalizedMode);
    if (entry) {
        entryText.value = entry.text || '';
        entryPriority.value = entry.priority || '';
        if (normalizedMode === 'task' && entryTitleInput) {
            entryTitleInput.value = entry.title || '';
        }
        if (normalizedMode === 'task') {
            entryStatus.value = entry.status || 'none';
        } else {
            entryStatus.value = 'none';
        }
        entryColor.value = entry.color || '';
        if (normalizedMode === 'task') {
            entryDeadline.value = entry.deadline || '';
        } else {
            entryDeadline.value = '';
        }
        entryStart.value = entry.start_date || '';
        entryEnd.value = entry.end_date || '';
        reminderFormController.loadFromTask(entry);
        syncEntryAutoRollupControls(entry, project.id);
    } else {
        const projectColor = normalizeHexColor(project.color);
        if (projectColor && entryColor) {
            entryColor.value = projectColor;
        }
        reminderFormController.reset();
        reminderFormController.syncMode(normalizedMode);
        syncEntryAutoRollupControls(null, project.id);
    }
    void syncParentTaskSelectors(entry || null);
    const isEdit = Boolean(entry);
    setEntryParentProjectLock(isEdit);
    const titleText = isEdit ? (normalizedMode === 'note' ? 'Edit Note' : 'Edit Task') : normalizedMode === 'note' ? 'Create Note' : 'Create Task';
    if (entryTitle) entryTitle.textContent = titleText;
    if (entrySaveButton) entrySaveButton.textContent = isEdit ? 'Save changes' : 'Create';
    const modal = bootstrapModal(entryModalEl);
    modal?.show();
    entryText?.focus();
}

function storeManualEntryDates() {
    if (!entryModalEl) return;
    entryModalEl.dataset.manualStartIso = entryStart?.value || '';
    entryModalEl.dataset.manualEndIso = entryEnd?.value || '';
}

function restoreManualEntryDates() {
    if (!entryStart || !entryEnd) return;
    const manualStart = entryModalEl?.dataset.manualStartIso || '';
    const manualEnd = entryModalEl?.dataset.manualEndIso || '';
    entryStart.value = manualStart;
    entryEnd.value = manualEnd;
}

function applyEntryAutoRollupState(autoEnabled, effectiveRange, isCycle = false) {
    if (!entryStart || !entryEnd) return;
    if (!autoEnabled) {
        entryStart.removeAttribute('disabled');
        entryEnd.removeAttribute('disabled');
        restoreManualEntryDates();
        if (entryAutoRollupHelp) {
            entryAutoRollupHelp.textContent = '';
            entryAutoRollupHelp.classList.add('d-none');
        }
        return;
    }

    entryStart.setAttribute('disabled', 'true');
    entryEnd.setAttribute('disabled', 'true');
    let helpText = 'No dated children yet.';
    if (isCycle) {
        helpText = 'Cycle detected. Cannot compute from children.';
        entryStart.value = '';
        entryEnd.value = '';
    } else if (effectiveRange?.startDate && effectiveRange?.endDate && effectiveRange?.source === 'children') {
        const startIso = toISODate(effectiveRange.startDate);
        const endIso = toISODate(effectiveRange.endDate);
        entryStart.value = startIso;
        entryEnd.value = endIso;
        helpText = `Computed from children: ${startIso} -> ${endIso}`;
    } else {
        entryStart.value = '';
        entryEnd.value = '';
    }
    if (entryAutoRollupHelp) {
        entryAutoRollupHelp.textContent = helpText;
        entryAutoRollupHelp.classList.toggle('d-none', !helpText);
    }
}

function syncEntryAutoRollupControls(entry, projectId) {
    if (!entryAutoRollupWrap || !entryAutoRollupDates || !entryStart || !entryEnd) return;
    const isTaskMode = (entryModeSelect?.value || 'task') === 'task';
    if (!isTaskMode || !entry?.id || !projectId) {
        entryAutoRollupWrap.classList.add('d-none');
        entryAutoRollupDates.checked = false;
        entryStart.removeAttribute('disabled');
        entryEnd.removeAttribute('disabled');
        if (entryAutoRollupHelp) {
            entryAutoRollupHelp.textContent = '';
            entryAutoRollupHelp.classList.add('d-none');
        }
        return;
    }
    const cachedItems = collectCachedTaskItems();
    const { ranges, children, cycleKeys } = computeEffectiveTaskRanges(cachedItems);
    const key = taskNodeKey(projectId, entry.id);
    const hasChildren = (children.get(key) || []).length > 0;
    const autoEnabled = !!entry.auto_rollup_dates;
    const shouldShow = hasChildren || autoEnabled;
    entryAutoRollupWrap.classList.toggle('d-none', !shouldShow);
    if (!shouldShow) {
        entryAutoRollupDates.checked = false;
        entryStart.removeAttribute('disabled');
        entryEnd.removeAttribute('disabled');
        if (entryAutoRollupHelp) {
            entryAutoRollupHelp.textContent = '';
            entryAutoRollupHelp.classList.add('d-none');
        }
        return;
    }
    entryAutoRollupDates.checked = autoEnabled;
    storeManualEntryDates();
    const effectiveRange = ranges.get(key);
    const isCycle = cycleKeys.has(key) || effectiveRange?.source === 'cycle';
    applyEntryAutoRollupState(autoEnabled, effectiveRange, isCycle);
}

function showNoteView(note, project) {
    if (!note || !noteViewModal || !noteViewBody) return;
    const metaParts = [];
    if (project) metaParts.push(project.name || project.id);
    if (note.priority) metaParts.push(`Priority: ${note.priority}`);
    if (note.color) metaParts.push('Colour set');
    if (noteViewMeta) {
        noteViewMeta.textContent = metaParts.join(' | ');
    }
    noteViewBody.textContent = note.text || '(No content)';
    const modal = bootstrapModal(noteViewModal);
    modal?.show();
}

async function showTaskView(task, projectId) {
    if (!task || !taskViewModal) return;
    const project = projectById(projectId);
    const title = (task.title || '').trim() || (task.text || '').trim() || 'Task details';
    if (taskViewTitle) taskViewTitle.textContent = title;
    if (taskViewProject) taskViewProject.textContent = project ? project.name || project.id : projectId;
    if (taskViewDescription) {
        taskViewDescription.textContent = task.text || '(No description)';
    }
    if (taskViewColor) {
        const color = normalizeHexColor(task.color);
        taskViewColor.classList.toggle('d-none', !color);
        if (color) {
            taskViewColor.style.setProperty('background', color);
            taskViewColor.style.setProperty('border-color', color);
        } else {
            taskViewColor.style.removeProperty('background');
            taskViewColor.style.removeProperty('border-color');
        }
    }
    if (taskViewBadges) {
        taskViewBadges.innerHTML = '';
        taskViewBadges.appendChild(statusChip(task.status));
        const pr = priorityChip(task.priority);
        if (pr) taskViewBadges.appendChild(pr);
        if (task.color) {
            const swatch = chip('status-none', 'Colour set');
            const swatchColor = normalizeHexColor(task.color);
            if (swatchColor) {
                swatch.style.background = swatchColor;
                swatch.style.color = pickReadableTextColor(swatchColor);
            }
            swatch.style.borderColor = 'transparent';
            taskViewBadges.appendChild(swatch);
        }
    }
    if (taskViewDates) {
        taskViewDates.innerHTML = '';
        const start = parseDateSafe(task.start_date);
        const end = parseDateSafe(task.end_date);
        const addField = (label, value) => {
            if (!value) return;
            const col = document.createElement('div');
            col.className = 'col-12 col-md-6';
            const strong = document.createElement('div');
            strong.className = 'fw-semibold text-body';
            strong.textContent = label;
            const small = document.createElement('div');
            small.textContent = value;
            col.append(strong, small);
            taskViewDates.appendChild(col);
        };
        addField('Start date', start ? formatDate(task.start_date) : '');
        addField('End date', end ? formatDate(task.end_date) : '');
        if (start && end) {
            const days = Math.max(0, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
            addField('Duration', `${days} day${days === 1 ? '' : 's'}`);
        }
        addField('Created', formatDateTime(task.created_at));
        addField('Updated', formatDateTime(task.updated_at));
    }
    if (taskViewMeta) {
        const parts = [];
        if (task.status) parts.push(`Status: ${task.status}`);
        if (task.priority) parts.push(`Priority: ${task.priority}`);
        taskViewMeta.textContent = parts.join(' | ');
    }
    if (taskViewParent) {
        const parentProjectId = task.parent_project_id || projectId;
        const parentTaskId = task.parent_task_id;
        if (parentTaskId) {
            try {
                await ensurePreviewEntriesForProjects([parentProjectId]);
            } catch (error) {
                console.warn('Unable to refresh parent task', error);
            }
            const parentTask = previewEntriesCache.get(parentProjectId)?.tasks?.find((t) => t.id === parentTaskId);
            if (parentTask) {
                const parentProject = projectById(parentProjectId);
                const label = taskOptionLabel(parentTask);
                taskViewParent.textContent = `Parent: ${parentProject ? parentProject.name || parentProject.id : parentProjectId} — ${label}`;
                taskViewParent.classList.remove('d-none');
            } else {
                taskViewParent.classList.add('d-none');
                taskViewParent.textContent = '';
            }
        } else {
            taskViewParent.classList.add('d-none');
            taskViewParent.textContent = '';
        }
    }
    const modal = bootstrapModal(taskViewModal);
    modal?.show();
}

function updatePreviewAfterSave() {
    const targetId = activeEntryProject?.id || getActivePreviewProjectId();
    const targets = targetId ? [targetId] : [];
    void refreshPreviewForCurrentSelection(targets, true);
    refreshTimeline(true);
}

function getActivePreviewProjectId() {
    if (!selectedProjects.size) return null;
    if (lastSelectedProjectId && selectedProjects.has(lastSelectedProjectId)) {
        return lastSelectedProjectId;
    }
    return [...selectedProjects][selectedProjects.size - 1];
}

function getSelectedProjectIdsForPreview() {
    const knownIds = new Set(projects.map((p) => p.id));
    return [...selectedProjects].filter((id) => knownIds.has(id));
}

function buildProjectChildrenIndex() {
    const map = new Map();
    projects.forEach((project) => {
        const parentKey = project?.parent_id || null;
        const id = project?.id;
        if (!id) return;
        if (!map.has(parentKey)) {
            map.set(parentKey, []);
        }
        map.get(parentKey).push(id);
    });
    return map;
}

function collectDescendantProjectIds(seedIds) {
    const base = seedIds.filter(Boolean);
    const baseSet = new Set(base);
    const childMap = buildProjectChildrenIndex();
    const visited = new Set();
    const result = new Set();
    const stack = [...base];
    while (stack.length) {
        const currentId = stack.pop();
        if (!currentId || visited.has(currentId)) continue;
        visited.add(currentId);
        const children = childMap.get(currentId) || [];
        children.forEach((childId) => {
            if (!childId || visited.has(childId)) return;
            if (baseSet.has(childId)) {
                stack.push(childId);
                return;
            }
            if (result.has(childId)) return;
            result.add(childId);
            stack.push(childId);
        });
    }
    return result;
}

function getEffectivePreviewProjectIds(selectedIds = getSelectedProjectIdsForPreview()) {
    const scoped = new Set(selectedIds);
    if (!getProjectSettings().includeChildEntries) {
        return [...scoped];
    }
    const descendants = collectDescendantProjectIds([...scoped]);
    descendants.forEach((id) => scoped.add(id));
    return [...scoped];
}

async function ensureLinkedNotesForSelection(selectedIds, { force = false } = {}) {
    if (!Array.isArray(selectedIds) || selectedIds.length !== 1) return null;
    const projectId = selectedIds[0];
    const project = projectById(projectId);
    if (!project?.root_path) return null;
    try {
        return await ensureLinkedNotes(projectId, { force });
    } catch (error) {
        console.warn('Unable to load linked notes', error);
        return null;
    }
}

async function refreshLinkedNotesForCurrentSelection(force = false) {
    const selectedIds = getSelectedProjectIdsForPreview();
    const payload = await ensureLinkedNotesForSelection(selectedIds, { force });
    if (payload && currentPreviewMode === 'note') {
        renderPreviewContentForSelection(selectedIds);
    }
}

function updatePreviewSelection() {
    const selectedIds = getSelectedProjectIdsForPreview();
    if (getTimelineSelectionMode() === 'followMainSelection') {
        renderTimelineProjectOptions();
        refreshTimeline();
    }
    if (!isPreviewVisible()) {
        hideInlineProjectComposer({ restoreFocus: false });
        return;
    }
    const effectiveIds = getEffectivePreviewProjectIds(selectedIds);
    const prevIds = new Set(previousPreviewScopeIds);
    currentPreviewProjectId = getActivePreviewProjectId();
    syncInlineComposerForSelection(selectedIds);
    const settings = getProjectSettings();
    currentPreviewMode = settings.previewMode || currentPreviewMode;
    showArchivedTasks = !!settings.showArchivedTasks;
    applyProjectFilterAutoResets(prevIds, effectiveIds);
    previousPreviewScopeIds = new Set(effectiveIds);
    if (!selectedIds.length) {
        renderPreviewPlaceholder('Select a project', 'Choose a project to see its tasks and notes.');
        return;
    }
    Promise.all([ensurePreviewEntriesForProjects(effectiveIds), ensureLinkedNotesForSelection(selectedIds)]).then(() =>
        renderPreviewContentForSelection(selectedIds, effectiveIds),
    );
}

function syncColumnCheckboxes(columnPrefs, isDualMode) {
    if (!columnToggleInputs?.length) return;
    columnToggleInputs.forEach((input) => {
        const column = input.dataset.columnToggle;
        if (!column) return;
        const pref = columnPrefs?.[column];
        input.checked = !!pref;
        input.disabled = !isDualMode;
        input.closest('.form-check')?.classList.toggle('text-muted', !isDualMode);
    });
}

function setRowSelection(row, selected) {
    row.classList.toggle('table-active', selected);
    const checkbox = row.querySelector('.project-select');
    if (checkbox) {
        checkbox.checked = selected;
    }
}

function setProjectSelected(projectId, selected) {
    if (!projectId) return;
    if (selected) selectedProjects.add(projectId);
    else selectedProjects.delete(projectId);
}

function clearProjectSelection() {
    selectedProjects.clear();
    tableBody?.querySelectorAll('tr[data-project-id]').forEach((tr) => setRowSelection(tr, false));
    updateSelectAllCheckbox();
    hideContextMenu();
    updatePreviewSelection();
}

function updateSelectAllCheckbox() {
    if (!selectAllCheckbox) return;
    const total = Array.isArray(projects) ? projects.length : 0;
    const selectedCount = Array.from(selectedProjects).filter((id) => projects.find((p) => p.id === id)).length;
    if (!total) {
        selectedProjects.clear();
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
        return;
    }
    selectAllCheckbox.checked = selectedCount === total;
    selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < total;
}

function pruneSelectedProjects() {
    const ids = new Set(projects.map((p) => p.id));
    selectedProjects = new Set([...selectedProjects].filter((id) => ids.has(id)));
    updateSelectAllCheckbox();
}

function handleProjectRowClick(event) {
    const row = event.target.closest('tr[data-project-id]');
    if (!row) return;
    if (event.target.closest('[data-action]')) return;
    const projectId = row.dataset.projectId;
    if (!projectId) return;
    const checkbox = event.target.closest('.project-select');
    const isCtrl = event.ctrlKey || event.metaKey;

    if (checkbox) {
        const nextSelected = checkbox.checked;
        setProjectSelected(projectId, nextSelected);
        setRowSelection(row, nextSelected);
    } else {
        if (isCtrl) {
            const currentlySelected = selectedProjects.has(projectId);
            setProjectSelected(projectId, !currentlySelected);
            setRowSelection(row, !currentlySelected);
        } else {
            selectedProjects.clear();
            tableBody?.querySelectorAll('tr[data-project-id]').forEach((tr) => setRowSelection(tr, false));
            setProjectSelected(projectId, true);
            setRowSelection(row, true);
        }
    }
    if (selectedProjects.has(projectId)) {
        lastSelectedProjectId = projectId;
    }
    updateSelectAllCheckbox();
    updatePreviewSelection();
}

function updateColumnToggleLabel(showExtraColumns = null) {
    if (!columnsToggleButton) return;
    const label = 'Select Columns';
    columnsToggleButton.textContent = label;
    columnsToggleButton.title = 'Choose which columns to show';
}

function updateLayoutToggleState(placement = getAuxPlacement(), tab = getAuxTab()) {
    layoutPlacementOptions.forEach((option) => {
        option.checked = option.value === placement;
    });
    layoutContentOptions.forEach((option) => {
        option.checked = option.value === tab;
    });
    if (layoutToggleButton) {
        const label = 'Layout';
        layoutToggleButton.textContent = label;
        layoutToggleButton.setAttribute('aria-label', label);
    }
    auxTabButtons.forEach((button) => {
        const buttonTab = button.dataset.auxTab;
        const isActive = buttonTab === tab;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function getSplitterThickness(element, orientation = 'vertical') {
    if (!element) return 0;
    const rect = element.getBoundingClientRect();
    if (orientation === 'horizontal') {
        return Math.max(rect.height, 0);
    }
    return Math.max(rect.width, 0);
}

function getHorizontalMetrics() {
    if (!projectsTop) return null;
    const rect = projectsTop.getBoundingClientRect();
    const splitterWidth = getSplitterThickness(verticalSplitter, 'vertical');
    const available = Math.max(0, rect.width - splitterWidth);
    return { available, splitterWidth, containerWidth: rect.width };
}

function getVerticalMetrics() {
    if (!projectsLayout) return null;
    const rect = projectsLayout.getBoundingClientRect();
    const splitterHeight = getSplitterThickness(horizontalSplitter, 'horizontal');
    const available = Math.max(0, rect.height - splitterHeight);
    return { available, splitterHeight, totalHeight: rect.height };
}

function clampHorizontalSizes(desiredProjectsWidth, availableWidth) {
    const minProjects = MIN_PROJECTS_WIDTH;
    const minPreview = MIN_PREVIEW_WIDTH;
    const minTotal = minProjects + minPreview;
    const total = Math.max(availableWidth, minTotal);
    let projectsWidth = Math.min(Math.max(desiredProjectsWidth, minProjects), total - minPreview);
    let previewWidth = total - projectsWidth;
    if (previewWidth < minPreview) {
        previewWidth = minPreview;
        projectsWidth = total - previewWidth;
    }
    return { projects: Math.round(projectsWidth), preview: Math.round(previewWidth) };
}

function clampTimelineHeight(desiredHeight, availableHeight = null) {
    const metrics = availableHeight !== null ? { available: availableHeight } : getVerticalMetrics();
    const available = metrics?.available ?? desiredHeight;
    const minimumTotal = MIN_TOP_HEIGHT + MIN_TIMELINE_HEIGHT;
    const total = Math.max(available, minimumTotal);
    let timelineHeight = Math.min(Math.max(desiredHeight, MIN_TIMELINE_HEIGHT), total - MIN_TOP_HEIGHT);
    return Math.round(timelineHeight);
}

function persistPaneSizes(partial = {}) {
    const settings = getProjectSettings();
    settings.paneSizes = settings.paneSizes || {};
    settings.paneSizes = { ...settings.paneSizes, ...partial };
    persistPreferences();
}

function getTimelineLeftWidthPx() {
    const settings = getProjectSettings();
    const value = normalizePaneSize(settings.paneSizes?.timelineLeftWidthPx);
    return value || null;
}

function persistTimelineLeftWidthPx(widthPx) {
    const normalized = normalizePaneSize(widthPx);
    if (!normalized) return;
    persistPaneSizes({ timelineLeftWidthPx: normalized });
}

function applyPaneSizeStyles() {
    if (!projectsLayout) return;
    const settings = getProjectSettings();
    const sizes = settings.paneSizes || {};
    const showTop = shouldShowTop();
    const rightVisible = isAuxPlacementRight() && showTop;
    const bottomVisible = isAuxPlacementBottom() && showTop;
    const topMetrics = getHorizontalMetrics();
    if (rightVisible && topMetrics && topMetrics.available > 0 && (sizes.projectsWidthPx || sizes.tasksWidthPx)) {
        const total = (sizes.projectsWidthPx || 0) + (sizes.tasksWidthPx || 0);
        const desiredShare = total > 0 ? (sizes.projectsWidthPx || 0) / total : 0;
        const desiredLeft = total > 0 ? topMetrics.available * desiredShare : sizes.projectsWidthPx || topMetrics.available / 2;
        const clamped = clampHorizontalSizes(desiredLeft, topMetrics.available);
        projectsLayout.style.setProperty('--projects-pane-width', `${clamped.projects}px`);
        projectsLayout.style.setProperty('--projects-preview-width', `${clamped.preview}px`);
    } else {
        projectsLayout.style.removeProperty('--projects-pane-width');
        projectsLayout.style.removeProperty('--projects-preview-width');
    }
    if (bottomVisible && sizes.timelineHeightPx) {
        const metrics = getVerticalMetrics();
        const clampedHeight = clampTimelineHeight(sizes.timelineHeightPx, metrics?.available ?? null);
        projectsLayout.style.setProperty('--projects-timeline-height', `${clampedHeight}px`);
    } else {
        projectsLayout.style.removeProperty('--projects-timeline-height');
    }
}

function syncTimelineHeaderPlacement(rightVisible, timelineVisible) {
    const timelineInRight = rightVisible && timelineVisible;
    if (previewTitle) {
        previewTitle.textContent = timelineInRight ? 'Timeline' : previewTitleDefault;
    }
    if (!timelineHeaderControlsEl || !timelineHeaderHost || !timelineHeaderHome) {
        if (timelineHeaderHost) {
            timelineHeaderHost.classList.toggle('d-none', !timelineInRight);
        }
        return;
    }
    if (timelineInRight) {
        if (timelineHeaderControlsEl.parentElement !== timelineHeaderHost) {
            timelineHeaderHost.appendChild(timelineHeaderControlsEl);
        }
        timelineHeaderHost.classList.remove('d-none');
        return;
    }
    if (timelineHeaderControlsEl.parentElement !== timelineHeaderHome) {
        timelineHeaderHome.appendChild(timelineHeaderControlsEl);
    }
    timelineHeaderHost.classList.add('d-none');
}

function getBottomPanelElement() {
    if (!isAuxPlacementBottom()) return null;
    return isTimelineVisible() ? projectsTimeline : projectsPreview;
}

function applyProjectsLayout(layoutModeArg, columnPrefsArg, nestedArg) {
    const settings = getProjectSettings();
    const auxPlacement = normalizeAuxPlacement(settings.auxPlacement, 'right');
    const auxTab = normalizeAuxTab(settings.auxTab, 'tasks');
    settings.auxPlacement = auxPlacement;
    settings.auxTab = auxTab;
    settings.previewPane = auxPlacement !== 'hidden' && auxTab === 'tasks';
    const showTop = shouldShowTop();
    const auxVisible = auxPlacement !== 'hidden';
    const rightVisible = auxVisible && auxPlacement === 'right';
    const bottomVisible = auxVisible && auxPlacement === 'bottom';
    const bottomRowVisible = bottomVisible && showTop;
    const previewInBottom = bottomVisible && auxTab === 'tasks' && showTop;
    const previewVisible = (rightVisible && showTop) || previewInBottom;
    const timelineVisible = auxVisible && auxTab === 'timeline';
    const columnPrefs = columnPrefsArg || resolveColumnPreferences(settings, rightVisible);
    const nested = typeof nestedArg === 'boolean' ? nestedArg : Boolean(settings.nestedView);

    if (projectsLayout) {
        projectsLayout.dataset.layout = bottomRowVisible ? 'both' : 'single';
    }
    if (projectsTop) {
        projectsTop.classList.toggle('d-none', !showTop);
        projectsTop.dataset.columns = rightVisible && showTop ? 'dual' : 'single';
    }
    projectsPane?.classList.toggle('d-none', !showTop);
    if (projectsPreview) {
        if (previewInBottom && auxBottomHost) {
            if (projectsPreview.parentElement !== auxBottomHost) {
                auxBottomHost.appendChild(projectsPreview);
            }
        } else if (projectsTop && projectsPreview.parentElement !== projectsTop) {
            projectsTop.appendChild(projectsPreview);
        }
        projectsPreview.classList.toggle('d-none', !previewVisible);
        projectsPreview.classList.toggle(PREVIEW_AUX_TIMELINE_CLASS, rightVisible && timelineVisible);
    }
    if (auxRightHost) {
        auxRightHost.classList.toggle('d-none', !(rightVisible && timelineVisible));
    }
    if (projectsTimeline) {
        if (rightVisible && timelineVisible && auxRightHost) {
            if (projectsTimeline.parentElement !== auxRightHost) {
                auxRightHost.appendChild(projectsTimeline);
            }
        } else if (auxBottomHost) {
            if (projectsTimeline.parentElement !== auxBottomHost) {
                auxBottomHost.appendChild(projectsTimeline);
            }
        }
        projectsTimeline.classList.toggle('d-none', !timelineVisible);
        projectsTimeline.classList.toggle(TIMELINE_RIGHT_CLASS, rightVisible && timelineVisible);
    }
    syncTimelineHeaderPlacement(rightVisible, timelineVisible);
    if (verticalSplitter) {
        const showSplitter = rightVisible && showTop;
        verticalSplitter.classList.toggle('d-none', !showSplitter);
        verticalSplitter.setAttribute('aria-hidden', showSplitter ? 'false' : 'true');
    }
    if (horizontalSplitter) {
        const showHorizontal = bottomRowVisible;
        horizontalSplitter.classList.toggle('d-none', !showHorizontal);
        horizontalSplitter.setAttribute('aria-hidden', showHorizontal ? 'false' : 'true');
    }
    if (columnsToggleButton) {
        const disableColumns = !rightVisible;
        columnsToggleButton.disabled = disableColumns;
        columnsToggleButton.classList.toggle('d-none', disableColumns);
        columnsToggleGroup?.classList.toggle('d-none', disableColumns);
        updateColumnToggleLabel();
    }
    syncColumnCheckboxes(columnPrefs, rightVisible);
    toggleColumnVisibility(rightVisible, columnPrefs, nested);
    updateLayoutToggleState(auxPlacement, auxTab);
    applyPaneSizeStyles();
    if (timelineVisible) {
        ensureTimelineVisibleRender();
    } else {
        timelineNeedsRender = true;
    }
}

function setLayoutMode(mode) {
    const settings = getProjectSettings();
    const next = normalizeLayoutMode(mode, getLayoutMode());
    const legacyDefaults = resolveLegacyAuxSettings(next);
    if (
        settings.layoutMode === next &&
        settings.auxPlacement === legacyDefaults.auxPlacement &&
        settings.auxTab === legacyDefaults.auxTab
    ) {
        applyProjectsLayout();
        return;
    }
    settings.layoutMode = next;
    settings.auxPlacement = legacyDefaults.auxPlacement;
    settings.auxTab = legacyDefaults.auxTab;
    settings.previewPane = settings.auxPlacement !== 'hidden' && settings.auxTab === 'tasks';
    persistPreferences();
    renderProjects();
    if (settings.previewPane) {
        updatePreviewSelection();
    }
}

function setAuxPlacement(nextPlacement) {
    const settings = getProjectSettings();
    const placement = normalizeAuxPlacement(nextPlacement, settings.auxPlacement || 'right');
    if (placement === settings.auxPlacement) {
        applyProjectsLayout();
        return;
    }
    settings.auxPlacement = placement;
    settings.layoutMode = deriveLegacyLayoutMode(settings.auxPlacement, settings.auxTab);
    settings.previewPane = settings.auxPlacement !== 'hidden' && settings.auxTab === 'tasks';
    persistPreferences();
    renderProjects();
    if (settings.previewPane) {
        updatePreviewSelection();
    }
}

function setAuxTab(nextTab) {
    const settings = getProjectSettings();
    const tab = normalizeAuxTab(nextTab, settings.auxTab || 'tasks');
    if (tab === settings.auxTab) {
        applyProjectsLayout();
        return;
    }
    settings.auxTab = tab;
    settings.layoutMode = deriveLegacyLayoutMode(settings.auxPlacement, settings.auxTab);
    settings.previewPane = settings.auxPlacement !== 'hidden' && settings.auxTab === 'tasks';
    persistPreferences();
    renderProjects();
    if (settings.previewPane) {
        updatePreviewSelection();
    }
}

function handleVerticalSplitterPointerDown(event) {
    if (!isAuxPlacementRight() || !shouldShowTop()) return;
    if (!projectsPane || !projectsPreview || !projectsTop || !projectsLayout) return;
    const metrics = getHorizontalMetrics();
    if (!metrics || metrics.available <= 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startProjectsWidth = projectsPane.getBoundingClientRect().width;
    let latest = null;
    if (verticalSplitter.setPointerCapture) {
        verticalSplitter.setPointerCapture(event.pointerId);
    }
    const onMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        const desired = startProjectsWidth + delta;
        const clamped = clampHorizontalSizes(desired, metrics.available);
        projectsLayout.style.setProperty('--projects-pane-width', `${clamped.projects}px`);
        projectsLayout.style.setProperty('--projects-preview-width', `${clamped.preview}px`);
        latest = clamped;
    };
    const onUp = () => {
        if (verticalSplitter.releasePointerCapture && verticalSplitter.hasPointerCapture?.(event.pointerId)) {
            verticalSplitter.releasePointerCapture(event.pointerId);
        }
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        if (latest) {
            persistPaneSizes({ projectsWidthPx: latest.projects, tasksWidthPx: latest.preview });
        }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
}

function handleVerticalSplitterKeydown(event) {
    if (!isAuxPlacementRight() || !shouldShowTop()) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const metrics = getHorizontalMetrics();
    if (!metrics || metrics.available <= 0) return;
    event.preventDefault();
    const currentWidth = projectsPane?.getBoundingClientRect().width || metrics.available / 2;
    const delta = event.key === 'ArrowLeft' ? -KEYBOARD_RESIZE_STEP : KEYBOARD_RESIZE_STEP;
    const clamped = clampHorizontalSizes(currentWidth + delta, metrics.available);
    projectsLayout?.style.setProperty('--projects-pane-width', `${clamped.projects}px`);
    projectsLayout?.style.setProperty('--projects-preview-width', `${clamped.preview}px`);
    persistPaneSizes({ projectsWidthPx: clamped.projects, tasksWidthPx: clamped.preview });
}

function handleHorizontalSplitterPointerDown(event) {
    if (!isAuxPlacementBottom() || !shouldShowTop()) return;
    const bottomPanel = getBottomPanelElement();
    if (!bottomPanel || !projectsLayout) return;
    const metrics = getVerticalMetrics();
    if (!metrics || metrics.available <= 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startTimelineHeight = bottomPanel.getBoundingClientRect().height || metrics.available / 2;
    let latest = null;
    if (horizontalSplitter.setPointerCapture) {
        horizontalSplitter.setPointerCapture(event.pointerId);
    }
    const onMove = (moveEvent) => {
        const deltaY = moveEvent.clientY - startY;
        const desired = startTimelineHeight - deltaY;
        const clampedHeight = clampTimelineHeight(desired, metrics.available);
        projectsLayout.style.setProperty('--projects-timeline-height', `${clampedHeight}px`);
        latest = clampedHeight;
    };
    const onUp = () => {
        if (horizontalSplitter.releasePointerCapture && horizontalSplitter.hasPointerCapture?.(event.pointerId)) {
            horizontalSplitter.releasePointerCapture(event.pointerId);
        }
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        if (latest !== null) {
            persistPaneSizes({ timelineHeightPx: Math.round(latest) });
        }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
}

function handleHorizontalSplitterKeydown(event) {
    if (!isAuxPlacementBottom() || !shouldShowTop()) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const metrics = getVerticalMetrics();
    if (!metrics || metrics.available <= 0) return;
    event.preventDefault();
    const bottomPanel = getBottomPanelElement();
    const currentHeight = bottomPanel?.getBoundingClientRect().height || metrics.available / 2;
    const delta = event.key === 'ArrowUp' ? -KEYBOARD_RESIZE_STEP : KEYBOARD_RESIZE_STEP;
    const clamped = clampTimelineHeight(currentHeight + delta, metrics.available);
    projectsLayout?.style.setProperty('--projects-timeline-height', `${clamped}px`);
    persistPaneSizes({ timelineHeightPx: clamped });
}

function setupLayoutControls() {
    applyProjectsLayout();
    layoutPlacementOptions.forEach((option) => {
        option.addEventListener('change', () => {
            if (option.checked) {
                setAuxPlacement(option.value);
            }
        });
    });
    layoutContentOptions.forEach((option) => {
        option.addEventListener('change', () => {
            if (option.checked) {
                setAuxTab(option.value);
            }
        });
    });
    auxTabButtons.forEach((button) => {
        button.addEventListener('click', () => {
            const nextTab = button.dataset.auxTab;
            if (nextTab) {
                setAuxTab(nextTab);
            }
        });
    });
    verticalSplitter?.addEventListener('pointerdown', handleVerticalSplitterPointerDown);
    verticalSplitter?.addEventListener('keydown', handleVerticalSplitterKeydown);
    horizontalSplitter?.addEventListener('pointerdown', handleHorizontalSplitterPointerDown);
    horizontalSplitter?.addEventListener('keydown', handleHorizontalSplitterKeydown);
    window.addEventListener('resize', () => applyPaneSizeStyles());
}

function fillForm(project = null) {
    if (!form) return;
    modalError?.classList.add('d-none');
    modalError && (modalError.textContent = '');
    form.reset();
    editingId = project?.id || null;
    const selectedParentId = project?.parent_id || '';
    if (project) {
        nameInput.value = project.name || '';
        descriptionInput.value = project.description || '';
        rootInput.value = project.root_path || '';
        if (statusSelect) {
            statusSelect.value = normalizeStatus(project.status);
        }
        colorInput.value = project.color || '';
    } else {
        nameInput.value = '';
        descriptionInput.value = '';
        rootInput.value = '';
        if (statusSelect) {
            statusSelect.value = 'new';
        }
        colorInput.value = '';
    }
    const label = document.getElementById('project-modal-label');
    if (label) {
        label.textContent = project ? 'Edit Project' : 'New Project';
    }
    saveButton.textContent = project ? 'Save changes' : 'Create project';
    renderParentOptions(editingId);
    if (parentSelect) {
        parentSelect.value = selectedParentId;
    }
    resetTagImportControls({ excludeProjectId: editingId });
    bootstrapModal(modalElement)?.show();
    nameInput?.focus();
    if (!project) {
        maybeInheritParentColor();
    } else {
        updateColorSelection(colorInput.value || '');
    }
}

function serializeForm() {
    const payload = {
        name: nameInput?.value.trim() || '',
        description: descriptionInput?.value.trim() || '',
        root_path: rootInput?.value.trim() || '',
        parent_id: parentSelect?.value || null,
        status: normalizeStatus(statusSelect?.value),
        color: (colorInput?.value || '').trim(),
    };
    if (!payload.parent_id) {
        payload.parent_id = null;
    }
    if (!payload.root_path) {
        payload.root_path = null;
    }
    if (payload.color === null) {
        payload.color = '';
    }
    return payload;
}

function buildTagImportSuccessMessage(payload, sourceName) {
    const added = Number(payload?.added) || 0;
    const alreadyPresent = Number(payload?.already_present) || 0;
    const updatedParents = Number(payload?.updated_parents) || 0;
    const removed = Number(payload?.removed) || 0;
    const mode = String(payload?.mode || 'append').toLowerCase();
    const safeSource = sourceName || 'selected project';
    if (mode === 'replace') {
        const details = [`${added} imported`, `${removed} removed`];
        if (updatedParents > 0) {
            details.push(`${updatedParents} parent links restored`);
        }
        return `Imported tags from ${safeSource}: ${details.join(', ')}.`;
    }
    const details = [`${added} added`, `${alreadyPresent} already present`];
    if (updatedParents > 0) {
        details.push(`${updatedParents} parent links updated`);
    }
    return `Imported tags from ${safeSource}: ${details.join(', ')}.`;
}

async function runTagImportAfterSave(targetProjectId, selection) {
    if (!targetProjectId || !selection?.sourceProjectId) return;
    const sourceProject = projectById(selection.sourceProjectId);
    const sourceName = sourceProject?.name || 'selected project';
    if (selection.mode === 'replace') {
        const confirmed = await showConfirm(
            `Replace all tag definitions for this project root using tags from "${sourceName}"?`,
        );
        if (!confirmed) return;
    }
    try {
        const response = await requestJson(
            `/api/projects/${encodeURIComponent(targetProjectId)}/tags/import`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source_project_id: selection.sourceProjectId,
                    mode: selection.mode || 'append',
                }),
            },
        );
        showToast(buildTagImportSuccessMessage(response, sourceName));
    } catch (error) {
        showToast(`Project saved, but tag import failed: ${error?.message || 'Unable to import tags.'}`, true);
    }
}

async function saveProject(event) {
    event.preventDefault();
    modalError?.classList.add('d-none');
    if (!form.checkValidity()) {
        form.classList.add('was-validated');
        return;
    }
    form.classList.remove('was-validated');
    const isEditing = Boolean(editingId);
    const payload = serializeForm();
    const tagImportSelection = getTagImportSelection();
    saveButton.disabled = true;
    try {
        let targetProjectId = editingId;
        if (editingId) {
            const updated = await requestJson(`/api/projects/${encodeURIComponent(editingId)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            targetProjectId = updated?.id || editingId;
        } else {
            const created = await requestJson('/api/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            targetProjectId = created?.id || null;
        }
        bootstrapModal(modalElement)?.hide();
        showToast(isEditing ? 'Project updated' : 'Project created');
        if (payload.root_path && targetProjectId && tagImportSelection) {
            await runTagImportAfterSave(targetProjectId, tagImportSelection);
        }
        await loadProjects();
    } catch (error) {
        const message = error?.message || 'Unable to save project.';
        showToast(message, true);
    } finally {
        saveButton.disabled = false;
    }
}

async function deleteProject(projectId) {
    const confirmed = await showConfirm('Delete this project? Subprojects must be removed first.');
    if (!confirmed) return;
    try {
        await requestJson(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
        showToast('Project deleted');
        await loadProjects();
    } catch (error) {
        showToast(error?.message || 'Unable to delete project.', true);
    }
}

async function activateProject(projectId, { redirectUrl = '/workspace' } = {}) {
    try {
        await requestJson(`/api/projects/${encodeURIComponent(projectId)}/activate`, { method: 'POST' });
        window.location.href = redirectUrl;
    } catch (error) {
        showToast(error?.message || 'Unable to open project.', true);
    }
}

function buildLinkedNoteRevealSearch(path, isDir) {
    const normalized = normalizePath(path);
    if (!normalized) return '';
    const params = new URLSearchParams();
    if (isDir) {
        params.set('reveal_path', normalized);
    } else {
        params.set('select_path', normalized);
        params.set('preview', '1');
    }
    params.set('highlight', '1');
    const query = params.toString();
    return query ? `?${query}` : '';
}

async function openLinkedNoteInWorkspace(projectId, linkedNote) {
    if (!projectId) return;
    const project = projectById(projectId);
    if (!project?.root_path) {
        showToast('Set a root folder before opening this linked note.', true);
        return;
    }
    const path = linkedNote?.path || '.';
    const isDir = Boolean(linkedNote?.is_dir);
    const search = buildLinkedNoteRevealSearch(path, isDir);
    await activateProject(projectId, { redirectUrl: `/workspace${search}` });
}

async function handleTableClick(event) {
    const actionButton = event.target.closest('[data-action]');
    if (!actionButton) return;
    const row = actionButton.closest('tr');
    const projectId = row?.dataset?.projectId;
    if (!projectId) return;
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    const action = actionButton.dataset.action;
    if (action === 'edit') {
        fillForm(project);
    } else if (action === 'delete') {
        deleteProject(projectId);
    } else if (action === 'open') {
        if (!project.root_path) {
            showToast('Set a root folder before opening this project.', true);
            return;
        }
        activateProject(projectId);
    }
}

async function loadProjects() {
    try {
        const payload = await requestJson('/api/projects');
        projects = Array.isArray(payload?.projects) ? payload.projects : [];
        pruneSelectedProjects();
        renderProjects();
        renderTagImportSourceOptions({
            excludeProjectId: editingId,
            selectedSourceId: tagsImportSource?.value || '',
        });
        updateTagImportSectionVisibility();
        renderTimelineProjectOptions();
        refreshTimeline();
        updatePreviewSelection();
    } catch (error) {
        showToast(error?.message || 'Unable to load projects.', true);
    }
}

function setupBrowse() {
    if (!browseButton || !rootInput) return;
    browseButton.addEventListener('click', async () => {
        try {
            const initial = rootInput.value.trim() || '.';
            const selected = await openFolderPicker({ initialPath: initial, title: 'Choose project root', absolute: true, mode: 'system' });
            if (selected) {
                rootInput.value = selected;
                rootInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
        } catch (error) {
            showToast(error?.message || 'Folder picker unavailable.', true);
        }
    });
}

function setupNewButtons() {
    newButtons.forEach((button) => {
        if (!button) return;
        button.addEventListener('click', () => fillForm(null));
    });
}

function setupForm() {
    if (!form) return;
    form.addEventListener('submit', saveProject);
    rootInput?.addEventListener('input', () => updateTagImportSectionVisibility());
    modalElement?.addEventListener('hidden.bs.modal', () => {
        form.reset();
        modalError?.classList.add('d-none');
        editingId = null;
        updateColorSelection('');
        resetTagImportControls();
    });
}

function setupColumnSelector() {
    if (!columnToggleInputs?.length) return;
    columnToggleInputs.forEach((input) => {
        input.addEventListener('change', () => {
            const settings = getProjectSettings();
            const prefs = resolveColumnPreferences(settings, true);
            const column = input.dataset.columnToggle;
            if (column && Object.prototype.hasOwnProperty.call(prefs, column)) {
                prefs[column] = input.checked;
            }
            settings.showExtraColumns = prefs;
            persistPreferences();
            renderProjects();
        });
    });
}

function setupPreviewControls() {
    previewTabTasks?.addEventListener('click', () => {
        setPreviewMode('task');
        const ids = getSelectedProjectIdsForPreview();
        renderPreviewContentForSelection(ids);
    });
    previewTabNotes?.addEventListener('click', () => {
        setPreviewMode('note');
        const ids = getSelectedProjectIdsForPreview();
        ensureLinkedNotesForSelection(ids).then(() => renderPreviewContentForSelection(ids));
    });
    previewArchivedToggle?.addEventListener('change', () => {
        setShowArchived(previewArchivedToggle.checked);
    });
    previewFiltersToggleButton?.addEventListener('click', () => {
        filtersVisible = !filtersVisible;
        if (previewFiltersToggleButton) {
            previewFiltersToggleButton.classList.toggle('active', filtersVisible);
            previewFiltersToggleButton.setAttribute('aria-pressed', filtersVisible ? 'true' : 'false');
        }
        const ids = getSelectedProjectIdsForPreview();
        applyPreviewHeaderForSelection(ids);
        renderPreviewContentForSelection(ids);
    });
    previewNewButton?.addEventListener('click', (event) => {
        const projectId = getActivePreviewProjectId();
        const project = projectId ? projectById(projectId) : null;
        if (!project) return;
        routeProjectEntryCreate(project, currentPreviewMode, event.currentTarget);
    });
    setupPreviewFilters();
}

function setupInlineComposer() {
    if (!inlineComposer) return;
    inlineComposer.setAttribute('aria-hidden', 'true');
    inlineModeSelect?.addEventListener('change', () => {
        const mode = normalizeInlineEntryMode(inlineModeSelect.value);
        syncInlineComposerMode(mode);
        setPreviewMode(mode);
        clearInlineComposerError();
        focusInlineComposer();
    });
    inlineTitleInput?.addEventListener('input', clearInlineComposerError);
    inlineText?.addEventListener('input', clearInlineComposerError);
    inlineStart?.addEventListener('change', clearInlineComposerError);
    inlineEnd?.addEventListener('change', clearInlineComposerError);
    inlineCancelButton?.addEventListener('click', () => {
        hideInlineProjectComposer({ restoreFocus: true });
    });
    inlineComposerClose?.addEventListener('click', () => {
        hideInlineProjectComposer({ restoreFocus: true });
    });
    inlineComposer.addEventListener('submit', (event) => {
        void handleInlineComposerSubmit(event);
    });
    inlineComposer.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || inlineComposerSaving) return;
        event.preventDefault();
        hideInlineProjectComposer({ restoreFocus: true });
    });
}

function setupNotesSectionCollapsers() {
    if (!previewList) return;
    const toggleSection = (header) => {
        if (!header) return;
        const contentId = header.getAttribute('aria-controls');
        if (!contentId) return;
        const content = document.getElementById(contentId);
        if (!content) return;
        const expanded = header.getAttribute('aria-expanded') !== 'false';
        const nextExpanded = !expanded;
        header.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
        content.hidden = !nextExpanded;
    };
    previewList.addEventListener('click', (event) => {
        const header = event.target.closest('[data-notes-section-toggle]');
        if (!header || !previewList.contains(header)) return;
        event.preventDefault();
        toggleSection(header);
    });
    previewList.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const header = event.target.closest('[data-notes-section-toggle]');
        if (!header || !previewList.contains(header)) return;
        event.preventDefault();
        toggleSection(header);
    });
}

function handleHeaderAddNote() {
    const selectedIds = getSelectedProjectIdsForPreview();
    if (selectedIds.length !== 1) {
        const message = selectedIds.length ? 'Select a single project to add a note.' : 'Select a project to add a note.';
        showToast(message, true);
        return;
    }
    const project = projectById(selectedIds[0]);
    if (!project) return;
    routeProjectEntryCreate(project, 'note', document.getElementById('header-add-note-projects'));
}

function setupHeaderAddNote() {
    document.addEventListener('qualifile:projects-add-note', handleHeaderAddNote);
}

function handleBackgroundDeselect(event) {
    if (!projectsLayout) return;
    if (event.target.closest('.modal')) return;
    if (event.target.closest('.context-menu')) return;
    if (event.target.closest('[data-action]')) return;
    if (event.target.closest('.project-select')) return;
    if (event.target.closest('#projects-select-all')) return;
    if (event.target.closest('tr[data-project-id]')) return;
    if (event.target.closest('.projects-preview')) return;
    if (event.target.closest('.projects-preview-actions')) return;
    if (event.target.closest('.projects-preview-filters')) return;
    if (event.target.closest('#projects-layout-toggle')) return;
    if (event.target.closest('#projects-layout-menu')) return;
    if (event.target.closest('#projects-columns-toggle')) return;
    if (event.target.closest('.projects-splitter')) return;
    if (event.target.closest('#projects-timeline')) return;
    if (!projectsLayout.contains(event.target)) return;
    clearProjectSelection();
}

function setupPreviewFilters() {
    const rerender = () => {
        const ids = getSelectedProjectIdsForPreview();
        if (ids.length) {
            renderPreviewContentForSelection(ids);
        }
    };
    previewFiltersResetButton?.addEventListener('click', () => {
        if (currentPreviewMode === 'task') {
            resetTaskFilters();
            markTaskFiltersChanged();
        } else {
            resetNoteFilters();
        }
        rerender();
    });
    filterTaskPriority?.addEventListener('change', () => {
        taskFilters.priority = filterTaskPriority.value || '';
        markTaskFiltersChanged();
        rerender();
    });
    filterTaskStatus?.addEventListener('change', () => {
        taskFilters.status = filterTaskStatus.value || '';
        if ((taskFilters.status || '').toLowerCase() === 'closed') {
            setShowArchived(true);
        }
        markTaskFiltersChanged();
        rerender();
    });
    filterTaskProject?.addEventListener('change', () => {
        taskFilters.project = filterTaskProject.value || 'all';
        markTaskFiltersChanged();
        rerender();
    });
    filterTaskStartFrom?.addEventListener('change', () => {
        taskFilters.startFrom = filterTaskStartFrom.value || '';
        markTaskFiltersChanged();
        rerender();
    });
    filterTaskEndUntil?.addEventListener('change', () => {
        taskFilters.endUntil = filterTaskEndUntil.value || '';
        markTaskFiltersChanged();
        rerender();
    });
    filterTaskMinDuration?.addEventListener('input', () => {
        const raw = filterTaskMinDuration.value;
        const val = raw === '' ? '' : Number(raw);
        taskFilters.minDurationDays = raw === '' || !Number.isFinite(val) ? '' : val;
        markTaskFiltersChanged();
        rerender();
    });
    filterTaskMaxDuration?.addEventListener('input', () => {
        const raw = filterTaskMaxDuration.value;
        const val = raw === '' ? '' : Number(raw);
        taskFilters.maxDurationDays = raw === '' || !Number.isFinite(val) ? '' : val;
        markTaskFiltersChanged();
        rerender();
    });
    filterNotePriority?.addEventListener('change', () => {
        noteFilters.priority = filterNotePriority.value || '';
        rerender();
    });
    filterNoteProject?.addEventListener('change', () => {
        noteFilters.project = filterNoteProject.value || 'all';
        rerender();
    });
    filterNoteCreatedFrom?.addEventListener('change', () => {
        noteFilters.createdFrom = filterNoteCreatedFrom.value || '';
        rerender();
    });
    filterNoteCreatedUntil?.addEventListener('change', () => {
        noteFilters.createdUntil = filterNoteCreatedUntil.value || '';
        rerender();
    });
    syncTaskFilterControls();
    syncNoteFilterControls();
}

function setupNestedSync() {
    document.addEventListener('qualifile:projects-nested-view', (event) => {
        const enabled = Boolean(event?.detail?.enabled);
        const settings = getProjectSettings();
        settings.nestedView = enabled;
        persistPreferences();
        renderProjects();
    });
}

function setupPreviewSettingsSync() {
    document.addEventListener('qualifile:projects-note-lines', () => {
        if (currentPreviewProjectId && previewEntriesCache.has(currentPreviewProjectId)) {
            renderPreviewContent();
        }
    });
    document.addEventListener('qualifile:projects-compact-task-preview', () => {
        if (currentPreviewMode === 'task') {
            renderPreviewContent();
        }
    });
    document.addEventListener('qualifile:projects-inline-composer', (event) => {
        const enabled = Boolean(event?.detail?.enabled);
        const settings = getProjectSettings();
        settings.inlineComposerEnabled = enabled;
        persistPreferences();
        if (!enabled) {
            hideInlineProjectComposer({ restoreFocus: false });
        }
    });
    document.addEventListener('qualifile:projects-include-children', (event) => {
        const enabled = Boolean(event?.detail?.enabled);
        const settings = getProjectSettings();
        settings.includeChildEntries = enabled;
        persistPreferences();
        updatePreviewSelection();
    });
    document.addEventListener('qualifile:projects-color-style', () => {
        renderProjects();
    });
    document.addEventListener('qualifile:timeline-hierarchy-links', () => {
        refreshTimeline();
    });
    document.addEventListener('qualifile:projects-timeline-ui', () => {
        refreshTimeline();
    });
    document.addEventListener('qualifile:projects-task-hierarchy', (event) => {
        setTaskHierarchyEnabled(Boolean(event?.detail?.enabled));
    });
}

function resetEntryForm() {
    entryTitle.textContent = 'Create Note/Task';
    entryTitleInput?.closest('[data-field="title"]')?.classList.add('d-none');
    if (entryTitleInput) entryTitleInput.value = '';
    entryText.value = '';
    entryPriority.value = '';
    entryStatus.value = 'none';
    entryDeadline.value = '';
    entryStart.value = '';
    entryEnd.value = '';
    if (entryAutoRollupWrap) {
        entryAutoRollupWrap.classList.add('d-none');
    }
    if (entryAutoRollupDates) {
        entryAutoRollupDates.checked = false;
    }
    if (entryAutoRollupHelp) {
        entryAutoRollupHelp.textContent = '';
        entryAutoRollupHelp.classList.add('d-none');
    }
    entryStart?.removeAttribute('disabled');
    entryEnd?.removeAttribute('disabled');
    if (entryModalEl) {
        delete entryModalEl.dataset.manualStartIso;
        delete entryModalEl.dataset.manualEndIso;
    }
    reminderFormController.reset();
    entryColor.value = '';
    entryTitleInput?.classList.remove('is-invalid');
    setEntryParentProjectLock(false);
    if (entryParentProjectSelect) {
        populateParentProjectOptions(activeEntryProject?.id || projects[0]?.id || '');
    }
    if (entryParentTaskSelect) {
        entryParentTaskSelect.innerHTML = '';
        const none = new Option('No parent', '', true, true);
        entryParentTaskSelect.appendChild(none);
        entryParentTaskSelect.disabled = true;
    }
    if (linkedNoteToggle) {
        linkedNoteToggle.checked = false;
    }
    if (linkedNoteTargetFolder) {
        linkedNoteTargetFolder.checked = true;
    }
    if (linkedNoteTargetFile) {
        linkedNoteTargetFile.checked = false;
    }
    if (linkedNotePathInput) {
        linkedNotePathInput.value = '.';
    }
    linkedNotePathWrap?.classList.add('d-none');
    clearEntryAlert();
    clearDateHighlight();
}

function resolveLinkedNotePath() {
    const raw = linkedNotePathInput?.value?.trim() || '.';
    return normalizePath(raw) || '.';
}

function getLinkedNoteTargetType() {
    if (linkedNoteTargetFile?.checked) {
        return 'file';
    }
    return 'folder';
}

function updateLinkedNotePathHelp() {
    if (!linkedNotePathHelp) return;
    const targetType = getLinkedNoteTargetType();
    linkedNotePathHelp.textContent = targetType === 'file'
        ? 'Select a file under the project root.'
        : 'Select a folder under the project root ("." for root).';
}

function normalizeAbsolutePath(value) {
    const text = String(value || '').trim().replace(/\\/g, '/');
    return text.replace(/\/+$/, '');
}

function normalizeRootKey(value) {
    if (!value) return '';
    const isWindows = /^[A-Za-z]:/.test(value) || value.startsWith('//');
    return isWindows ? value.toLowerCase() : value;
}

function relativePathFromRoot(rootPath, absolutePath) {
    const rootNormalized = normalizeAbsolutePath(rootPath);
    const targetNormalized = normalizeAbsolutePath(absolutePath);
    if (!rootNormalized || !targetNormalized) return null;
    const rootKey = normalizeRootKey(rootNormalized);
    const targetKey = normalizeRootKey(targetNormalized);
    if (targetKey === rootKey) return '.';
    const prefix = `${rootKey}/`;
    if (!targetKey.startsWith(prefix)) return null;
    return targetNormalized.slice(rootNormalized.length + 1) || '.';
}

function joinRootPath(rootPath, relativePath) {
    const rootNormalized = normalizeAbsolutePath(rootPath);
    if (!rootNormalized) return '';
    const rel = String(relativePath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel === '.') return rootNormalized;
    return `${rootNormalized}/${rel}`;
}

function syncLinkedNoteControls(mode = entryModeSelect?.value || 'note') {
    if (!linkedNoteToggleWrap || !linkedNoteToggle || !linkedNotePathWrap || !linkedNotePathInput) return;
    const isNoteMode = mode === 'note';
    const isEdit = Boolean(activeEntryId);
    const hasRoot = Boolean(activeEntryProject?.root_path);
    linkedNoteToggleWrap.classList.toggle('d-none', !isNoteMode || isEdit);
    linkedNoteToggle.disabled = !hasRoot;
    if (!isNoteMode || isEdit || !hasRoot) {
        linkedNoteToggle.checked = false;
    }
    const linkedEnabled = linkedNoteToggle.checked && isNoteMode && !isEdit && hasRoot;
    linkedNotePathWrap.classList.toggle('d-none', !linkedEnabled);
    linkedNotePathInput.disabled = !linkedEnabled;
    if (linkedNoteTargetFolder) {
        linkedNoteTargetFolder.disabled = !linkedEnabled;
    }
    if (linkedNoteTargetFile) {
        linkedNoteTargetFile.disabled = !linkedEnabled;
    }
    if (linkedNoteBrowseButton) {
        linkedNoteBrowseButton.disabled = !linkedEnabled;
    }
    if (linkedEnabled && linkedNoteTargetFolder && linkedNoteTargetFile) {
        if (!linkedNoteTargetFolder.checked && !linkedNoteTargetFile.checked) {
            linkedNoteTargetFolder.checked = true;
        }
    }
    if (linkedEnabled && !linkedNotePathInput.value) {
        linkedNotePathInput.value = '.';
    }
    updateLinkedNotePathHelp();
    if (linkedNoteHelp) {
        linkedNoteHelp.textContent = hasRoot
            ? 'Creates a workspace note under the project root.'
            : 'Set a root folder to enable linked notes.';
    }
}

async function handleLinkedNoteBrowse() {
    if (!linkedNotePathInput || !activeEntryProject) return;
    const rootPath = activeEntryProject.root_path || '';
    if (!rootPath) {
        showEntryAlert('Set a root folder before browsing.', true);
        return;
    }
    const targetType = getLinkedNoteTargetType();
    try {
        if (targetType === 'file') {
            const selected = await openProjectFilePicker({
                projectId: activeEntryProject.id,
                initialPath: resolveLinkedNotePath(),
                title: 'Select file',
            });
            if (selected) {
                linkedNotePathInput.value = selected;
            }
            return;
        }
        const initialAbsolute = joinRootPath(rootPath, resolveLinkedNotePath());
        const selected = await openFolderPicker({
            initialPath: initialAbsolute || rootPath,
            title: 'Select folder',
            absolute: true,
            mode: 'system',
        });
        if (!selected) return;
        const relative = relativePathFromRoot(rootPath, selected);
        if (!relative) {
            showEntryAlert('Select a folder inside the project root.', true);
            return;
        }
        linkedNotePathInput.value = relative;
    } catch (error) {
        showEntryAlert(error?.message || 'Unable to browse.', true);
    }
}

function setEntryModeOptions(project) {
    if (!entryModeSelect) return;
    const mode = (project?.entry_mode || 'both').toLowerCase();
    entryModeSelect.innerHTML = '';
    ['note', 'task'].forEach((value) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value === 'task' ? 'Task' : 'Note';
        entryModeSelect.appendChild(option);
    });
    entryModeSelect.disabled = false;
    entryModeSelect.value = mode === 'task' ? 'task' : 'note';
    toggleEntryFields(entryModeSelect.value);
    syncLinkedNoteControls(entryModeSelect.value);
}

function toggleEntryFields(mode) {
    const isTask = mode === 'task';
    if (entryDeadline) {
        entryDeadline.closest('[data-field="deadline"]')?.classList.toggle('d-none', true);
    }
    entryTitleInput?.closest('[data-field="title"]')?.classList.toggle('d-none', !isTask);
    entryParentProjectSelect?.closest('[data-field="parent"]')?.classList.toggle('d-none', !isTask);
    if (entryStart) {
        entryStart.closest('[data-field="start"]')?.classList.toggle('d-none', !isTask);
    }
    if (entryEnd) {
        entryEnd.closest('[data-field="end"]')?.classList.toggle('d-none', !isTask);
    }
    if (!isTask && entryAutoRollupWrap) {
        entryAutoRollupWrap.classList.add('d-none');
    }
    entryStatus?.closest('.col-md-4')?.classList.toggle('d-none', !isTask);
    reminderFormController.syncMode(mode);
    if (entryText) {
        if (isTask) {
            entryText.rows = 3;
            entryText.classList.remove('project-entry-text-tall');
        } else {
            entryText.rows = 8;
            entryText.classList.add('project-entry-text-tall');
        }
    }
}

function taskOptionLabel(task) {
    const base = (task.title || '').trim() || (task.text || '').trim() || '(Untitled task)';
    const parts = [];
    const status = (task.status || '').toLowerCase();
    if (status && status !== 'none') parts.push(status.replace('_', ' '));
    const priority = (task.priority || '').toLowerCase();
    if (priority) parts.push(priority);
    return parts.length ? `${base} — ${parts.join(' · ')}` : base;
}

function resolveTaskSummary(projectId, taskId) {
    if (!projectId || !taskId) return null;
    const cached = previewEntriesCache.get(projectId);
    const task = cached?.tasks?.find((t) => t.id === taskId);
    if (!task) return null;
    const project = projectById(projectId);
    const label = taskOptionLabel(task);
    return project ? `${project.name || project.id}: ${label}` : label;
}

function resolveParentProjectLabel(projectId) {
    if (!projectId) return '';
    const project = projectById(projectId);
    return project?.name || projectId;
}

function syncEntryParentProjectReadonly() {
    if (!entryParentProjectReadonlyInput) return;
    const projectId = entryParentProjectSelect?.value || activeEntryProject?.id || '';
    entryParentProjectReadonlyInput.value = resolveParentProjectLabel(projectId);
}

function setEntryParentProjectLock(isLocked) {
    entryParentProjectSelectWrap?.classList.toggle('d-none', isLocked);
    entryParentProjectReadonlyWrap?.classList.toggle('d-none', !isLocked);
    if (entryParentProjectSelect) {
        entryParentProjectSelect.disabled = !!isLocked;
    }
    if (isLocked) {
        syncEntryParentProjectReadonly();
    }
}

function populateParentProjectOptions(defaultProjectId = null) {
    if (!entryParentProjectSelect) return;
    entryParentProjectSelect.innerHTML = '';
    const sortedProjects = [...projects].sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
    sortedProjects.forEach((proj) => {
        const option = new Option(proj.name || proj.id, proj.id, false, false);
        entryParentProjectSelect.appendChild(option);
    });
    const target = defaultProjectId || activeEntryProject?.id || sortedProjects[0]?.id || '';
    entryParentProjectSelect.value = target;
    syncEntryParentProjectReadonly();
}

async function populateParentTaskOptions(projectId, currentTaskId = null, selectedParentId = null) {
    if (!entryParentTaskSelect) return;
    entryParentTaskSelect.innerHTML = '';
    const none = new Option('No parent', '', true, false);
    entryParentTaskSelect.appendChild(none);
    entryParentTaskSelect.disabled = true;
    if (!projectId) {
        entryParentTaskSelect.value = '';
        entryParentTaskSelect.disabled = false;
        return;
    }
    try {
        await ensurePreviewEntriesForProjects([projectId]);
        const cached = previewEntriesCache.get(projectId);
        const tasks = cached?.tasks || [];
        tasks.forEach((task) => {
            if (task.id === currentTaskId) return;
            const option = new Option(taskOptionLabel(task), task.id, false, task.id === selectedParentId);
            entryParentTaskSelect.appendChild(option);
        });
        const hasSelection = [...entryParentTaskSelect.options].some((opt) => opt.value === selectedParentId);
        entryParentTaskSelect.value = hasSelection ? selectedParentId || '' : '';
    } catch (error) {
        console.warn('Unable to load parent tasks', error);
        entryParentTaskSelect.value = '';
    } finally {
        entryParentTaskSelect.disabled = false;
    }
}

function showEntryAlert(message, isError = false) {
    if (!entryAlert) return;
    if (entryAlertText) {
        entryAlertText.textContent = message || '';
    } else {
        entryAlert.textContent = message || '';
    }
    entryAlert.classList.toggle('d-none', !message);
    entryAlert.classList.toggle('alert-danger', isError);
    entryAlert.classList.toggle('alert-success', !isError && Boolean(message));
}

function clearEntryAlert() {
    if (!entryAlert) return;
    if (entryAlertText) {
        entryAlertText.textContent = '';
    } else {
        entryAlert.textContent = '';
    }
    entryAlert.classList.add('d-none');
    entryAlert.classList.remove('alert-danger', 'alert-success');
}

function clearDateHighlight() {
    entryStart?.classList.remove('is-invalid');
    entryEnd?.classList.remove('is-invalid');
}

async function syncParentTaskSelectors(entry = null) {
    if (!entryParentProjectSelect || !entryParentTaskSelect) return;
    const isTaskMode = (entryModeSelect?.value || 'task') === 'task';
    const defaultProjectId = entry?.parent_project_id || activeEntryProject?.id || projects[0]?.id || '';
    populateParentProjectOptions(defaultProjectId);
    if (!isTaskMode) {
        entryParentTaskSelect.innerHTML = '';
        const none = new Option('No parent', '', true, true);
        entryParentTaskSelect.appendChild(none);
        entryParentTaskSelect.disabled = true;
        return;
    }
    entryParentTaskSelect.disabled = false;
    await populateParentTaskOptions(defaultProjectId, entry?.id || null, entry?.parent_task_id || null);
}

function setupEntryModal() {
    if (!entryModalEl || !entryForm) return;
    const modal = bootstrapModal(entryModalEl);
    reminderFormController.attach();
    entryTitleInput?.addEventListener('input', () => {
        entryTitleInput.classList.remove('is-invalid');
        clearEntryAlert();
    });
    entryModeSelect?.addEventListener('change', () => {
        toggleEntryFields(entryModeSelect.value);
        syncLinkedNoteControls(entryModeSelect.value);
        const entryContext =
            entryModeSelect.value === 'task' && activeEntryId
                ? {
                      id: activeEntryId,
                      parent_project_id: entryParentProjectSelect?.value || activeEntryProject?.id || null,
                      parent_task_id: entryParentTaskSelect?.value || null,
                  }
                : null;
        void syncParentTaskSelectors(entryContext);
    });
    linkedNoteToggle?.addEventListener('change', () => {
        syncLinkedNoteControls(entryModeSelect?.value || 'note');
    });
    linkedNoteTargetFolder?.addEventListener('change', () => {
        updateLinkedNotePathHelp();
    });
    linkedNoteTargetFile?.addEventListener('change', () => {
        updateLinkedNotePathHelp();
    });
    linkedNoteBrowseButton?.addEventListener('click', () => {
        void handleLinkedNoteBrowse();
    });
    const validateDates = () => {
        if (!entryStart || !entryEnd) return true;
        const startValue = entryStart.value ? new Date(entryStart.value) : null;
        const endValue = entryEnd.value ? new Date(entryEnd.value) : null;
        clearDateHighlight();
        if (startValue && endValue && endValue < startValue) {
            showEntryAlert('End date cannot be earlier than start date.', true);
            entryEnd?.classList.add('is-invalid');
            entryStart?.classList.add('is-invalid');
            return false;
        }
        clearEntryAlert();
        return true;
    };
    entryStart?.addEventListener('change', validateDates);
    entryEnd?.addEventListener('change', validateDates);
    entryAutoRollupDates?.addEventListener('change', () => {
        if (!entryAutoRollupWrap || entryAutoRollupWrap.classList.contains('d-none')) return;
        if (!activeEntryProject || !activeEntryId) return;
        if (entryAutoRollupDates.checked) {
            storeManualEntryDates();
        }
        const { ranges, cycleKeys } = computeEffectiveTaskRanges(collectCachedTaskItems());
        const key = taskNodeKey(activeEntryProject.id, activeEntryId);
        const effectiveRange = ranges.get(key);
        const isCycle = cycleKeys.has(key) || effectiveRange?.source === 'cycle';
        applyEntryAutoRollupState(entryAutoRollupDates.checked, effectiveRange, isCycle);
    });
    entryParentProjectSelect?.addEventListener('change', () => {
        const targetProject = entryParentProjectSelect.value || activeEntryProject?.id || '';
        void populateParentTaskOptions(targetProject, activeEntryId, null);
        syncEntryParentProjectReadonly();
    });
    entryForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!activeEntryProject) return;
        const mode = entryModeSelect?.value || (activeEntryProject.entry_mode || 'note');
        const text = entryText?.value?.trim() || '';
        let reminderPayload = null;
        let reminderNotice = null;
        if (mode === 'task') {
            const title = entryTitleInput?.value?.trim() || '';
            if (!title) {
                showEntryAlert('Title is required for tasks.', true);
                entryTitleInput?.classList.add('is-invalid');
                return;
            }
            if (title.length > 200) {
                showEntryAlert('Task title must be 200 characters or fewer.', true);
                return;
            }
            if (title) {
                entryTitle.textContent = 'Edit Task';
            }
            if (!validateDates()) {
                return;
            }
            entryTitleInput?.classList.remove('is-invalid');
            const reminderResult = reminderFormController.buildPayload({ entryMode: mode });
            if (!reminderResult.ok) {
                showEntryAlert(reminderResult.error || 'Invalid reminder settings.', true);
                return;
            }
            reminderPayload = reminderResult.payload;
            reminderNotice = reminderResult.notice || null;
        }
        if (mode === 'note' && !text) {
            showEntryAlert('Description is required.', true);
            return;
        }
        const isLinkedNote = mode === 'note' && !activeEntryId && linkedNoteToggle?.checked;
        clearEntryAlert();
        if (isLinkedNote) {
            const linkedPath = resolveLinkedNotePath();
            const targetType = getLinkedNoteTargetType();
            if (targetType === 'file' && (linkedPath === '.' || !linkedPath)) {
                showEntryAlert('Select a file to link.', true);
                return;
            }
            try {
                showEntryAlert('', false);
                await createLinkedNote(activeEntryProject.id, {
                    path: linkedPath,
                    text,
                    priority: entryPriority?.value || null,
                    color: entryColor?.value || null,
                });
                showEntryAlert('Saved.', false);
                await refreshLinkedNotesForCurrentSelection(true);
                setTimeout(() => {
                    modal?.hide();
                }, 400);
            } catch (error) {
                showEntryAlert(error?.message || 'Unable to save entry.', true);
            }
            return;
        }
        const payload = {
            type: mode,
            text,
            priority: entryPriority?.value || null,
            color: entryColor?.value || null,
        };
        if (mode === 'task') {
            payload.status = entryStatus?.value || 'none';
            payload.title = entryTitleInput?.value?.trim() || '';
            const autoRollupSupported =
                entryAutoRollupWrap && !entryAutoRollupWrap.classList.contains('d-none');
            const autoRollupEnabled = autoRollupSupported && entryAutoRollupDates?.checked;
            if (autoRollupSupported) {
                payload.auto_rollup_dates = !!autoRollupEnabled;
            }
            if (!autoRollupEnabled) {
                payload.start_date = entryStart?.value || null;
                payload.end_date = entryEnd?.value || null;
            }
            payload.reminder_enabled = reminderPayload?.reminder_enabled ?? false;
            payload.reminder_mode = reminderPayload?.reminder_mode ?? 'on_end_date';
            payload.reminder_days_before = reminderPayload?.reminder_days_before ?? null;
            const parentProject = entryParentProjectSelect?.value || '';
            const parentTask = entryParentTaskSelect?.value || '';
            if (parentTask) {
                payload.parent_project_id = parentProject || activeEntryProject.id;
                payload.parent_task_id = parentTask;
            } else {
                payload.parent_project_id = null;
                payload.parent_task_id = null;
            }
        } else {
            // Notes no longer support status/deadline
            payload.status = undefined;
            payload.deadline = undefined;
            payload.parent_project_id = null;
            payload.parent_task_id = null;
        }
        const persistEntry = async (candidatePayload) => {
            if (activeEntryId) {
                await updateProjectEntry(activeEntryProject.id, activeEntryId, candidatePayload);
            } else {
                await createProjectEntry(activeEntryProject.id, candidatePayload);
            }
        };
        try {
            showEntryAlert('', false);
            try {
                await persistEntry(payload);
            } catch (error) {
                if (mode === 'task' && activeEntryId && isDisableChoiceRequiredError(error)) {
                    const disableChoice = await chooseDisableActiveAlertAction({ confirmFn: showConfirm });
                    await persistEntry({
                        ...payload,
                        disable_active_alert_action: disableChoice,
                    });
                } else {
                    throw error;
                }
            }
            const savedMessage = reminderNotice ? `Saved. ${reminderNotice}` : 'Saved.';
            showEntryAlert(savedMessage, false);
            updatePreviewAfterSave();
            setTimeout(() => {
                modal?.hide();
            }, 400);
        } catch (error) {
            showEntryAlert(error?.message || 'Unable to save entry.', true);
        }
    });
        entryModalEl.addEventListener('hidden.bs.modal', () => {
            activeEntryId = null;
            activeEntryProject = null;
            resetEntryForm();
        });
    entryAlertDismiss?.addEventListener('click', () => {
        clearEntryAlert();
        clearDateHighlight();
    });
}

function setupTaskViewModal() {
    taskViewCopy?.addEventListener('click', () => {
        const text = taskViewDescription?.textContent || '';
        void copyToClipboard(text);
    });
}

function showConfirm(message) {
    const modalElement = document.getElementById('modal-confirm');
    if (!modalElement) {
        return Promise.resolve(window.confirm(message));
    }
    const label = modalElement.querySelector('#modal-confirm-label');
    const body = modalElement.querySelector('#modal-confirm-message');
    const ok = modalElement.querySelector('#modal-confirm-ok');
    if (label) label.textContent = 'Confirm';
    if (body) body.textContent = message;
    return new Promise((resolve) => {
        const instance = bootstrapModal(modalElement);
        const cleanup = () => {
            ok?.removeEventListener('click', onOk);
            modalElement.removeEventListener('hidden.bs.modal', onHide);
        };
        const onOk = () => {
            cleanup();
            resolve(true);
            instance?.hide();
        };
        const onHide = () => {
            cleanup();
            resolve(false);
        };
        ok?.addEventListener('click', onOk, { once: true });
        modalElement.addEventListener('hidden.bs.modal', onHide, { once: true });
        instance?.show();
    });
}

function setupContextMenu() {
    if (contextMenu) return;
    contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';
    contextMenu.style.left = '-9999px';
    contextMenu.style.top = '-9999px';
    contextMenu.setAttribute('aria-hidden', 'true');
    contextMenu.addEventListener('contextmenu', (event) => event.preventDefault());

    contextMenuList = document.createElement('ul');
    contextMenuList.className = 'context-menu-list';
    contextMenuList.setAttribute('role', 'menu');
    contextMenu.appendChild(contextMenuList);

    document.body.appendChild(contextMenu);

    document.addEventListener('contextmenu', handleContextMenuEvent);
    document.addEventListener('pointerdown', handleGlobalPointer, { capture: true });
    document.addEventListener('keydown', handleGlobalKeydown, true);
    window.addEventListener('resize', hideContextMenu);
    window.addEventListener('scroll', hideContextMenu, true);
}

function handleContextMenuEvent(event) {
    if (event.target.closest('input, textarea, select, button, [contenteditable="true"]')) return;
    if (document.querySelector('.modal.show')?.contains(event.target)) return;
    if (contextMenu?.contains(event.target)) return;
    const card = event.target.closest('.projects-preview-card');
    if (card) {
        const projectId = card.dataset.projectId;
        if (card.dataset.linkedNote === '1') {
            event.preventDefault();
            hideContextMenu();
            if (!projectId) return;
            const path = card.dataset.path || '.';
            const isDir = card.dataset.isDir === '1';
            const items = buildLinkedNoteContextMenu(projectId, { path, is_dir: isDir });
            if (items && items.length) {
                renderContextMenu(items);
                positionContextMenu(event.clientX, event.clientY);
            }
            return;
        }
        const entryId = card.dataset.entryId;
        const entryType = card.dataset.entryType;
        if (projectId && entryId && entryType) {
            event.preventDefault();
            hideContextMenu();
            let items = [];
            if (entryType === 'task') {
                const task = getCachedTask(projectId, entryId);
                items = buildTaskContextMenu(projectId, task);
            } else if (entryType === 'note') {
                const note = getCachedNote(projectId, entryId);
                items = buildNoteContextMenu(projectId, note);
            }
            if (items && items.length) {
                renderContextMenu(items);
                positionContextMenu(event.clientX, event.clientY);
            }
        }
        return;
    }
    const table = document.getElementById('projects-table');
    if (!table || !table.contains(event.target)) return;
    event.preventDefault();
    hideContextMenu();
    const row = event.target.closest('tr[data-project-id]');
    const projectId = row?.dataset?.projectId;
    const project = projectId ? projects.find((p) => p.id === projectId) : null;
    const items = project ? buildProjectRowMenu(project) : buildEmptySpaceMenu();
    if (!items.length) return;
    renderContextMenu(items);
    positionContextMenu(event.clientX, event.clientY);
}

function handleGlobalPointer(event) {
    if (!contextMenu?.classList.contains('visible')) return;
    if (contextMenu.contains(event.target)) return;
    hideContextMenu();
}

function handleGlobalKeydown(event) {
    if (event.key === 'Escape') {
        hideContextMenu();
    }
}

function renderContextMenu(items) {
    if (!contextMenu || !contextMenuList) return;
    contextMenuList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
        if (item === 'divider') {
            const divider = document.createElement('li');
            divider.className = 'context-menu-divider';
            divider.setAttribute('role', 'separator');
            fragment.appendChild(divider);
            return;
        }
        const entry = document.createElement('li');
        entry.className = 'context-menu-entry';
        entry.setAttribute('role', 'none');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'context-menu-item';
        button.textContent = item.label;
        button.setAttribute('role', 'menuitem');
        if (item.disabled) {
            button.disabled = true;
            button.setAttribute('aria-disabled', 'true');
        }
        if (item.danger) {
            button.classList.add('danger');
        }
        button.addEventListener('click', async (clickEvent) => {
            clickEvent.preventDefault();
            clickEvent.stopPropagation();
            hideContextMenu();
            if (typeof item.action === 'function' && !item.disabled) {
                await item.action();
            }
        });
        entry.appendChild(button);
        fragment.appendChild(entry);
    });
    contextMenuList.appendChild(fragment);
}

function positionContextMenu(x, y) {
    if (!contextMenu) return;
    contextMenu.classList.remove('visible');
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
    contextMenu.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
        if (!contextMenu) return;
        contextMenu.classList.add('visible');
        const rect = contextMenu.getBoundingClientRect();
        let left = x;
        let top = y;
        if (rect.right > window.innerWidth) {
            left = Math.max(8, window.innerWidth - rect.width - 8);
        }
        if (rect.bottom > window.innerHeight) {
            top = Math.max(8, window.innerHeight - rect.height - 8);
        }
        contextMenu.style.left = `${left}px`;
        contextMenu.style.top = `${top}px`;
    });
}

function hideContextMenu() {
    if (!contextMenu) return;
    contextMenu.classList.remove('visible');
    contextMenu.style.left = '-9999px';
    contextMenu.style.top = '-9999px';
    contextMenu.setAttribute('aria-hidden', 'true');
}

function buildEmptySpaceMenu() {
    const nestedEnabled = Boolean(state.settings?.projects?.nestedView);
    return [
        {
            label: 'Create New Project',
            action: () => fillForm(null),
        },
        {
            label: nestedEnabled ? 'Disable Nested View' : 'Enable Nested View',
            action: () => toggleNestedView(!nestedEnabled),
        },
        'divider',
        {
            label: 'Refresh Projects',
            action: () => loadProjects(),
        },
    ];
}

function buildProjectRowMenu(project) {
    const items = [];
    const hasRoot = Boolean(project.root_path);
    items.push({
        label: 'Open in Workspace',
        disabled: !hasRoot,
        action: () => openProject(project),
    });
    items.push({
        label: 'Edit Project',
        action: () => fillForm(project),
    });
    items.push({
        label: 'Add Task',
        action: () => routeProjectEntryCreate(project, 'task'),
    });
    items.push({
        label: 'Add Note',
        action: () => routeProjectEntryCreate(project, 'note'),
    });
    if (hasRoot) {
        items.push({
            label: 'Copy Root Path',
            action: () => copyRootPath(project.root_path),
        });
    }
    items.push({
        label: 'Manage Tasks / Notes',
        action: () => manageProjectEntries(project),
    });
    items.push('divider');
    items.push({
        label: 'Delete Project',
        danger: true,
        action: () => deleteProject(project.id),
    });
    return items;
}

async function duplicateTask(projectId, task) {
    if (!projectId || !task) return;
    const payload = {
        type: 'task',
        text: task.text || '',
        title: task.title || '',
        priority: task.priority || '',
        status: task.status || 'none',
        start_date: task.start_date || null,
        end_date: task.end_date || null,
        reminder_enabled: !!task.reminder_enabled,
        reminder_mode: task.reminder_mode || 'on_end_date',
        reminder_days_before: task.reminder_days_before ?? null,
        color: task.color || '',
    };
    await createProjectEntry(projectId, payload);
}

async function duplicateNote(projectId, note) {
    if (!projectId || !note) return;
    const payload = {
        type: 'note',
        text: note.text || '',
        priority: note.priority || '',
        color: note.color || '',
    };
    await createProjectEntry(projectId, payload);
}

async function copyToClipboard(text) {
    if (!text) return;
    try {
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const temp = document.createElement('textarea');
            temp.value = text;
            document.body.appendChild(temp);
            temp.select();
            document.execCommand('copy');
            document.body.removeChild(temp);
        }
        showToast('Copied to clipboard');
    } catch (error) {
        showToast('Unable to copy', true);
    }
}

function ensureFiltersVisible() {
    if (!filtersVisible) {
        filtersVisible = true;
    }
}

function ensureValidProjectFilterForMode(effectiveIds = null) {
    const selectedIds = getSelectedProjectIdsForPreview();
    const scopedIds = effectiveIds && effectiveIds.length ? effectiveIds : getEffectivePreviewProjectIds(selectedIds);
    const validIds = new Set(scopedIds);
    if (currentPreviewMode === 'task') {
        if (taskFilters.project !== 'all' && !validIds.has(taskFilters.project)) {
            taskFilters.project = 'all';
        }
        syncTaskFilterControls();
    } else {
        if (noteFilters.project !== 'all' && !validIds.has(noteFilters.project)) {
            noteFilters.project = 'all';
        }
        syncNoteFilterControls();
    }
}

function applyProjectFilterAutoResets(prevIds, newIds) {
    const current = new Set((newIds || []).filter(Boolean));
    if (currentPreviewMode === 'task') {
        if (taskFilters.project !== 'all' && !current.has(taskFilters.project)) {
            taskFilters.project = 'all';
            syncTaskFilterControls();
        }
        return;
    }
    if (noteFilters.project !== 'all' && !current.has(noteFilters.project)) {
        noteFilters.project = 'all';
        syncNoteFilterControls();
    }
}

function syncTaskFilterControls() {
    if (filterTaskProject) filterTaskProject.value = taskFilters.project ?? 'all';
    if (filterTaskPriority) filterTaskPriority.value = taskFilters.priority ?? '';
    if (filterTaskStatus) filterTaskStatus.value = taskFilters.status ?? '';
    if (filterTaskStartFrom) filterTaskStartFrom.value = taskFilters.startFrom ?? '';
    if (filterTaskEndUntil) filterTaskEndUntil.value = taskFilters.endUntil ?? '';
    if (filterTaskMinDuration) filterTaskMinDuration.value = taskFilters.minDurationDays ?? '';
    if (filterTaskMaxDuration) filterTaskMaxDuration.value = taskFilters.maxDurationDays ?? '';
}

function syncNoteFilterControls() {
    if (filterNoteProject) filterNoteProject.value = noteFilters.project ?? 'all';
    if (filterNotePriority) filterNotePriority.value = noteFilters.priority ?? '';
    if (filterNoteCreatedFrom) filterNoteCreatedFrom.value = noteFilters.createdFrom ?? '';
    if (filterNoteCreatedUntil) filterNoteCreatedUntil.value = noteFilters.createdUntil ?? '';
}

function resetTaskFilters() {
    taskFilters = defaultTaskFilters();
    syncTaskFilterControls();
    setShowArchived(false);
}

function resetNoteFilters() {
    noteFilters = defaultNoteFilters();
    syncNoteFilterControls();
}

function applyTaskFilterShortcut({ projectId, priority }) {
    if (projectId && filterTaskProject) {
        filterTaskProject.value = projectId;
        taskFilters.project = projectId;
    }
    if (priority && filterTaskPriority) {
        filterTaskPriority.value = priority;
        taskFilters.priority = priority;
    }
    markTaskFiltersChanged();
    applyPreviewHeaderForSelection(getSelectedProjectIdsForPreview());
    renderPreviewContentForSelection(getSelectedProjectIdsForPreview());
}

function applyNoteFilterShortcut({ projectId, priority }) {
    if (projectId && filterNoteProject) {
        filterNoteProject.value = projectId;
        noteFilters.project = projectId;
    }
    if (priority && filterNotePriority) {
        filterNotePriority.value = priority;
        noteFilters.priority = priority;
    }
    applyPreviewHeaderForSelection(getSelectedProjectIdsForPreview());
    renderPreviewContentForSelection(getSelectedProjectIdsForPreview());
}


function buildTaskContextMenu(projectId, task, options = {}) {
    if (!projectId || !task) return [];
    const items = [];
    items.push({
        label: 'Open task details',
        action: () => showTaskView(task, projectId),
    });
    items.push({
        label: 'Edit Task…',
        action: () => openEntryModalForEntry(projectId, task, 'task'),
    });
    const isClosed = (task.status || 'none').toLowerCase() === 'closed';
    items.push({
        label: isClosed ? 'Reopen task' : 'Mark as done',
        action: async () => {
            const nextStatus = isClosed ? 'in_progress' : 'closed';
            await updateProjectEntry(projectId, task.id, { status: nextStatus, type: 'task' });
            await refreshPreviewForCurrentSelection([projectId], true);
        },
    });
    items.push({
        label: 'Duplicate task',
        action: async () => {
            await duplicateTask(projectId, task);
            await refreshPreviewForCurrentSelection([projectId], true);
        },
    });
    items.push({
        label: 'Copy description',
        action: () => copyToClipboard(task.text || ''),
    });
    items.push('divider');
    items.push({
        label: 'Filter by this project',
        action: () => applyTaskFilterShortcut({ projectId }),
    });
    if (task.priority) {
        items.push({
            label: 'Filter by this priority',
            action: () => applyTaskFilterShortcut({ priority: (task.priority || '').toLowerCase() }),
        });
    }
    const hierarchyEnabled = Boolean(getProjectSettings().taskHierarchyView);
    const hierarchyParents = Array.isArray(options.hierarchyParents) ? options.hierarchyParents : null;
    const collapseKeys = hierarchyParents ? hierarchyParents : Array.from(lastTaskTreeParents);
    if (hierarchyEnabled) {
        const refreshPreview = isPreviewVisible();
        items.push('divider');
        items.push({
            label: 'Expand all',
            action: () => {
                if (hierarchyParents) {
                    applyHierarchyCollapsed([], { refreshPreview });
                } else {
                    expandAllTaskTree();
                }
            },
        });
        items.push({
            label: 'Collapse all',
            disabled: collapseKeys.length === 0,
            action: () => {
                if (hierarchyParents) {
                    applyHierarchyCollapsed(collapseKeys, { refreshPreview });
                } else {
                    collapseAllTaskTree();
                }
            },
        });
    }
    items.push('divider');
    items.push({
        label: 'Delete task',
        danger: true,
        action: async () => {
            await deleteProjectEntryWithRefresh(projectId, task.id, 'task', 'Delete this task?');
        },
    });
    return items;
}

async function openTimelineTaskContextMenu({ projectId, taskId, x, y } = {}) {
    if (!projectId || !taskId) return;
    hideContextMenu();
    let task = getCachedTask(projectId, taskId);
    if (!task) {
        try {
            await ensurePreviewEntriesForProjects([projectId], true);
        } catch (error) {
            console.warn('Unable to load task for context menu', error);
        }
        task = getCachedTask(projectId, taskId);
    }
    if (!task) {
        showToast('Task not available.', true);
        return;
    }
    const parentKeys = timelineController?.getHierarchyParentKeys?.() || [];
    const items = buildTaskContextMenu(projectId, task, { hierarchyParents: parentKeys });
    if (!items.length) return;
    renderContextMenu(items);
    positionContextMenu(x, y);
}

function buildNoteContextMenu(projectId, note) {
    if (!projectId || !note) return [];
    const items = [];
    items.push({
        label: 'Open note',
        action: () => showNoteView(note, projectById(projectId)),
    });
    items.push({
        label: 'Edit Note…',
        action: () => openEntryModalForEntry(projectId, note, 'note'),
    });
    items.push({
        label: 'Duplicate note',
        action: async () => {
            await duplicateNote(projectId, note);
            await ensurePreviewEntriesForProjects([projectId], true);
            renderPreviewContentForSelection(getSelectedProjectIdsForPreview());
        },
    });
    items.push({
        label: 'Copy note text',
        action: () => copyToClipboard(note.text || ''),
    });
    items.push('divider');
    items.push({
        label: 'Filter by this project',
        action: () => applyNoteFilterShortcut({ projectId }),
    });
    if (note.priority) {
        items.push({
            label: 'Filter by this priority',
            action: () => applyNoteFilterShortcut({ priority: (note.priority || '').toLowerCase() }),
        });
    }
    items.push('divider');
    items.push({
        label: 'Delete note',
        danger: true,
        action: async () => {
            await deleteProjectEntryWithRefresh(projectId, note.id, 'note', 'Delete this note?');
        },
    });
    return items;
}

function buildLinkedNoteContextMenu(projectId, linkedNote) {
    if (!projectId || !linkedNote) return [];
    return [
        {
            label: 'Open in workspace',
            action: () => openLinkedNoteInWorkspace(projectId, linkedNote),
        },
    ];
}

async function manageProjectEntries(project) {
    if (!project?.id) return;
    selectedProjects.clear();
    selectedProjects.add(project.id);
    lastSelectedProjectId = project.id;
    if (!isPreviewVisible()) {
        if (getAuxPlacement() === 'hidden') {
            setAuxPlacement('right');
        }
        setAuxTab('tasks');
        return;
    }
    renderProjects();
    updatePreviewSelection();
}

async function copyRootPath(rootPath) {
    if (!rootPath) return;
    try {
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(rootPath);
            showToast('Root path copied to clipboard.');
            return;
        }
    } catch (error) {
        console.warn('Unable to copy root path', error);
    }
    showToast(rootPath);
}

async function openProject(project) {
    if (!project?.id) return;
    if (!project.root_path) {
        showToast('Set a root folder before opening this project.', true);
        return;
    }
    await activateProject(project.id);
}

function toggleNestedView(enabled) {
    state.settings.projects = state.settings.projects || {};
    state.settings.projects.nestedView = enabled;
    persistPreferences();
    renderProjects();
}

function setupTimeline() {
    if (!timelineRoot) return;
    timelineController = initTimelineController({
        rootEl: timelineRoot,
        getProjects: () => projects,
        getSelectedProjectIds: () => getTimelineSelectedProjectIds(),
        getSettings: () => {
            const prefs = getProjectSettings();
            const zoomPrefs = getTimelineZoomPrefs();
            const hierarchyPrefs = getTimelineHierarchyPrefs();
            return {
                fallbackColor: FALLBACK_COLOR,
                visibleColumns: prefs.timelineVisibleColumns,
                showBarLabels: prefs.timelineShowBarLabels,
                highlightRows: prefs.timelineHighlightRows,
                dayWidthPx: zoomPrefs.zoomMode === 'manual' ? zoomPrefs.dayWidthPx : TIMELINE_DEFAULT_DAY_WIDTH,
                minDayWidthPx: TIMELINE_MIN_DAY_WIDTH,
                maxDayWidthPx: TIMELINE_MAX_DAY_WIDTH,
                zoomMode: zoomPrefs.zoomMode,
                hierarchy: {
                    enabled: hierarchyPrefs.enabled,
                    collapsed: Array.from(hierarchyPrefs.collapsed),
                },
                filters: {
                    taskFilters: { ...taskFilters },
                    showArchived: !!showArchivedTasks,
                    hideUndated: !!prefs.timelineHideUndatedTasks,
                },
                timelineOpenTaskOnClick: !!prefs.timelineOpenTaskOnClick,
                timelineHierarchyLinkStyle: prefs.timelineHierarchyLinkStyle,
            };
        },
        onOpenTask: ({ projectId, taskId }) => openTimelineTask(projectId, taskId),
        onCreateTaskFromRange: ({ startDate, endDate }) => {
            const selection = getTimelineSelectedProjectIds();
            const targetId = selection[0];
            if (!targetId) return;
            const project = projectById(targetId);
            if (!project) return;
            openEntryModalForProject(project, 'task', null);
            if (entryStart) entryStart.value = toISODate(startDate);
            if (entryEnd) entryEnd.value = toISODate(endDate);
        },
        onSetDatesForFocusedTask: async ({ startDate, endDate, focused }) => {
            const projectId = focused?.projectId;
            const taskId = focused?.taskId;
            if (!projectId || !taskId) return;
            try {
                await ensurePreviewEntriesForProjects([projectId]);
            } catch (error) {
                console.warn('Unable to load task before editing', error);
            }
            const task = previewEntriesCache.get(projectId)?.tasks?.find((entry) => entry.id === taskId);
            if (!task) return;
            if (task.auto_rollup_dates) {
                showToast('Dates are auto-synced from children.', true);
                return;
            }
            openEntryModalForEntry(projectId, task, 'task');
            if (entryStart) entryStart.value = toISODate(startDate);
            if (entryEnd) entryEnd.value = toISODate(endDate);
            storeManualEntryDates();
        },
        onMoveTaskDates: async ({ projectId, taskId, startDate, endDate }) => {
            if (!projectId || !taskId || !startDate || !endDate) return;
            try {
                const start_date = toISODate(startDate);
                const end_date = toISODate(endDate);
                await updateProjectEntry(projectId, taskId, {
                    type: 'task',
                    start_date,
                    end_date,
                });
                await ensurePreviewEntriesForProjects([projectId], true);
                const selectedIds = getSelectedProjectIdsForPreview();
                if (selectedIds.length) {
                    renderPreviewContentForSelection(selectedIds);
                }
                refreshTimeline(true);
            } catch (error) {
                showToast('Could not update task dates.', true);
                throw error;
            }
        },
        onResizeTaskDates: async ({ projectId, taskId, startDate, endDate }) => {
            if (!projectId || !taskId || !startDate || !endDate) return;
            try {
                const start_date = toISODate(startDate);
                const end_date = toISODate(endDate);
                await updateProjectEntry(projectId, taskId, {
                    type: 'task',
                    start_date,
                    end_date,
                });
                await ensurePreviewEntriesForProjects([projectId], true);
                const selectedIds = getSelectedProjectIdsForPreview();
                if (selectedIds.length) {
                    renderPreviewContentForSelection(selectedIds);
                }
                refreshTimeline(true);
            } catch (error) {
                showToast('Could not update task dates.', true);
                throw error;
            }
        },
        onToggleRowCollapsed: (taskKey) => {
            toggleTimelineHierarchyCollapsed(taskKey);
        },
        onTaskContextMenu: ({ projectId, taskId, x, y }) => {
            openTimelineTaskContextMenu({ projectId, taskId, x, y });
        },
        onErrorToast: (message) => showToast(message, true),
        getLeftWidthPx: () => getTimelineLeftWidthPx(),
        onLeftWidthCommit: (widthPx) => {
            persistTimelineLeftWidthPx(widthPx);
        },
    });
    if (timelineProjectsFollow) {
        timelineProjectsFollow.addEventListener('change', () => setTimelineFollowMain(timelineProjectsFollow.checked));
    }
    if (timelineProjectsClear) {
        timelineProjectsClear.addEventListener('click', (event) => {
            event.preventDefault();
            if (timelineProjectsClear.disabled) return;
            clearTimelineSelection();
        });
    }
    renderTimelineProjectOptions();
    timelineNeedsRender = true;
}

function init() {
    const settings = getProjectSettings();
    currentPreviewMode = settings.previewMode || 'task';
    showArchivedTasks = !!settings.showArchivedTasks;
    initToast();
    initTheme();
    setupBrowse();
    setupForm();
    setupNewButtons();
    setupLayoutControls();
    setupTimeline();
    setupTimelineHeaderControls();
    setupTimelineZoomControls();
    setupTimelineFilterControls();
    setupTimelineHierarchyControls();
    setupColumnSelector();
    setupPreviewControls();
    setupInlineComposer();
    setupNotesSectionCollapsers();
    setupHeaderAddNote();
    updateHierarchyControls(getSelectedProjectIdsForPreview().length);
    tableBody?.addEventListener('click', handleProjectRowClick);
    document.addEventListener('click', handleBackgroundDeselect);
    selectAllCheckbox?.addEventListener('change', () => {
        if (selectAllCheckbox.checked) {
            projects.forEach((project) => selectedProjects.add(project.id));
        } else {
            selectedProjects.clear();
        }
        renderProjects();
        updatePreviewSelection();
    });
    setupNestedSync();
    setupPreviewSettingsSync();
    setupContextMenu();
    setupEntryModal();
    setupTaskViewModal();
    renderColorPalette();
    setupColorClear();
    parentSelect?.addEventListener('change', () => maybeInheritParentColor());
    tableBody?.addEventListener('click', handleTableClick);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            void refreshLinkedNotesForCurrentSelection(true);
        }
    });
    window.addEventListener('focus', () => {
        void refreshLinkedNotesForCurrentSelection(true);
    });
    document.addEventListener('qualifile:preview-refresh', () => {
        void refreshLinkedNotesForCurrentSelection(true);
    });
    loadProjects();
}

init();

function renderColorPalette() {
    if (!colorPalette) return;
    colorPalette.innerHTML = '';
    const pickerRow = document.createElement('div');
    pickerRow.className = 'project-color-picker-row';

    colorPickerInput = document.createElement('input');
    colorPickerInput.type = 'color';
    colorPickerInput.className = 'form-control form-control-color project-color-picker';
    colorPickerInput.value = normalizeHexColor(colorInput.value) || FALLBACK_COLOR;
    colorPickerInput.addEventListener('input', () => {
        selectColor(colorPickerInput.value, false);
    });

    colorTextInput = document.createElement('input');
    colorTextInput.type = 'text';
    colorTextInput.className = 'form-control form-control-sm';
    colorTextInput.placeholder = '#AABBCC';
    colorTextInput.value = normalizeHexColor(colorInput.value) || '';
    colorTextInput.addEventListener('change', () => {
        const normalized = normalizeHexColor(colorTextInput.value);
        if (normalized) {
            selectColor(normalized, false);
            if (colorPickerInput) {
                colorPickerInput.value = normalized;
            }
        } else {
            colorTextInput.value = colorInput.value || '';
        }
    });

    pickerRow.appendChild(colorPickerInput);
    pickerRow.appendChild(colorTextInput);
    colorPalette.appendChild(pickerRow);
}

function updateColorSelection(color) {
    const normalized = normalizeHexColor(color);
    if (colorPickerInput && normalized) {
        colorPickerInput.value = normalized;
    } else if (colorPickerInput && !normalized) {
        colorPickerInput.value = FALLBACK_COLOR;
    }
    if (colorTextInput) {
        colorTextInput.value = normalized;
    }
    if (colorValueBadge) {
        if (normalized) {
            colorValueBadge.textContent = 'Colour selected';
            colorValueBadge.classList.remove('bg-secondary-subtle', 'text-secondary-emphasis');
            colorValueBadge.classList.add('bg-primary-subtle', 'text-primary');
            colorValueBadge.style.setProperty('--project-color', normalized);
        } else {
            colorValueBadge.textContent = 'No colour';
            colorValueBadge.classList.add('bg-secondary-subtle', 'text-secondary-emphasis');
            colorValueBadge.classList.remove('bg-primary-subtle', 'text-primary');
            colorValueBadge.style.removeProperty('--project-color');
        }
    }
}

function selectColor(color, closePalette = false) {
    const normalized = normalizeHexColor(color);
    colorInput.value = normalized || '';
    updateColorSelection(normalized || '');
}

function setupColorClear() {
    if (!colorClearButton) return;
    colorClearButton.addEventListener('click', () => {
        colorInput.value = '';
        updateColorSelection('');
    });
}

function normalizeHexColor(color) {
    if (!color) return '';
    let text = String(color).trim();
    if (!text) return '';
    if (text.startsWith('#')) text = text.slice(1);
    if (text.length === 3) {
        text = text.split('').map((ch) => ch + ch).join('');
    }
    if (text.length !== 6) return '';
    if (!/^[0-9a-fA-F]{6}$/.test(text)) return '';
    return `#${text.toLowerCase()}`;
}

function maybeInheritParentColor() {
    if (editingId) return;
    const parentId = parentSelect?.value;
    if (!parentId) {
        updateColorSelection(colorInput.value || '');
        return;
    }
    const parent = projects.find((p) => p.id === parentId);
    if (!parent || !parent.color) {
        updateColorSelection(colorInput.value || '');
        return;
    }
    if (!(colorInput.value || '').trim()) {
        colorInput.value = parent.color;
        updateColorSelection(parent.color);
    } else {
        updateColorSelection(colorInput.value || '');
    }
}
