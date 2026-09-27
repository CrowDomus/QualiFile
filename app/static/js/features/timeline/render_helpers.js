import { formatDayLabel } from './dates.js';
import { warnDiagnostic } from '../../shared/diagnostics.js';

const BAR_HEIGHT = 18;
const DRAG_THRESHOLD_PX = 5;
const SCROLL_SYNC_DEBOUNCE = 16;
const TIMELINE_LAYOUT_TOLERANCE_PX = 1;

const COLUMN_DEFS = [
  { key: 'task', label: 'Task', template: 'minmax(220px, 2.4fr)', className: 'timeline-cell-task' },
  {
    key: 'project',
    label: 'Project',
    template: 'minmax(130px, 1.3fr)',
    className: 'timeline-cell-project',
  },
  { key: 'start', label: 'Start', template: 'minmax(100px, 1fr)', className: 'timeline-cell-date' },
  { key: 'end', label: 'End', template: 'minmax(100px, 1fr)', className: 'timeline-cell-date' },
  {
    key: 'duration',
    label: 'Duration',
    template: 'minmax(90px, 0.9fr)',
    className: 'timeline-cell-duration',
  },
];

function pickColumns(visibility = {}) {
  return COLUMN_DEFS.filter((col) => col.key === 'task' || visibility[col.key] !== false);
}

function columnTemplate(columns) {
  return columns.map((col) => col.template).join(' ') || '1fr';
}

function makeTaskKey(projectId, taskId) {
  return `${projectId || ''}::${taskId || ''}`;
}

