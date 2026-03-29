import { TimelineDataSource } from './data.js';
import {
    addDays,
    computeTimelineRange,
    daysBetween,
    durationInDays,
    normalizeDateRange,
    todayUtc,
} from './dates.js';
import { renderTimeline } from './render.js';

const DEFAULTS = {
    bufferDays: 2,
    dayWidthPx: 32,
    rowHeightPx: 44,
    fallbackColor: '#1e88e5',
};
const MIN_DAY_WIDTH = 8;
const MAX_DAY_WIDTH = 120;

function normalizeColor(value, fallback) {
    const raw = (value || '').toString().trim();
    if (!raw) return fallback;
    return raw.startsWith('#') ? raw : `#${raw}`;
}

function normalizeNumber(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return fallback;
    return num;
}

function normalizeVisibleColumns(raw = {}) {
    return {
        project: raw.project !== false,
        start: raw.start !== false,
        end: raw.end !== false,
        duration: raw.duration !== false,
    };
}

function parseDateSafe(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeFilters(raw = {}) {
    const task = raw?.taskFilters || {};
    const normalizeDuration = (value) => {
        if (value === '' || value === null || value === undefined) return '';
        if (typeof value === 'string' && !value.trim()) return '';
        const num = Number(value);
        return Number.isFinite(num) ? num : '';
    };
    return {
        taskFilters: {
            priority: (task.priority || '').toString().toLowerCase(),
            status: (task.status || '').toString().toLowerCase(),
            project: task.project || 'all',
            startFrom: task.startFrom || '',
            endUntil: task.endUntil || '',
            minDurationDays: normalizeDuration(task.minDurationDays),
            maxDurationDays: normalizeDuration(task.maxDurationDays),
        },
        showArchived: !!raw.showArchived,
        hideUndated: !!raw.hideUndated,
    };
}

function normalizeHierarchy(raw = {}) {
    const enabled = !!(raw?.timelineHierarchyView || raw?.hierarchyEnabled || raw?.hierarchy?.enabled);
    const collapsedRaw =
        raw?.timelineHierarchyCollapsedKeys ||
        raw?.timelineHierarchyCollapsed ||
        raw?.hierarchyCollapsed ||
        raw?.hierarchy?.collapsed;
    let collapsedList = [];
    if (Array.isArray(collapsedRaw)) {
        collapsedList = collapsedRaw;
    } else if (collapsedRaw && typeof collapsedRaw === 'object') {
        collapsedList = Object.keys(collapsedRaw).filter((key) => collapsedRaw[key]);
    }
    return {
        enabled,
        collapsed: new Set(collapsedList.filter((key) => typeof key === 'string' && key)),
    };
}

function normalizeHierarchyLinkStyle(raw = {}) {
    const allowed = new Set(['hover', 'bracket', 'none']);
    const candidate =
        typeof raw?.timelineHierarchyLinkStyle === 'string' ? raw.timelineHierarchyLinkStyle.toLowerCase() : '';
    return allowed.has(candidate) ? candidate : 'hover';
}

function formatCompactDate(date, includeYear = false) {
    if (!date) return '';
    try {
        const options = { month: 'short', day: 'numeric', timeZone: 'UTC' };
        if (includeYear) options.year = 'numeric';
        return date.toLocaleDateString(undefined, options);
    } catch (error) {
        return '';
    }
}

function summarizeRange(start, end, includeYear = false) {
    if (!start || !end) return '';
    const startLabel = formatCompactDate(start, includeYear);
    const endLabel = formatCompactDate(end, includeYear);
    if (!startLabel && !endLabel) return '';
    if (startLabel === endLabel) return startLabel;
    return `${startLabel} - ${endLabel}`;
}

function computeEffectiveTaskRanges(rows, taskKeyFn) {
    const nodes = new Map();
    rows.forEach((row) => {
        const key = row.taskKey || taskKeyFn(row.projectId, row.taskId);
        if (!key || key === '::') return;
        row.taskKey = key;
        nodes.set(key, row);
    });

    const parentKeyMap = new Map();
    nodes.forEach((row, key) => {
        if (!row.parentTaskId) {
            parentKeyMap.set(key, null);
            return;
        }
        const parentKey = taskKeyFn(row.parentProjectId || row.projectId, row.parentTaskId);
        parentKeyMap.set(key, nodes.has(parentKey) && parentKey !== key ? parentKey : null);
    });

    const cycleKeys = new Set();
    nodes.forEach((_row, key) => {
        const seen = new Map();
        const path = [];
        let current = key;
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
        if (cycleKeys.has(childKey) || cycleKeys.has(parentKey)) return;
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
        const row = nodes.get(key);
        if (!row) return null;
        const childKeys = childrenMap.get(key) || [];
        const childRanges = childKeys
            .map((childKey) => compute(childKey))
            .filter((range) => range && range.startDate && range.endDate);
        let result = null;
        if (row.autoRollupDates) {
            if (childRanges.length) {
                let minStart = childRanges[0].startDate;
                let maxEnd = childRanges[0].endDate;
                childRanges.forEach((range) => {
                    if (range.startDate < minStart) minStart = range.startDate;
                    if (range.endDate > maxEnd) maxEnd = range.endDate;
                });
                result = { startDate: minStart, endDate: maxEnd, source: 'children' };
            }
        } else if (row.startDate && row.endDate) {
            result = { startDate: row.startDate, endDate: row.endDate, source: 'self' };
        }
        memo.set(key, result);
        return result;
    };

    nodes.forEach((_row, key) => {
        compute(key);
    });

    return { ranges: memo, cycleKeys };
}

export class TimelineController {
    constructor(options = {}) {
        this.dataSource = new TimelineDataSource(options.dataSource || {});
        this.rootEl = null;
        this.getProjects = null;
        this.getSelectedProjectIds = null;
        this.getSettings = null;
        this.onOpenTask = null;
        this.onCreateTaskFromRange = null;
        this.onSetDatesForFocusedTask = null;
        this.onMoveTaskDates = null;
        this.onResizeTaskDates = null;
        this.onToggleRowCollapsed = null;
        this.onTaskContextMenu = null;
        this.onErrorToast = null;
        this.getLeftWidthPx = null;
        this.onLeftWidthCommit = null;
        this.projects = [];
        this.projectMap = new Map();
        this.manualSelection = null;
        this.lastFocusedTask = null;
        this.selectedTaskKeys = new Set();
        this.autoLockedTaskKeys = new Set();
        this.lastHierarchyParentKeys = [];
        this.cleanup = null;
        this.destroyed = false;
        this.renderToken = 0;
    }

    init(options = {}) {
        if (!options.rootEl) {
            throw new Error('TimelineController.init requires a rootEl.');
        }
        this.rootEl = options.rootEl;
        this.getProjects = typeof options.getProjects === 'function' ? options.getProjects : null;
        this.getSelectedProjectIds =
            typeof options.getSelectedProjectIds === 'function' ? options.getSelectedProjectIds : null;
        this.getSettings = typeof options.getSettings === 'function' ? options.getSettings : null;
        this.onOpenTask = typeof options.onOpenTask === 'function' ? options.onOpenTask : null;
        this.onCreateTaskFromRange =
            typeof options.onCreateTaskFromRange === 'function' ? options.onCreateTaskFromRange : null;
        this.onSetDatesForFocusedTask =
            typeof options.onSetDatesForFocusedTask === 'function' ? options.onSetDatesForFocusedTask : null;
        this.onMoveTaskDates = typeof options.onMoveTaskDates === 'function' ? options.onMoveTaskDates : null;
        this.onResizeTaskDates = typeof options.onResizeTaskDates === 'function' ? options.onResizeTaskDates : null;
        this.onToggleRowCollapsed = typeof options.onToggleRowCollapsed === 'function' ? options.onToggleRowCollapsed : null;
        this.onTaskContextMenu = typeof options.onTaskContextMenu === 'function' ? options.onTaskContextMenu : null;
        this.onErrorToast = typeof options.onErrorToast === 'function' ? options.onErrorToast : null;
        this.getLeftWidthPx = typeof options.getLeftWidthPx === 'function' ? options.getLeftWidthPx : null;
        this.onLeftWidthCommit = typeof options.onLeftWidthCommit === 'function' ? options.onLeftWidthCommit : null;
        if (Array.isArray(options.initialProjects)) {
            this.setProjects(options.initialProjects, false);
        }
        if (Array.isArray(options.initialSelection)) {
            this.setSelection(options.initialSelection, false);
        }
        this.refresh();
        return this;
    }

    _taskKey(projectId, taskId) {
        return `${projectId || ''}::${taskId || ''}`;
    }

    getSelectedTaskKeys() {
        return this.selectedTaskKeys;
    }

    getHierarchyParentKeys() {
        return Array.isArray(this.lastHierarchyParentKeys) ? this.lastHierarchyParentKeys : [];
    }

    clearTaskSelection() {
        this.selectedTaskKeys.clear();
    }

    _pruneSelection(availableKeys) {
        if (!availableKeys || !availableKeys.size) {
            this.selectedTaskKeys.clear();
            this.lastFocusedTask = null;
            return;
        }
        this.selectedTaskKeys.forEach((key) => {
            if (!availableKeys.has(key)) {
                this.selectedTaskKeys.delete(key);
            }
        });
        if (this.lastFocusedTask) {
            const focusedKey = this._taskKey(this.lastFocusedTask.projectId, this.lastFocusedTask.taskId);
            if (!availableKeys.has(focusedKey)) {
                this.lastFocusedTask = null;
            }
        }
    }

    selectTask({ projectId, taskId, toggle = false } = {}) {
        if (!projectId || !taskId) return;
        const key = this._taskKey(projectId, taskId);
        if (toggle) {
            if (this.selectedTaskKeys.has(key)) {
                this.selectedTaskKeys.delete(key);
            } else {
                this.selectedTaskKeys.add(key);
            }
        } else if (this.selectedTaskKeys.has(key) && this.selectedTaskKeys.size > 1) {
            // Preserve multi-selection when clicking an already-selected task.
        } else {
            this.selectedTaskKeys.clear();
            this.selectedTaskKeys.add(key);
        }
        this._setLastFocusedTask({ projectId, taskId });
    }

    setProjects(list, shouldRefresh = true) {
        if (!Array.isArray(list)) return this;
        this.projects = list.slice();
        this.projectMap = new Map();
        this.projects.forEach((project) => {
            if (!project?.id) return;
            this.projectMap.set(project.id, project);
        });
        if (shouldRefresh) {
            this.refresh();
        }
        return this;
    }

    setSelection(projectIds, shouldRefresh = true) {
        if (!projectIds) {
            this.manualSelection = null;
        } else {
            const normalized = Array.from(new Set((Array.isArray(projectIds) ? projectIds : [projectIds]).filter(Boolean)));
            this.manualSelection = normalized;
        }
        if (shouldRefresh) {
            this.refresh();
        }
        return this;
    }

    destroy() {
        this.destroyed = true;
        if (typeof this.cleanup === 'function') {
            this.cleanup();
        }
        this.cleanup = null;
        this.dataSource.clearCache();
        this.rootEl = null;
    }

    async refresh({ forceReload = false } = {}) {
        if (this.destroyed || !this.rootEl) return;
        this.renderToken += 1;
        const token = this.renderToken;
        this._renderLoading();
        const settings = this._resolveSettings();
        this._resolveProjects();
        const selection = this._resolveSelection();
        if (this.lastFocusedTask && !selection.includes(this.lastFocusedTask.projectId)) {
            this.lastFocusedTask = null;
        }
        if (!selection.length) {
            this._renderEmpty({
                title: 'Select a project',
                description: 'Choose one or more projects to see their tasks on the timeline.',
            });
            return;
        }
        try {
            const items = await this.dataSource.loadTasks(selection, { forceReload });
            if (this.destroyed || token !== this.renderToken) return;
            const model = this._buildViewModel(items, settings);
            this._render(model);
        } catch (error) {
            if (this.destroyed || token !== this.renderToken) return;
            this._renderError(error?.message || 'Unable to load the timeline.');
        }
    }

    _resolveSettings() {
        const raw = typeof this.getSettings === 'function' ? this.getSettings() : {};
        const bufferDays = Number.isInteger(raw?.bufferDays) ? Math.max(0, raw.bufferDays) : DEFAULTS.bufferDays;
        const minDayWidthPx = normalizeNumber(raw?.minDayWidthPx, MIN_DAY_WIDTH);
        const maxDayWidthPx = normalizeNumber(raw?.maxDayWidthPx, MAX_DAY_WIDTH);
        const dayWidthRaw = normalizeNumber(raw?.dayWidthPx || raw?.dayWidth, DEFAULTS.dayWidthPx);
        const dayWidthPx = Math.min(Math.max(dayWidthRaw, minDayWidthPx), maxDayWidthPx);
        const rowHeightPx = normalizeNumber(raw?.rowHeightPx || raw?.rowHeight, DEFAULTS.rowHeightPx);
        const fallbackColor = normalizeColor(raw?.fallbackColor, DEFAULTS.fallbackColor);
        const visibleColumns = normalizeVisibleColumns(raw?.visibleColumns || raw?.timelineVisibleColumns);
        const showBarLabels = !!(raw?.showBarLabels || raw?.timelineShowBarLabels);
        const highlightRows = !!(raw?.highlightRows || raw?.timelineHighlightRows);
        const zoomMode = raw?.zoomMode === 'manual' ? 'manual' : 'fit';
        const filters = normalizeFilters(raw?.filters);
        const hierarchy = normalizeHierarchy(raw);
        const hierarchyLinkStyle = normalizeHierarchyLinkStyle(raw);
        return {
            bufferDays,
            dayWidthPx,
            minDayWidthPx,
            maxDayWidthPx,
            rowHeightPx,
            fallbackColor,
            visibleColumns,
            showBarLabels,
            highlightRows,
            zoomMode,
            filters,
            hierarchy,
            hierarchyLinkStyle,
        };
    }

    _resolveProjects() {
        const provided = typeof this.getProjects === 'function' ? this.getProjects() : this.projects;
        const list = Array.isArray(provided) ? provided : [];
        this.setProjects(list, false);
        return this.projects;
    }

    _resolveSelection() {
        const inferred = typeof this.getSelectedProjectIds === 'function' ? this.getSelectedProjectIds() : [];
        const selected = this.manualSelection !== null ? this.manualSelection : inferred;
        return Array.from(new Set((selected || []).filter(Boolean)));
    }

    _renderEmpty(message) {
        this._render({ state: 'empty', empty: message });
    }

    _renderError(message) {
        this._render({ state: 'error', error: message });
    }

    _renderLoading() {
        this._render({ state: 'loading' });
    }

    _setLastFocusedTask({ projectId, taskId } = {}) {
        if (!projectId || !taskId) {
            this.lastFocusedTask = null;
            return;
        }
        this.lastFocusedTask = { projectId, taskId };
    }

    _render(model) {
        if (typeof this.cleanup === 'function') {
            this.cleanup();
            this.cleanup = null;
        }
        const handleOpenTask = ({ projectId, taskId } = {}) => {
            this.selectTask({ projectId, taskId, toggle: false });
            if (typeof this.onOpenTask === 'function') {
                this.onOpenTask({ projectId, taskId });
            }
        };
        this.cleanup = renderTimeline(this.rootEl, model, {
            onOpenTask: handleOpenTask,
            getSelectedTaskKeys: () => this.selectedTaskKeys,
            onSelectTask: ({ projectId, taskId, toggle }) => {
                this.selectTask({ projectId, taskId, toggle });
            },
            onClearTaskSelection: () => {
                this.clearTaskSelection();
            },
            shouldOpenTaskOnClick: () => {
                const raw = typeof this.getSettings === 'function' ? this.getSettings() : {};
                return !!raw?.timelineOpenTaskOnClick;
            },
            isTaskAutoLocked: ({ projectId, taskId } = {}) => {
                const key = this._taskKey(projectId, taskId);
                return this.autoLockedTaskKeys?.has(key);
            },
            onToggleRowCollapsed: (taskKey) => {
                if (typeof this.onToggleRowCollapsed === 'function') {
                    this.onToggleRowCollapsed(taskKey);
                }
            },
            onTaskContextMenu: (payload) => {
                if (typeof this.onTaskContextMenu === 'function') {
                    this.onTaskContextMenu(payload);
                }
            },
            getLastFocusedTask: () => this.lastFocusedTask,
            onCreateTaskFromRange: (range) => {
                if (typeof this.onCreateTaskFromRange === 'function') {
                    this.onCreateTaskFromRange(range);
                }
            },
            onSetDatesForFocusedTask: ({ startDate, endDate } = {}) => {
                if (!this.lastFocusedTask) return;
                if (typeof this.onSetDatesForFocusedTask === 'function') {
                    this.onSetDatesForFocusedTask({
                        startDate,
                        endDate,
                        focused: this.lastFocusedTask,
                    });
                }
            },
            onMoveTaskDates: async (payload) => {
                if (payload?.projectId && payload?.taskId) {
                    this._setLastFocusedTask({
                        projectId: payload.projectId,
                        taskId: payload.taskId,
                    });
                }
                if (typeof this.onMoveTaskDates === 'function') {
                    return this.onMoveTaskDates(payload);
                }
                return null;
            },
            onResizeTaskDates: async (payload) => {
                if (payload?.projectId && payload?.taskId) {
                    this._setLastFocusedTask({
                        projectId: payload.projectId,
                        taskId: payload.taskId,
                    });
                }
                if (typeof this.onResizeTaskDates === 'function') {
                    return this.onResizeTaskDates(payload);
                }
                return null;
            },
            onErrorToast: (message) => {
                if (typeof this.onErrorToast === 'function') {
                    this.onErrorToast(message);
                }
            },
            getLeftWidthPx: () =>
                (typeof this.getLeftWidthPx === 'function' ? this.getLeftWidthPx() : null),
            onLeftWidthCommit: (widthPx) => {
                if (typeof this.onLeftWidthCommit === 'function') {
                    this.onLeftWidthCommit(widthPx);
                }
            },
        });
    }

    _applyFilters(rows, filters) {
        if (!Array.isArray(rows) || !rows.length) return [];
        const taskFilters = filters?.taskFilters || {};
        const priorityFilter = (taskFilters.priority || '').toLowerCase();
        const statusFilter = (taskFilters.status || '').toLowerCase();
        const hideUndated = !!filters?.hideUndated;
        const showArchived = !!filters?.showArchived || statusFilter === 'closed';

        return rows.filter((row) => {
            const status = (row.status || 'none').toLowerCase();
            if (!showArchived && status === 'closed') return false;
            if (statusFilter && statusFilter !== 'any' && statusFilter !== status) return false;

        const priority = (row.priority || '').toLowerCase();
        if (priorityFilter && priorityFilter !== priority) return false;

        const displayStart = row.displayStartDate ?? row.startDate;
        const displayEnd = row.displayEndDate ?? row.endDate;
        if (hideUndated && !displayStart && !displayEnd) return false;

        return true;
    });
}

    _collectHierarchyParents(rows = []) {
        const nodes = new Map();
        rows.forEach((row) => {
            const key = row.taskKey || this._taskKey(row.projectId, row.taskId);
            if (!key || key === '::') return;
            nodes.set(key, row);
        });
        const parentKeys = new Set();
        rows.forEach((row) => {
            if (!row.parentTaskId) return;
            const parentKey = this._taskKey(row.parentProjectId || row.projectId, row.parentTaskId);
            if (parentKey && nodes.has(parentKey) && parentKey !== row.taskKey) {
                parentKeys.add(parentKey);
            }
        });
        return Array.from(parentKeys);
    }

    _applyHierarchy(rows = [], collapsed = new Set()) {
        const nodes = new Map();
        const order = new Map();
        rows.forEach((row, index) => {
            const key = row.taskKey || this._taskKey(row.projectId, row.taskId);
            if (!key || key === '::') return;
            row.taskKey = key;
            order.set(key, index);
            nodes.set(key, { key, row, children: [], parentKey: null });
        });

        const parentKeyMap = new Map();
        nodes.forEach((node) => {
            const parentTaskId = node.row.parentTaskId;
            if (!parentTaskId) {
                parentKeyMap.set(node.key, null);
                return;
            }
            const parentProjectId = node.row.parentProjectId || node.row.projectId;
            const parentKey = this._taskKey(parentProjectId, parentTaskId);
            if (!nodes.has(parentKey) || parentKey === node.key) {
                node.row.hierarchyHint = parentKey === node.key ? 'Cycle detected' : 'Parent not visible';
                parentKeyMap.set(node.key, null);
                return;
            }
            parentKeyMap.set(node.key, parentKey);
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

        cycleKeys.forEach((key) => {
            const node = nodes.get(key);
            if (node) {
                node.row.hierarchyHint = 'Cycle detected';
            }
            parentKeyMap.set(key, null);
        });

        const roots = [];
        nodes.forEach((node) => {
            node.parentKey = parentKeyMap.get(node.key) || null;
            if (node.parentKey) {
                const parent = nodes.get(node.parentKey);
                if (parent) {
                    parent.children.push(node);
                } else {
                    roots.push(node);
                }
            } else {
                roots.push(node);
            }
        });

        const sortByOrder = (a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0);
        const sortTree = (list) => {
            list.sort(sortByOrder);
            list.forEach((child) => sortTree(child.children));
        };
        sortTree(roots);

        const visibleRows = [];
        const parentKeys = new Set();
        const collapseSet = collapsed instanceof Set ? collapsed : new Set();
        const walk = (node, depth, ancestors) => {
            const row = node.row;
            row.depth = depth;
            row.hasChildren = node.children.length > 0;
            row.isCollapsed = row.hasChildren && collapseSet.has(node.key);
            if (row.hasChildren) parentKeys.add(node.key);
            visibleRows.push(row);
            if (row.isCollapsed) return;
            if (ancestors.has(node.key)) {
                row.hierarchyHint = row.hierarchyHint || 'Cycle detected';
                return;
            }
            const nextAncestors = new Set(ancestors);
            nextAncestors.add(node.key);
            node.children.forEach((child) => walk(child, depth + 1, nextAncestors));
        };
        roots.forEach((root) => walk(root, 0, new Set()));
        return { rows: visibleRows, parentKeys: Array.from(parentKeys) };
    }

    _buildViewModel(items, settings) {
        const filters = settings?.filters || normalizeFilters();
        const hierarchy = settings?.hierarchy || normalizeHierarchy();
        const rows = items.map((item) => this._normalizeItem(item, settings));
        const effectiveRanges = computeEffectiveTaskRanges(rows, (projectId, taskId) => this._taskKey(projectId, taskId));
        const autoLockedKeys = new Set();
        rows.forEach((row) => {
            const key = row.taskKey || this._taskKey(row.projectId, row.taskId);
            const effective = effectiveRanges.ranges.get(key);
            row.effectiveStartDate = effective?.startDate || null;
            row.effectiveEndDate = effective?.endDate || null;
            row.autoRollupSource = effective?.source || null;
            row.isAutoLocked = !!row.autoRollupDates;
            if (row.isAutoLocked) {
                autoLockedKeys.add(key);
            }
            // Auto rollup dates override display values without mutating manual dates.
            if (row.autoRollupDates) {
                if (effective?.source === 'children' && effective.startDate && effective.endDate) {
                    row.displayStartDate = effective.startDate;
                    row.displayEndDate = effective.endDate;
                    row.displayDurationDays = durationInDays(effective.startDate, effective.endDate);
                } else {
                    row.displayStartDate = null;
                    row.displayEndDate = null;
                    row.displayDurationDays = null;
                }
            } else {
                row.displayStartDate = row.startDate;
                row.displayEndDate = row.endDate;
                row.displayDurationDays = row.durationDays;
            }
        });
        this.autoLockedTaskKeys = autoLockedKeys;
        const availableKeys = new Set(
            rows
                .map((row) => this._taskKey(row.projectId, row.taskId))
                .filter((key) => key && key !== '::'),
        );
        this._pruneSelection(availableKeys);
        rows.sort((a, b) => {
            const aDate = a.displayStartDate || a.displayEndDate;
            const bDate = b.displayStartDate || b.displayEndDate;
            if (aDate && bDate) return aDate.getTime() - bDate.getTime();
            if (aDate) return -1;
            if (bDate) return 1;
            return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
        });
        // Filters run before hierarchy so the timeline range is based on filtered data, not collapsed nodes.
        const filteredRows = this._applyFilters(rows, filters);
        const dated = filteredRows
            .map((row) => ({
                startDate: row.displayStartDate,
                endDate: row.displayEndDate,
            }))
            .filter((row) => row.startDate || row.endDate);
        const baseRange = computeTimelineRange(dated, settings.bufferDays);
        const fallbackStart = addDays(todayUtc(), -settings.bufferDays);
        const fallbackEnd = addDays(todayUtc(), settings.bufferDays);
        let range = baseRange || {
            start: fallbackStart,
            end: fallbackEnd,
            totalDays: durationInDays(fallbackStart, fallbackEnd),
        };
        const spansMultipleYears =
            range?.start && range?.end && range.start.getUTCFullYear() !== range.end.getUTCFullYear();
        const rowsWithText = filteredRows.map((row) => {
            const hasDates = row.displayStartDate && row.displayEndDate;
            const startText = row.displayStartDate
                ? formatCompactDate(row.displayStartDate, spansMultipleYears)
                : hasDates
                    ? ''
                    : 'No dates';
            const endText = row.displayEndDate
                ? formatCompactDate(row.displayEndDate, spansMultipleYears)
                : hasDates
                    ? ''
                    : '??"';
            const durationText =
                row.displayDurationDays && row.displayDurationDays > 0
                    ? `${row.displayDurationDays} day${row.displayDurationDays === 1 ? '' : 's'}`
                    : '??"';
            return { ...row, startText, endText, durationText };
        });
        const dayCount = Math.max(range?.totalDays || 0, 1);
        const rowsWithBars = rowsWithText.map((row) => {
            if (!row.displayStartDate || !row.displayEndDate || !range?.start) {
                return { ...row, bar: null, highlightColor: settings.highlightRows ? row.color : '' };
            }
            const offset = daysBetween(range.start, row.displayStartDate);
            const spanDays = Math.max(1, row.displayDurationDays || 1);
            return {
                ...row,
                bar: {
                    offsetDays: offset,
                    spanDays,
                    color: row.color,
                    label: settings.showBarLabels && !row.isAutoLocked ? row.title : '',
                    startDate: row.displayStartDate,
                    endDate: row.displayEndDate,
                },
                highlightColor: settings.highlightRows ? row.color : '',
            };
        });
        let visibleRows = rowsWithBars;
        let parentKeys = [];
        if (hierarchy.enabled) {
            const result = this._applyHierarchy(rowsWithBars, hierarchy.collapsed);
            visibleRows = result.rows;
            parentKeys = result.parentKeys;
        } else {
            rowsWithBars.forEach((row) => {
                row.depth = 0;
                row.hasChildren = false;
                row.isCollapsed = false;
            });
            parentKeys = this._collectHierarchyParents(rowsWithBars);
        }
        this.lastHierarchyParentKeys = parentKeys;
        const dayLabels = [];
        for (let i = 0; i < dayCount; i += 1) {
            dayLabels.push(addDays(range.start, i));
        }
        const hasTasks = filteredRows.length > 0;
        const hasBars = rowsWithBars.some((row) => row.bar);
        const notice = hasTasks && !hasBars ? 'No scheduled tasks (missing start/end dates).' : null;
        const empty =
            !hasTasks && dated.length === 0
                ? {
                      title: 'No tasks available',
                      description: 'The selected projects do not have any tasks yet.',
                  }
                : null;

        const dateWindow = range?.start && range?.end ? summarizeRange(range.start, range.end, spansMultipleYears) : '';
        const visibleColumns = normalizeVisibleColumns(settings.visibleColumns);
        return {
            state: empty ? 'empty' : 'ready',
            empty,
            rows: visibleRows,
            dayLabels,
            gridWidth: Math.max(dayCount * settings.dayWidthPx, settings.dayWidthPx),
            dayWidth: settings.dayWidthPx,
            rowHeight: settings.rowHeightPx,
            minDayWidth: settings.minDayWidthPx,
            maxDayWidth: settings.maxDayWidthPx,
            zoomMode: settings.zoomMode,
            dayCount,
            notice,
            rangeLabel: dateWindow,
            visibleColumns,
            showBarLabels: !!settings.showBarLabels,
            highlightRows: !!settings.highlightRows,
            hierarchyEnabled: !!hierarchy.enabled,
            hierarchyLinkStyle: hierarchy.enabled ? settings.hierarchyLinkStyle : 'none',
        };
    }

    _normalizeItem(item, settings) {
        const task = item?.task || {};
        const projectId = item?.projectId || task?.project_id || '';
        const project = this.projectMap.get(projectId) || {};
        const dateRange = normalizeDateRange(task.start_date, task.end_date);
        const durationDays = dateRange.start && dateRange.end ? durationInDays(dateRange.start, dateRange.end) : null;
        const color = normalizeColor(task.color || project.color, settings.fallbackColor);
        return {
            projectId,
            taskId: task.id,
            taskKey: this._taskKey(projectId, task.id),
            title: task.title || '(Untitled task)',
            projectLabel: project.name || projectId || 'Project',
            startDate: dateRange.start,
            endDate: dateRange.end,
            durationDays,
            color,
            status: task.status || 'none',
            priority: task.priority || '',
            autoRollupDates: !!task.auto_rollup_dates,
            parentTaskId: task.parent_task_id || null,
            parentProjectId: task.parent_project_id || '',
            hasFullDateRange: !!(task.start_date && task.end_date),
        };
    }
}

export function initTimelineController(options = {}) {
    return new TimelineController().init(options);
}