function escapeSelector(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(String(value));
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function toISO(date) {
  if (!date) return '';
  return date.toISOString().slice(0, 10);
}

function parseISODate(value) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function getBarOffsetDays(barEl, fallback = 0) {
  const raw = barEl.style.getPropertyValue('--bar-offset-days');
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getBarSpanDays(barEl, fallback = 1) {
  const raw = barEl.style.getPropertyValue('--bar-span-days');
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function setBarCanonicalDates(barEl, startDate, endDate) {
  const startIso = toISO(startDate);
  const endIso = toISO(endDate);
  if (startIso) {
    barEl.dataset.startIso = startIso;
  } else {
    delete barEl.dataset.startIso;
  }
  if (endIso) {
    barEl.dataset.endIso = endIso;
  } else {
    delete barEl.dataset.endIso;
  }
}

function getBarCanonicalDates(barEl, row) {
  const startIso = barEl.dataset.startIso;
  const endIso = barEl.dataset.endIso;
  return {
    startDate: parseISODate(startIso) || row.startDate || null,
    endDate: parseISODate(endIso) || row.endDate || null,
  };
}

function isBarPersisting(barEl) {
  return barEl.dataset.persisting === '1';
}

function setBarPersisting(barEl, value) {
  if (value) {
    barEl.dataset.persisting = '1';
  } else {
    delete barEl.dataset.persisting;
  }
}

function applySelection(rootEl, selectedKeys) {
  if (!rootEl) return;
  const keys = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys || []);
  rootEl.querySelectorAll('.timeline-table-row[data-task-key]').forEach((row) => {
    row.classList.toggle('is-selected', keys.has(row.dataset.taskKey));
  });
  rootEl.querySelectorAll('.timeline-bar[data-task-key]').forEach((bar) => {
    bar.classList.toggle('is-selected', keys.has(bar.dataset.taskKey));
  });
}

function isTimelineDebugEnabled() {
  return typeof window !== 'undefined' && window.__QUALIFILE_DEBUG_TIMELINE__ === true;
}

function attachTimelineLayoutDiagnostics({
  rootEl,
  headerEl,
  headScrollEl,
  gridScrollEl,
  rowCount,
  prevHeaderHeight,
  prevRowCount,
}) {
  if (!isTimelineDebugEnabled()) return () => {};
  if (!rootEl || !headerEl || !headScrollEl) return () => {};

  const logWarn = () => warnDiagnostic('TimelineLayoutWarning');

  let warnedWheel = false;
  const rafId = requestAnimationFrame(() => {
    const headerHeight = headerEl.getBoundingClientRect().height;
    if (Number.isFinite(headerHeight)) {
      rootEl.dataset.timelineHeaderHeight = String(headerHeight);
    }
    rootEl.dataset.timelineRowCount = String(rowCount);

    if (
      Number.isFinite(prevHeaderHeight) &&
      Number.isFinite(prevRowCount) &&
      prevRowCount !== rowCount
    ) {
      if (Math.abs(prevHeaderHeight - headerHeight) > TIMELINE_LAYOUT_TOLERANCE_PX) {
        logWarn('Header height changed after rerender.', {
          prevHeaderHeight,
          headerHeight,
          prevRowCount,
          rowCount,
        });
      }
    }

    const computed = window.getComputedStyle(headScrollEl);
    const overflowX = computed.overflowX;
    const overflowY = computed.overflowY;
    const scrollbarHeight = headScrollEl.offsetHeight - headScrollEl.clientHeight;
    if (overflowX !== 'hidden' && overflowX !== 'clip') {
      logWarn('Header scroll container allows horizontal overflow.', { overflowX });
    }
    if (overflowY !== 'hidden' && overflowY !== 'clip') {
      logWarn('Header scroll container allows vertical overflow.', { overflowY });
    }
    if (scrollbarHeight > TIMELINE_LAYOUT_TOLERANCE_PX) {
      logWarn('Header scroll container shows a horizontal scrollbar.', { scrollbarHeight });
    }
  });

  const onWheel = (event) => {
    if (warnedWheel) return;
    const hasHorizontal = Math.abs(event.deltaX) > 0.5 || event.shiftKey;
    if (!hasHorizontal) return;
    const beforeHead = headScrollEl.scrollLeft;
    const beforeGrid = gridScrollEl ? gridScrollEl.scrollLeft : beforeHead;
    requestAnimationFrame(() => {
      const afterHead = headScrollEl.scrollLeft;
      const afterGrid = gridScrollEl ? gridScrollEl.scrollLeft : beforeGrid;
      const headDelta = Math.abs(afterHead - beforeHead);
      const gridDelta = Math.abs(afterGrid - beforeGrid);
      if (headDelta > 0.5 && gridDelta <= 0.5) {
        warnedWheel = true;
        logWarn('Header scroll container changed scrollLeft from wheel input.', {
          beforeHead,
          afterHead,
        });
      }
    });
  };
  headScrollEl.addEventListener('wheel', onWheel, { passive: true });

  return () => {
    cancelAnimationFrame(rafId);
    headScrollEl.removeEventListener('wheel', onWheel);
  };
}

function buildHierarchyIndex(rows = []) {
  const descendantsByKey = new Map();
  const rangeByKey = new Map();
  const stack = [];
  rows.forEach((row, index) => {
    const depth = Number.isFinite(row.depth) ? row.depth : 0;
    const key = row.taskKey || makeTaskKey(row.projectId, row.taskId);
    row.taskKey = key;
    if (!key || key === '::') return;
    while (stack.length > depth) {
      stack.pop();
    }
    stack.forEach((ancestor) => {
      if (!descendantsByKey.has(ancestor.key)) {
        descendantsByKey.set(ancestor.key, new Set());
      }
      descendantsByKey.get(ancestor.key).add(key);
      const range = rangeByKey.get(ancestor.key);
      if (range) {
        range.lastDescendantIndex = index;
        if (range.firstChildIndex === null) {
          range.firstChildIndex = index;
        }
      }
    });
    if (row.hasChildren) {
      if (!descendantsByKey.has(key)) {
        descendantsByKey.set(key, new Set());
      }
      if (!rangeByKey.has(key)) {
        rangeByKey.set(key, {
          parentIndex: index,
          firstChildIndex: null,
          lastDescendantIndex: index,
        });
      }
      stack.push({ key, depth });
    }
  });
  return { descendantsByKey, rangeByKey };
}

function buildEmptyState(message) {
  const wrapper = document.createElement('div');
  wrapper.className = 'timeline-empty';
  const title = document.createElement('div');
  title.className = 'timeline-empty-title';
  title.textContent = message?.title || 'Nothing to show';
  wrapper.appendChild(title);
  if (message?.description) {
    const desc = document.createElement('p');
    desc.className = 'timeline-empty-desc';
    desc.textContent = message.description;
    wrapper.appendChild(desc);
  }
  return wrapper;
}

function buildStatus(message, tone = 'muted') {
  const el = document.createElement('div');
  el.className = `timeline-status timeline-status-${tone}`;
  el.textContent = message || '';
  return el;
}

function buildTableHeader(columns, template) {
  const row = document.createElement('div');
  row.className = 'timeline-table-row timeline-table-head';
  row.style.gridTemplateColumns = template;
  columns.forEach((col) => {
    const cell = document.createElement('div');
    cell.className = `timeline-cell ${col.className || ''}`.trim();
    cell.textContent = col.label;
    row.appendChild(cell);
  });
  return row;
}

function buildTableRow(
  row,
  columns,
  template,
  handlers,
  highlightRows,
  rootEl,
  hierarchyEnabled = false
) {
  const el = document.createElement('div');
  el.className = 'timeline-table-row';
  el.style.gridTemplateColumns = template;
  el.dataset.projectId = row.projectId || '';
  el.dataset.taskId = row.taskId || '';
  const taskKey = row.taskKey || makeTaskKey(row.projectId, row.taskId);
  el.dataset.taskKey = taskKey;
  if (highlightRows && row.highlightColor) {
    el.classList.add('timeline-row-highlight');
    el.style.setProperty('--timeline-row-color', row.highlightColor);
  }
  columns.forEach((col) => {
    const cell = document.createElement('div');
    cell.className = `timeline-cell ${col.className || ''}`.trim();
    switch (col.key) {
      case 'task': {
        const normalizeToken = (value, fallback = '') => {
          const str = (value ?? '').toString().trim();
          if (!str) return fallback;
          return str.replace(/\s+/g, '_').toLowerCase();
        };
        const humanize = (value) => {
          const str = (value ?? '').toString();
          return str ? str.replace(/_/g, ' ') : '';
        };
        const statusValue = normalizeToken(row.status, 'none');
        const priorityValue = normalizeToken(row.priority, '');
        const statusLabelMap = { none: 'None', in_progress: 'In progress', closed: 'Closed' };
        const priorityLabelMap = { '': 'None', low: 'Low', medium: 'Medium', high: 'High' };
        const statusLabel = Object.prototype.hasOwnProperty.call(statusLabelMap, statusValue)
          ? statusLabelMap[statusValue]
          : humanize(statusValue || 'none');
        const priorityLabel = Object.prototype.hasOwnProperty.call(priorityLabelMap, priorityValue)
          ? priorityLabelMap[priorityValue]
          : humanize(priorityValue || 'none');
        const tooltip = `Status: ${statusLabel} • Priority: ${priorityLabel}`;

        const main = document.createElement('div');
        main.className = 'timeline-task-main';
        main.title = tooltip;

        const depth = Number.isFinite(row.depth) ? row.depth : 0;
        const indentStepPx = 18;
        const isHierarchyMode = hierarchyEnabled === true;
        const needsTree = isHierarchyMode || depth > 0 || row.hasChildren || row.hierarchyHint;
        if (needsTree) {
          main.classList.add('is-hierarchy-row');
          const tree = document.createElement('div');
          tree.className = 'timeline-task-tree';

          const indent = document.createElement('span');
          indent.className = 'timeline-task-indent';
          indent.style.width = `${Math.max(0, depth) * indentStepPx}px`;
          tree.appendChild(indent);

          if (row.hasChildren) {
            const caret = document.createElement('button');
            caret.type = 'button';
            caret.className = 'timeline-tree-caret';
            caret.setAttribute(
              'aria-label',
              row.isCollapsed ? 'Expand task children' : 'Collapse task children'
            );
            caret.setAttribute('aria-expanded', row.isCollapsed ? 'false' : 'true');
            caret.textContent = row.isCollapsed ? '+' : '-';
            caret.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (rootEl) {
                const tableScroll = rootEl.querySelector('.timeline-table');
                if (tableScroll) {
                  // Anchor in scroll content space to avoid subpixel drift.
                  const deltaY = el.offsetTop - tableScroll.scrollTop;
                  rootEl.dataset.timelineAnchorKey = taskKey;
                  rootEl.dataset.timelineAnchorDeltaY = String(deltaY);
                }
              }
              if (typeof handlers?.onToggleRowCollapsed === 'function') {
                handlers.onToggleRowCollapsed(taskKey);
              }
            });
            tree.appendChild(caret);
          } else {
            const caretSlot = document.createElement('span');
            caretSlot.className = 'timeline-tree-caret-placeholder';
            tree.appendChild(caretSlot);
          }

          if (row.hierarchyHint) {
            const hint = document.createElement('span');
            hint.className = 'timeline-tree-hint';
            hint.title = row.hierarchyHint;
            hint.textContent = '!';
            tree.appendChild(hint);
          } else if (isHierarchyMode) {
            const hintSlot = document.createElement('span');
            hintSlot.className = 'timeline-tree-hint-placeholder';
            hintSlot.setAttribute('aria-hidden', 'true');
            tree.appendChild(hintSlot);
          }

          main.appendChild(tree);
        }

        const icons = document.createElement('span');
        icons.className = 'timeline-task-icons';
        icons.setAttribute('aria-hidden', 'true');

        const statusIcon = document.createElement('span');
        statusIcon.className = `timeline-task-icon timeline-task-status status-${statusValue || 'none'}`;
        statusIcon.textContent = '●';
        icons.appendChild(statusIcon);

        const priorityIcon = document.createElement('span');
        priorityIcon.className = `timeline-task-icon timeline-task-priority priority-${priorityValue || 'none'}`;
        priorityIcon.textContent = '⚑';
        icons.appendChild(priorityIcon);

        const title = document.createElement('div');
        title.className = 'timeline-task-title';
        title.textContent = row.title || 'Untitled task';

        main.appendChild(icons);
        main.appendChild(title);
        cell.appendChild(main);
        break;
      }
      case 'project':
        cell.textContent = row.projectLabel || '';
        break;
      case 'start':
        cell.textContent = row.startText || '—';
        break;
      case 'end':
        cell.textContent = row.endText || '—';
        break;
      case 'duration':
        cell.textContent = row.durationText || '—';
        break;
      default:
        cell.textContent = '';
        break;
    }
    el.appendChild(cell);
  });
  if (handlers) {
    el.addEventListener('click', (event) => {
      const toggle = event.metaKey || event.ctrlKey;
      if (typeof handlers.onSelectTask === 'function') {
        handlers.onSelectTask({ projectId: row.projectId, taskId: row.taskId, toggle });
        applySelection(rootEl, handlers.getSelectedTaskKeys?.());
      }
      if (toggle) return;
      const shouldOpen =
        typeof handlers.shouldOpenTaskOnClick === 'function'
          ? handlers.shouldOpenTaskOnClick()
          : false;
      if (!shouldOpen) return;
      if (event.target.closest('button, a, input, select, textarea')) return;
      if (typeof handlers.onOpenTask === 'function') {
        handlers.onOpenTask({ projectId: row.projectId, taskId: row.taskId });
      }
    });
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const toggle = event.metaKey || event.ctrlKey;
      if (typeof handlers.onSelectTask === 'function') {
        handlers.onSelectTask({ projectId: row.projectId, taskId: row.taskId, toggle });
        applySelection(rootEl, handlers.getSelectedTaskKeys?.());
      }
      if (typeof handlers.onTaskContextMenu === 'function') {
        handlers.onTaskContextMenu({
          projectId: row.projectId,
          taskId: row.taskId,
          x: event.clientX,
          y: event.clientY,
        });
      }
    });
  }
  return el;
}

function buildDayHeader(labels, gridWidth, options = {}) {
  const { weekendIndexSet = new Set(), todayIndex = null } = options || {};
  const scroll = document.createElement('div');
  scroll.className = 'timeline-head-grid-scroll';
  const row = document.createElement('div');
  row.className = 'timeline-head-grid';
  labels.forEach((label) => {
    const cell = document.createElement('div');
    cell.className = 'timeline-day-label';
    const index = row.childElementCount;
    if (weekendIndexSet.has(index)) {
      cell.classList.add('is-weekend');
    }
    const formatted = formatDayLabel(label) || '';
    const monthText = label
      ? label.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }).toUpperCase()
      : '';
    const dayText = label ? label.getUTCDate() : '';
    const month = document.createElement('span');
    month.className = 'timeline-day-month';
    month.textContent = monthText;
    const day = document.createElement('span');
    day.className = 'timeline-day-number';
    day.textContent = dayText;
    cell.title = formatted;
    cell.appendChild(day);
    cell.appendChild(month);
    row.appendChild(cell);
  });
  if (Number.isInteger(todayIndex) && todayIndex >= 0 && todayIndex < labels.length) {
    const todayLine = document.createElement('div');
    todayLine.className = 'timeline-today-line';
    todayLine.style.left = `calc(${todayIndex} * var(--timeline-day-width))`;
    row.appendChild(todayLine);
  }
  scroll.appendChild(row);
  return { container: scroll, track: row };
}

export {
  BAR_HEIGHT,
  DRAG_THRESHOLD_PX,
  SCROLL_SYNC_DEBOUNCE,
  TIMELINE_LAYOUT_TOLERANCE_PX,
  applySelection,
  attachTimelineLayoutDiagnostics,
  buildDayHeader,
  buildEmptyState,
  buildHierarchyIndex,
  buildStatus,
  buildTableHeader,
  buildTableRow,
  columnTemplate,
  escapeSelector,
  getBarCanonicalDates,
  getBarOffsetDays,
  getBarSpanDays,
  isBarPersisting,
  isTimelineDebugEnabled,
  makeTaskKey,
  pickColumns,
  setBarCanonicalDates,
  setBarPersisting,
  toISO,
};
