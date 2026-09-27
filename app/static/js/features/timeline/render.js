import { addDays, todayUtc, daysBetween } from './dates.js';
import { attachTimelineSizer } from './sizing.js';
import {
  BAR_HEIGHT,
  DRAG_THRESHOLD_PX,
  SCROLL_SYNC_DEBOUNCE,
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
} from './render_helpers.js';

const TIMELINE_LEFT_MIN_WIDTH = 320;
const TIMELINE_RIGHT_MIN_WIDTH = 300;
const TIMELINE_LEFT_RESIZE_STEP = 12;

function parseNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getTimelineColumnGapPx(element) {
  if (!element) return 0;
  const style = getComputedStyle(element);
  const raw = style.columnGap || style.gap || style.gridColumnGap || '0';
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getTimelineResizeMetrics(rootEl) {
  const shell = rootEl?.querySelector('.timeline-shell');
  if (!shell) return null;
  const width = shell.getBoundingClientRect().width;
  if (!Number.isFinite(width) || width <= 0) return null;
  const body = rootEl.querySelector('.timeline-body') || rootEl.querySelector('.timeline-header');
  const gap = getTimelineColumnGapPx(body);
  return { width, gap };
}

function getTimelineLeftColumnWidth(rootEl) {
  const table =
    rootEl?.querySelector('.timeline-table') ||
    rootEl?.querySelector('.timeline-table-head-wrapper');
  const width = table?.getBoundingClientRect().width;
  return Number.isFinite(width) && width > 0 ? width : null;
}

function clampTimelineLeftWidth(rootEl, desiredWidth) {
  const requested = parseNumber(desiredWidth);
  if (requested === null) return null;
  const metrics = getTimelineResizeMetrics(rootEl);
  if (!metrics) return Math.round(requested);
  const maxLeftRaw = metrics.width - metrics.gap - TIMELINE_RIGHT_MIN_WIDTH;
  const maxLeft = Number.isFinite(maxLeftRaw) ? maxLeftRaw : metrics.width;
  if (maxLeft < TIMELINE_LEFT_MIN_WIDTH) {
    return Math.round(Math.max(0, maxLeft));
  }
  const clamped = Math.min(Math.max(requested, TIMELINE_LEFT_MIN_WIDTH), maxLeft);
  return Math.round(clamped);
}

function buildBarLayer(rows, gridWidth, rowHeight, options = {}) {
  const {
    onOpenTask,
    onMoveTaskDates,
    onResizeTaskDates,
    onErrorToast,
    rootEl,
    handlers,
    showLabels = false,
    highlightRows = false,
    weekendIndices = [],
    todayIndex = null,
    dayCount = 0,
  } = options;
  const barCleanups = [];
  const scroll = document.createElement('div');
  scroll.className = 'timeline-grid-scroll';
  const layer = document.createElement('div');
  layer.className = 'timeline-grid-layer';
  layer.style.height = `${Math.max(rows.length * rowHeight, rowHeight)}px`;
  layer.style.minHeight = '100%';

  const weekendLayer = document.createElement('div');
  weekendLayer.className = 'timeline-grid-weekends';
  if (Array.isArray(weekendIndices)) {
    weekendIndices.forEach((index) => {
      if (!Number.isInteger(index) || index < 0 || index >= dayCount) return;
      const weekend = document.createElement('div');
      weekend.className = 'timeline-grid-weekend';
      weekend.style.left = `calc(${index} * var(--timeline-day-width))`;
      weekendLayer.appendChild(weekend);
    });
  }
  layer.appendChild(weekendLayer);

  const highlights = document.createElement('div');
  highlights.className = 'timeline-grid-highlights';
  layer.appendChild(highlights);

  if (highlightRows) {
    rows.forEach((row, index) => {
      if (!row.highlightColor) return;
      const stripe = document.createElement('div');
      stripe.className = 'timeline-grid-highlight';
      stripe.style.top = `${index * rowHeight}px`;
      stripe.style.height = `${rowHeight}px`;
      stripe.style.setProperty('--timeline-row-color', row.highlightColor);
      highlights.appendChild(stripe);
    });
  }

  rows.forEach((row, index) => {
    if (!row.bar) return;
    const bar = document.createElement('div');
    bar.className = 'timeline-bar';
    bar.style.setProperty('--bar-offset-days', row.bar.offsetDays || 0);
    bar.style.setProperty('--bar-span-days', row.bar.spanDays || 1);
    bar.style.top = `${index * rowHeight + (rowHeight - BAR_HEIGHT) / 2}px`;
    const isAutoLocked = !!row.isAutoLocked;
    if (isAutoLocked) {
      bar.classList.add('timeline-bar-auto-rollup');
      bar.style.setProperty('--timeline-rollup-color', row.bar.color || '');
      if (row.bar.startDate && row.bar.endDate) {
        bar.title = `Auto-synced from children: ${toISO(row.bar.startDate)} -> ${toISO(row.bar.endDate)}`;
      } else {
        bar.title = 'Auto-synced from children';
      }
    } else {
      bar.style.backgroundColor = row.bar.color;
      bar.title = row.title || 'Task';
    }
    bar.dataset.projectId = row.projectId || '';
    bar.dataset.taskId = row.taskId || '';
    bar.dataset.taskKey = row.taskKey || makeTaskKey(row.projectId, row.taskId);
    const onContextMenu = (event) => {
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
    };
    bar.addEventListener('contextmenu', onContextMenu);
    barCleanups.push(() => bar.removeEventListener('contextmenu', onContextMenu));
    // Preserve canonical dates for repeated drags/resizes before re-render.
    setBarCanonicalDates(bar, row.bar.startDate || row.startDate, row.bar.endDate || row.endDate);
    if (isAutoLocked) {
      const onRollupClick = (event) => {
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
        if (typeof handlers.onOpenTask === 'function') {
          handlers.onOpenTask({ projectId: row.projectId, taskId: row.taskId });
        }
      };
      bar.addEventListener('click', onRollupClick);
      barCleanups.push(() => bar.removeEventListener('click', onRollupClick));
    } else {
      const handleLeft = document.createElement('div');
      handleLeft.className = 'timeline-bar-handle timeline-bar-handle-left';
      handleLeft.dataset.handle = 'start';
      const handleRight = document.createElement('div');
      handleRight.className = 'timeline-bar-handle timeline-bar-handle-right';
      handleRight.dataset.handle = 'end';
      bar.appendChild(handleLeft);
      bar.appendChild(handleRight);
    }
    if (showLabels && row.bar.label) {
      const label = document.createElement('span');
      label.className = 'timeline-bar-label';
      label.textContent = row.bar.label;
      bar.appendChild(label);
    }
    if (!isAutoLocked) {
      const dragCleanup = attachBarDrag({
        rootEl,
        scrollEl: scroll,
        barEl: bar,
        row,
        handlers: handlers || { onOpenTask, onMoveTaskDates, onErrorToast },
      });
      barCleanups.push(dragCleanup);
      const resizeCleanup = attachBarResize({
        rootEl,
        scrollEl: scroll,
        barEl: bar,
        row,
        handlers: handlers || { onResizeTaskDates, onErrorToast },
        handleLeftEl: bar.querySelector('.timeline-bar-handle-left'),
        handleRightEl: bar.querySelector('.timeline-bar-handle-right'),
      });
      barCleanups.push(resizeCleanup);
    }
    layer.appendChild(bar);
  });
  if (Number.isInteger(todayIndex) && todayIndex >= 0 && todayIndex < dayCount) {
    const todayLine = document.createElement('div');
    todayLine.className = 'timeline-today-line';
    todayLine.style.left = `calc(${todayIndex} * var(--timeline-day-width))`;
    layer.appendChild(todayLine);
  }
  scroll.appendChild(layer);
  return { container: scroll, layer, highlights, cleanups: barCleanups };
}

function attachBarDrag({ rootEl, scrollEl, barEl, row, handlers = {} }) {
  if (!rootEl || !scrollEl || !barEl || !row?.startDate || !row?.endDate) {
    return () => {};
  }

  let activePointerId = null;
  let startClientX = 0;
  let originalOffsetDays = 0;
  let originalScrollLeft = 0;
  let baseStartDate = null;
  let baseEndDate = null;
  let isDragging = false;
  let hasMoved = false;
  let scrollLockHandler = null;
  let allowOpenOnClick = true;

  const getDayWidth = () => {
    const raw = getComputedStyle(rootEl).getPropertyValue('--timeline-day-width');
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
  };

  const lockScroll = () => {
    if (scrollLockHandler) return;
    scrollLockHandler = () => {
      scrollEl.scrollLeft = originalScrollLeft;
    };
    scrollEl.addEventListener('scroll', scrollLockHandler, { passive: true });
  };

  const unlockScroll = () => {
    if (!scrollLockHandler) return;
    scrollEl.removeEventListener('scroll', scrollLockHandler);
    scrollLockHandler = null;
  };

  const resetDragStyles = () => {
    barEl.classList.remove('is-dragging');
    rootEl.classList.remove('timeline-bar-dragging');
  };

  const setOffset = (value) => {
    barEl.style.setProperty('--bar-offset-days', String(value));
  };

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    if (event.pointerType === 'touch') return;
    if (isBarPersisting(barEl)) return;
    if (event.target.closest('.timeline-bar-handle')) return;
    event.stopPropagation();
    event.preventDefault();
    const toggle = event.metaKey || event.ctrlKey;
    const shouldOpen =
      typeof handlers.shouldOpenTaskOnClick === 'function'
        ? handlers.shouldOpenTaskOnClick()
        : false;
    allowOpenOnClick = !toggle && shouldOpen;
    if (typeof handlers.onSelectTask === 'function') {
      handlers.onSelectTask({ projectId: row.projectId, taskId: row.taskId, toggle });
      applySelection(rootEl, handlers.getSelectedTaskKeys?.());
    }

    activePointerId = event.pointerId;
    startClientX = event.clientX;
    originalOffsetDays = getBarOffsetDays(barEl, row.bar?.offsetDays || 0);
    originalScrollLeft = scrollEl.scrollLeft;
    // Capture baseline from the bar element to avoid stale model values.
    const canonical = getBarCanonicalDates(barEl, row);
    baseStartDate = canonical.startDate;
    baseEndDate = canonical.endDate;
    isDragging = false;
    hasMoved = false;
    if (barEl.setPointerCapture) {
      barEl.setPointerCapture(event.pointerId);
    }
  };

  const onPointerMove = (event) => {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    const deltaPx = event.clientX - startClientX + (scrollEl.scrollLeft - originalScrollLeft);
    if (!isDragging && Math.abs(deltaPx) >= DRAG_THRESHOLD_PX) {
      isDragging = true;
      rootEl.classList.add('timeline-bar-dragging');
      barEl.classList.add('is-dragging');
      lockScroll();
    }
    if (!isDragging) return;
    hasMoved = true;
    const dayWidth = getDayWidth();
    if (event.shiftKey) {
      const deltaDaysFloat = deltaPx / dayWidth;
      setOffset(originalOffsetDays + deltaDaysFloat);
    } else {
      const deltaDaysPreview = Math.round(deltaPx / dayWidth);
      setOffset(originalOffsetDays + deltaDaysPreview);
    }
    event.preventDefault();
  };

  const finalizeDrag = async (deltaPx, dayWidth) => {
    const deltaDaysFinal = Math.round(deltaPx / dayWidth);
    if (deltaDaysFinal === 0) {
      setOffset(originalOffsetDays);
      return;
    }
    const newStart = addDays(baseStartDate || row.startDate, deltaDaysFinal);
    const newEnd = addDays(baseEndDate || row.endDate, deltaDaysFinal);
    setOffset(originalOffsetDays + deltaDaysFinal);
    try {
      setBarPersisting(barEl, true);
      if (typeof handlers.onMoveTaskDates === 'function') {
        await handlers.onMoveTaskDates({
          projectId: row.projectId,
          taskId: row.taskId,
          startDate: newStart,
          endDate: newEnd,
          deltaDays: deltaDaysFinal,
        });
      }
      // Update canonical dates after persistence for repeat interactions.
      setBarCanonicalDates(barEl, newStart, newEnd);
      if (row.bar) {
        row.bar.offsetDays = originalOffsetDays + deltaDaysFinal;
      }
      row.startDate = newStart;
      row.endDate = newEnd;
    } catch (error) {
      setOffset(originalOffsetDays);
      const message = error?.message || 'Could not update task dates.';
      if (typeof handlers.onErrorToast === 'function') {
        handlers.onErrorToast(message);
      }
      throw error;
    } finally {
      setBarPersisting(barEl, false);
    }
  };

  const onPointerUp = (event) => {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    if (barEl.releasePointerCapture) {
      barEl.releasePointerCapture(event.pointerId);
    }
    const deltaPx = event.clientX - startClientX + (scrollEl.scrollLeft - originalScrollLeft);
    const dayWidth = getDayWidth();
    activePointerId = null;
    unlockScroll();
    resetDragStyles();

    if (!hasMoved || Math.abs(deltaPx) < DRAG_THRESHOLD_PX) {
      setOffset(originalOffsetDays);
      if (allowOpenOnClick && typeof handlers.onOpenTask === 'function') {
        handlers.onOpenTask({ projectId: row.projectId, taskId: row.taskId });
      }
      return;
    }

    void finalizeDrag(deltaPx, dayWidth).catch(() => {});
  };

  const onPointerCancel = (event) => {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    if (barEl.releasePointerCapture) {
      barEl.releasePointerCapture(event.pointerId);
    }
    activePointerId = null;
    unlockScroll();
    resetDragStyles();
    setOffset(originalOffsetDays);
  };

  barEl.addEventListener('pointerdown', onPointerDown);
  barEl.addEventListener('pointermove', onPointerMove);
  barEl.addEventListener('pointerup', onPointerUp);
  barEl.addEventListener('pointercancel', onPointerCancel);

  return () => {
    barEl.removeEventListener('pointerdown', onPointerDown);
    barEl.removeEventListener('pointermove', onPointerMove);
    barEl.removeEventListener('pointerup', onPointerUp);
    barEl.removeEventListener('pointercancel', onPointerCancel);
    unlockScroll();
    resetDragStyles();
  };
}

function attachBarResize({
  rootEl,
  scrollEl,
  barEl,
  row,
  handlers = {},
  handleLeftEl,
  handleRightEl,
}) {
  if (!rootEl || !scrollEl || !barEl || !row?.startDate || !row?.endDate) {
    return () => {};
  }
  const leftHandle = handleLeftEl || barEl.querySelector('[data-handle="start"]');
  const rightHandle = handleRightEl || barEl.querySelector('[data-handle="end"]');
  if (!leftHandle || !rightHandle) return () => {};

  let activePointerId = null;
  let activeEdge = null;
  let startClientX = 0;
  let originalOffsetDays = 0;
  let originalSpanDays = 1;
  let originalScrollLeft = 0;
  let baseStartDate = null;
  let baseEndDate = null;
  let isResizing = false;
  let hasMoved = false;
  let scrollLockHandler = null;

  const getDayWidth = () => {
    const raw = getComputedStyle(rootEl).getPropertyValue('--timeline-day-width');
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
  };

  const lockScroll = () => {
    if (scrollLockHandler) return;
    scrollLockHandler = () => {
      scrollEl.scrollLeft = originalScrollLeft;
    };
    scrollEl.addEventListener('scroll', scrollLockHandler, { passive: true });
  };

  const unlockScroll = () => {
    if (!scrollLockHandler) return;
    scrollEl.removeEventListener('scroll', scrollLockHandler);
    scrollLockHandler = null;
  };

  const formatPreviewDate = (date) => (date ? date.toISOString().slice(0, 10) : '');

  const setPreview = (startDate, endDate) => {
    barEl.dataset.resizePreview = `${formatPreviewDate(startDate)} -> ${formatPreviewDate(endDate)}`;
    barEl.classList.add('is-resizing');
    rootEl.classList.add('timeline-bar-resizing');
  };

  const clearPreview = () => {
    delete barEl.dataset.resizePreview;
    barEl.classList.remove('is-resizing');
    rootEl.classList.remove('timeline-bar-resizing');
  };

  const setOffsetAndSpan = (offsetDays, spanDays) => {
    barEl.style.setProperty('--bar-offset-days', String(offsetDays));
    barEl.style.setProperty('--bar-span-days', String(spanDays));
  };

  const clampDeltaDays = (deltaDays) => {
    if (activeEdge === 'start') {
      const maxDelta = originalSpanDays - 1;
      return Math.min(deltaDays, maxDelta);
    }
    const minDelta = -(originalSpanDays - 1);
    return Math.max(deltaDays, minDelta);
  };

  const applyResize = (deltaDays) => {
    const clamped = clampDeltaDays(deltaDays);
    const startBase = baseStartDate || row.startDate;
    const endBase = baseEndDate || row.endDate;
    if (activeEdge === 'start') {
      const newSpan = originalSpanDays - clamped;
      const newOffset = originalOffsetDays + clamped;
      setOffsetAndSpan(newOffset, newSpan);
      setPreview(addDays(startBase, clamped), endBase);
      return { newOffset, newSpan, deltaDays: clamped };
    }
    const newSpan = originalSpanDays + clamped;
    setOffsetAndSpan(originalOffsetDays, newSpan);
    setPreview(startBase, addDays(endBase, clamped));
    return { newOffset: originalOffsetDays, newSpan, deltaDays: clamped };
  };

  const resetToOriginal = () => {
    setOffsetAndSpan(originalOffsetDays, originalSpanDays);
    clearPreview();
  };

  const startResize = (event, edge) => {
    if (event.button !== 0) return;
    if (event.pointerType === 'touch') return;
    if (isBarPersisting(barEl)) return;
    event.preventDefault();
    event.stopPropagation();
    const toggle = event.metaKey || event.ctrlKey;
    if (typeof handlers.onSelectTask === 'function') {
      handlers.onSelectTask({ projectId: row.projectId, taskId: row.taskId, toggle });
      applySelection(rootEl, handlers.getSelectedTaskKeys?.());
    }
    activePointerId = event.pointerId;
    activeEdge = edge;
    startClientX = event.clientX;
    originalOffsetDays = getBarOffsetDays(barEl, row.bar?.offsetDays || 0);
    originalSpanDays = getBarSpanDays(barEl, row.bar?.spanDays || 1);
    originalScrollLeft = scrollEl.scrollLeft;
    // Capture baseline from the bar element to avoid stale model values.
    const canonical = getBarCanonicalDates(barEl, row);
    baseStartDate = canonical.startDate;
    baseEndDate = canonical.endDate;
    isResizing = true;
    hasMoved = false;
    if (event.currentTarget.setPointerCapture) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    lockScroll();
  };

  const onPointerMove = (event) => {
    if (!isResizing || activePointerId === null || event.pointerId !== activePointerId) return;
    const deltaPx = event.clientX - startClientX + (scrollEl.scrollLeft - originalScrollLeft);
    if (!hasMoved && Math.abs(deltaPx) >= DRAG_THRESHOLD_PX) {
      hasMoved = true;
    }
    const dayWidth = getDayWidth();
    const deltaDaysPreview = Math.round(deltaPx / dayWidth);
    applyResize(deltaDaysPreview);
    event.preventDefault();
  };

  const finalizeResize = async (deltaPx) => {
    const dayWidth = getDayWidth();
    const deltaDaysFinal = Math.round(deltaPx / dayWidth);
    const { deltaDays, newOffset, newSpan } = applyResize(deltaDaysFinal);
    if (deltaDays === 0) {
      resetToOriginal();
      return;
    }
    const startDate =
      activeEdge === 'start'
        ? addDays(baseStartDate || row.startDate, deltaDays)
        : baseStartDate || row.startDate;
    const endDate =
      activeEdge === 'end'
        ? addDays(baseEndDate || row.endDate, deltaDays)
        : baseEndDate || row.endDate;
    if (!startDate || !endDate || startDate.getTime() > endDate.getTime()) {
      resetToOriginal();
      return;
    }
    if (typeof handlers.onResizeTaskDates !== 'function') {
      resetToOriginal();
      if (typeof handlers.onErrorToast === 'function') {
        handlers.onErrorToast('Resize could not be saved (missing handler).');
      }
      return;
    }
    try {
      setBarPersisting(barEl, true);
      await handlers.onResizeTaskDates({
        projectId: row.projectId,
        taskId: row.taskId,
        startDate,
        endDate,
        edge: activeEdge,
      });
      // Update canonical dates after persistence for repeat interactions.
      setBarCanonicalDates(barEl, startDate, endDate);
      row.startDate = startDate;
      row.endDate = endDate;
      if (row.bar) {
        row.bar.offsetDays = newOffset;
        row.bar.spanDays = newSpan;
      }
    } catch (error) {
      resetToOriginal();
      const message = error?.message || 'Could not update task dates.';
      if (typeof handlers.onErrorToast === 'function') {
        handlers.onErrorToast(message);
      }
      throw error;
    } finally {
      setBarPersisting(barEl, false);
    }
    clearPreview();
  };

  const finishResize = (event) => {
    if (!isResizing || activePointerId === null || event.pointerId !== activePointerId) return;
    if (event.currentTarget.releasePointerCapture) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const deltaPx = event.clientX - startClientX + (scrollEl.scrollLeft - originalScrollLeft);
    activePointerId = null;
    isResizing = false;
    unlockScroll();
    if (!hasMoved || Math.abs(deltaPx) < DRAG_THRESHOLD_PX) {
      resetToOriginal();
      return;
    }
    void finalizeResize(deltaPx).catch(() => {});
  };

  const cancelResize = (event) => {
    if (!isResizing || activePointerId === null || event.pointerId !== activePointerId) return;
    if (event.currentTarget.releasePointerCapture) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activePointerId = null;
    isResizing = false;
    unlockScroll();
    resetToOriginal();
  };

  const onLeftDown = (event) => startResize(event, 'start');
  const onRightDown = (event) => startResize(event, 'end');

  leftHandle.addEventListener('pointerdown', onLeftDown);
  rightHandle.addEventListener('pointerdown', onRightDown);
  leftHandle.addEventListener('pointermove', onPointerMove);
  rightHandle.addEventListener('pointermove', onPointerMove);
  leftHandle.addEventListener('pointerup', finishResize);
  rightHandle.addEventListener('pointerup', finishResize);
  leftHandle.addEventListener('pointercancel', cancelResize);
  rightHandle.addEventListener('pointercancel', cancelResize);

  return () => {
    leftHandle.removeEventListener('pointerdown', onLeftDown);
    rightHandle.removeEventListener('pointerdown', onRightDown);
    leftHandle.removeEventListener('pointermove', onPointerMove);
    rightHandle.removeEventListener('pointermove', onPointerMove);
    leftHandle.removeEventListener('pointerup', finishResize);
    rightHandle.removeEventListener('pointerup', finishResize);
    leftHandle.removeEventListener('pointercancel', cancelResize);
    rightHandle.removeEventListener('pointercancel', cancelResize);
    unlockScroll();
    clearPreview();
  };
}

function attachRangeBrush({ rootEl, scrollEl, layerEl, dayCount, dayLabels, handlers = {} }) {
  if (!rootEl || !scrollEl || !layerEl || !Array.isArray(dayLabels) || dayCount <= 0) {
    return () => {};
  }

  const selection = document.createElement('div');
  selection.className = 'timeline-grid-selection d-none';
  layerEl.appendChild(selection);

  let isBrushing = false;
  let anchorIndex = null;
  let currentIndex = null;
  let popover = null;

  const getDayWidth = () => {
    const raw = getComputedStyle(rootEl).getPropertyValue('--timeline-day-width');
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  };

  const clampIndex = (value) => Math.min(dayCount - 1, Math.max(0, value));

  const getIndexFromEvent = (event) => {
    const scrollRect = scrollEl.getBoundingClientRect();
    const xContent = event.clientX - scrollRect.left + scrollEl.scrollLeft;
    return clampIndex(Math.floor(xContent / getDayWidth()));
  };

  const removePopover = () => {
    if (popover) {
      popover.remove();
      popover = null;
    }
  };

  const clearSelection = () => {
    isBrushing = false;
    anchorIndex = null;
    currentIndex = null;
    rootEl.classList.remove('is-brushing');
    selection.classList.add('d-none');
    selection.style.left = '';
    selection.style.width = '';
    removePopover();
  };

  const updateSelection = () => {
    if (anchorIndex === null || currentIndex === null) return null;
    const startIndex = Math.min(anchorIndex, currentIndex);
    const endIndex = Math.max(anchorIndex, currentIndex);
    selection.style.left = `calc(${startIndex} * var(--timeline-day-width))`;
    selection.style.width = `calc(${endIndex - startIndex + 1} * var(--timeline-day-width))`;
    selection.style.top = '0';
    selection.style.bottom = '0';
    selection.classList.remove('d-none');
    return { startIndex, endIndex };
  };

  const positionPopover = (startIndex, endIndex) => {
    if (!popover) return;
    const dayWidth = getDayWidth();
    const scrollRect = scrollEl.getBoundingClientRect();
    const scrollLeft = scrollEl.scrollLeft;
    const scrollTop = scrollEl.scrollTop;
    const centerContentPx = ((startIndex + endIndex + 1) / 2) * dayWidth;
    let centerViewportPx = centerContentPx - scrollLeft;
    const halfWidth = popover.offsetWidth / 2;
    const minCenter = 8 + halfWidth;
    const maxCenter = scrollRect.width - 8 - halfWidth;
    if (Number.isFinite(minCenter) && Number.isFinite(maxCenter) && maxCenter >= minCenter) {
      centerViewportPx = Math.min(Math.max(centerViewportPx, minCenter), maxCenter);
    }
    popover.style.left = `${centerViewportPx + scrollLeft}px`;
    popover.style.top = `${scrollTop + 8}px`;
    popover.style.transform = 'translateX(-50%)';
  };

  const showPopover = (startIndex, endIndex) => {
    removePopover();
    const startDate = dayLabels[startIndex];
    const endDate = dayLabels[endIndex];
    popover = document.createElement('div');
    popover.className = 'timeline-grid-selection-popover';

    const createButton = (label, onClick, options = {}) => {
      const { disabled = false, variant = 'secondary' } = options;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `btn btn-sm btn-${variant}`;
      button.textContent = label;
      button.disabled = disabled;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (disabled) return;
        onClick();
      });
      return button;
    };

    const focused =
      typeof handlers.getLastFocusedTask === 'function' ? handlers.getLastFocusedTask() : null;
    const focusedLocked =
      focused && typeof handlers.isTaskAutoLocked === 'function'
        ? handlers.isTaskAutoLocked(focused)
        : false;
    const createBtn = createButton(
      'Create task with these dates',
      () => {
        handlers.onCreateTaskFromRange?.({ startDate, endDate });
        clearSelection();
      },
      { variant: 'primary' }
    );
    const setDatesBtn = createButton(
      'Set dates for selected task',
      () => {
        handlers.onSetDatesForFocusedTask?.({ startDate, endDate });
        clearSelection();
      },
      { disabled: !focused || focusedLocked }
    );
    if (focusedLocked) {
      setDatesBtn.title = 'Dates are auto-synced from children.';
    }
    const cancelBtn = createButton('Cancel', () => clearSelection(), {
      variant: 'outline-secondary',
    });

    popover.append(createBtn, setDatesBtn, cancelBtn);
    popover.addEventListener('pointerdown', (event) => event.stopPropagation());
    popover.addEventListener('click', (event) => event.stopPropagation());
    scrollEl.appendChild(popover);

    requestAnimationFrame(() => positionPopover(startIndex, endIndex));
  };

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    if (event.pointerType === 'touch') return;
    if (popover && !popover.contains(event.target)) {
      clearSelection();
      return;
    }
    if (event.target.closest('.timeline-bar')) return;
    if (event.target.closest('.timeline-grid-selection-popover')) return;
    anchorIndex = getIndexFromEvent(event);
    currentIndex = anchorIndex;
    isBrushing = true;
    rootEl.classList.add('is-brushing');
    removePopover();
    updateSelection();
    if (scrollEl.setPointerCapture) {
      scrollEl.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
  };

  const onPointerMove = (event) => {
    if (!isBrushing) return;
    currentIndex = getIndexFromEvent(event);
    updateSelection();
    event.preventDefault();
  };

  const onPointerUp = (event) => {
    if (!isBrushing) return;
    if (scrollEl.releasePointerCapture) {
      scrollEl.releasePointerCapture(event.pointerId);
    }
    isBrushing = false;
    rootEl.classList.remove('is-brushing');
    currentIndex = getIndexFromEvent(event);
    const range = updateSelection();
    if (range) {
      showPopover(range.startIndex, range.endIndex);
    } else {
      clearSelection();
    }
  };

  const onPointerCancel = () => {
    if (!isBrushing) return;
    clearSelection();
  };

  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    if (!isBrushing && !popover) return;
    clearSelection();
  };

  const onScroll = () => {
    if (isBrushing || popover) {
      clearSelection();
    }
  };

  const onDocPointerDown = (event) => {
    if (!popover) return;
    if (popover.contains(event.target)) return;
    clearSelection();
  };

  scrollEl.addEventListener('pointerdown', onPointerDown);
  scrollEl.addEventListener('pointermove', onPointerMove);
  scrollEl.addEventListener('pointerup', onPointerUp);
  scrollEl.addEventListener('pointercancel', onPointerCancel);
  scrollEl.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('pointerdown', onDocPointerDown, { capture: true });

  return () => {
    scrollEl.removeEventListener('pointerdown', onPointerDown);
    scrollEl.removeEventListener('pointermove', onPointerMove);
    scrollEl.removeEventListener('pointerup', onPointerUp);
    scrollEl.removeEventListener('pointercancel', onPointerCancel);
    scrollEl.removeEventListener('scroll', onScroll);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('pointerdown', onDocPointerDown, { capture: true });
    clearSelection();
    selection.remove();
  };
}

export function renderTimeline(rootEl, viewModel, handlers = {}) {
  if (!rootEl) return () => {};
  rootEl.classList.add('timeline-root');
  const debugEnabled = isTimelineDebugEnabled();
  const prevHeaderHeight = debugEnabled
    ? Number.parseFloat(rootEl.dataset.timelineHeaderHeight)
    : Number.NaN;
  const prevRowCount = debugEnabled
    ? Number.parseInt(rootEl.dataset.timelineRowCount, 10)
    : Number.NaN;
  const captureScrollState = () => {
    const gridScroll = rootEl.querySelector('.timeline-grid-scroll');
    const headScroll = rootEl.querySelector('.timeline-head-grid-scroll');
    const tableScroll = rootEl.querySelector('.timeline-table');
    if (!gridScroll && !headScroll && !tableScroll) {
      return;
    }
    const scrollTopSource = gridScroll || tableScroll;
    const scrollLeftSource = gridScroll || headScroll;
    if (scrollTopSource) {
      rootEl.dataset.timelineScrollTop = String(scrollTopSource.scrollTop || 0);
    }
    if (scrollLeftSource) {
      rootEl.dataset.timelineScrollLeft = String(scrollLeftSource.scrollLeft || 0);
    }
  };
  captureScrollState();
  rootEl.innerHTML = '';
  const cleanups = [];

  const state = viewModel?.state || 'ready';
  if (state === 'loading') {
    rootEl.appendChild(buildStatus('Loading timeline...', 'muted'));
    return () => {};
  }
  if (state === 'error') {
    rootEl.appendChild(buildStatus(viewModel?.error || 'Unable to load timeline.', 'danger'));
    return () => {};
  }
  if (state === 'empty') {
    rootEl.appendChild(buildEmptyState(viewModel?.empty));
    return () => {};
  }

  const {
    rows = [],
    dayLabels = [],
    gridWidth = 0,
    dayWidth = 32,
    rowHeight = 44,
    minDayWidth = 8,
    maxDayWidth = 120,
    dayCount = dayLabels.length || 0,
    notice = null,
    visibleColumns = {},
    showBarLabels = false,
    highlightRows = false,
    zoomMode = 'fit',
    hierarchyEnabled = false,
    hierarchyLinkStyle = 'none',
  } = viewModel || {};

  const weekendIndices = [];
  let todayIndex = null;
  if (Array.isArray(dayLabels) && dayLabels.length > 0) {
    const rangeStart = dayLabels[0];
    const today = todayUtc();
    todayIndex = daysBetween(rangeStart, today);
    dayLabels.forEach((label, index) => {
      const day = label?.getUTCDay?.();
      if (day === 0 || day === 6) {
        weekendIndices.push(index);
      }
    });
  }
  const weekendIndexSet = new Set(weekendIndices);

  rootEl.style.setProperty('--timeline-day-width', `${dayWidth}px`);
  rootEl.style.setProperty('--timeline-day-count', `${dayCount}`);
  rootEl.dataset.timelineXScroll = 'on';
  rootEl.dataset.timelineZoomMode = zoomMode === 'manual' ? 'manual' : 'fit';
  rootEl.style.setProperty('--timeline-row-height', `${rowHeight}px`);

  const columns = pickColumns(visibleColumns);
  const template = columnTemplate(columns);

  const shell = document.createElement('div');
  shell.className = 'timeline-shell';

  const header = document.createElement('div');
  header.className = 'timeline-header';
  const leftHead = document.createElement('div');
  leftHead.className = 'timeline-table-head-wrapper';
  leftHead.appendChild(buildTableHeader(columns, template));
  const dayHead = buildDayHeader(dayLabels, gridWidth, {
    weekendIndexSet,
    todayIndex,
  });
  header.appendChild(leftHead);
  header.appendChild(dayHead.container);
  shell.appendChild(header);

  const body = document.createElement('div');
  body.className = 'timeline-body';
  const table = document.createElement('div');
  table.className = 'timeline-table';
  rows.forEach((row) =>
    table.appendChild(
      buildTableRow(row, columns, template, handlers, highlightRows, rootEl, hierarchyEnabled)
    )
  );
  body.appendChild(table);
  const bars = buildBarLayer(rows, gridWidth, rowHeight, {
    onOpenTask: handlers.onOpenTask,
    onMoveTaskDates: handlers.onMoveTaskDates,
    onResizeTaskDates: handlers.onResizeTaskDates,
    onErrorToast: handlers.onErrorToast,
    rootEl,
    handlers,
    showLabels: showBarLabels,
    highlightRows,
    weekendIndices,
    todayIndex,
    dayCount,
  });
  body.appendChild(bars.container);
  shell.appendChild(body);

  const linkStyle = hierarchyEnabled ? hierarchyLinkStyle : 'none';
  const hierarchyIndex = linkStyle !== 'none' ? buildHierarchyIndex(rows) : null;
  let subtreeTint = null;
  let subtreeHoverState = null;
  const subtreeCleanups = [];

  const updateScrollLeftVar = () => {
    if (!bars.container) return;
    rootEl.style.setProperty('--timeline-scroll-left-px', `${bars.container.scrollLeft || 0}px`);
  };
  updateScrollLeftVar();

  if (linkStyle === 'bracket' && hierarchyIndex?.rangeByKey?.size) {
    const connectors = document.createElement('div');
    connectors.className = 'timeline-subtree-connectors';
    hierarchyIndex.rangeByKey.forEach((range) => {
      if (!range || range.lastDescendantIndex <= range.parentIndex) return;
      const startY = range.parentIndex * rowHeight + rowHeight / 2;
      const height = (range.lastDescendantIndex - range.parentIndex) * rowHeight;
      if (height <= 0) return;
      const bracket = document.createElement('div');
      bracket.className = 'timeline-subtree-bracket';
      bracket.style.top = `${startY}px`;
      bracket.style.height = `${height}px`;
      connectors.appendChild(bracket);
    });
    bars.layer.appendChild(connectors);
  }

  if (linkStyle === 'hover' && hierarchyIndex?.descendantsByKey?.size) {
    const rowByKey = new Map();
    const barByKey = new Map();
    table.querySelectorAll('.timeline-table-row[data-task-key]').forEach((row) => {
      rowByKey.set(row.dataset.taskKey, row);
    });
    bars.layer.querySelectorAll('.timeline-bar[data-task-key]').forEach((bar) => {
      barByKey.set(bar.dataset.taskKey, bar);
    });
    subtreeTint = document.createElement('div');
    subtreeTint.className = 'timeline-subtree-tint';
    subtreeTint.style.display = 'none';
    bars.layer.appendChild(subtreeTint);

    const isHoverAllowed = () =>
      !rootEl.classList.contains('is-brushing') &&
      !rootEl.classList.contains('timeline-bar-dragging') &&
      !rootEl.classList.contains('timeline-bar-resizing');

    const clearSubtreeHover = () => {
      if (!subtreeHoverState) return;
      const { parentKey, descendants } = subtreeHoverState;
      rowByKey.get(parentKey)?.classList.remove('is-subtree-parent');
      barByKey.get(parentKey)?.classList.remove('is-subtree-parent');
      descendants.forEach((key) => {
        rowByKey.get(key)?.classList.remove('is-subtree-descendant');
        barByKey.get(key)?.classList.remove('is-subtree-descendant');
      });
      rootEl.classList.remove('timeline-subtree-hovering');
      if (subtreeTint) {
        subtreeTint.style.display = 'none';
      }
      subtreeHoverState = null;
    };

    const showSubtreeHover = (taskKey) => {
      if (!isHoverAllowed()) return;
      const descendants = hierarchyIndex.descendantsByKey.get(taskKey);
      if (!descendants || descendants.size === 0) return;
      if (subtreeHoverState?.parentKey === taskKey) return;
      clearSubtreeHover();
      const range = hierarchyIndex.rangeByKey.get(taskKey);
      rowByKey.get(taskKey)?.classList.add('is-subtree-parent');
      barByKey.get(taskKey)?.classList.add('is-subtree-parent');
      descendants.forEach((key) => {
        rowByKey.get(key)?.classList.add('is-subtree-descendant');
        barByKey.get(key)?.classList.add('is-subtree-descendant');
      });
      rootEl.classList.add('timeline-subtree-hovering');
      if (subtreeTint && range) {
        const startIndex = range.parentIndex;
        const endIndex = range.lastDescendantIndex;
        if (Number.isFinite(startIndex) && Number.isFinite(endIndex) && endIndex >= startIndex) {
          subtreeTint.style.display = 'block';
          subtreeTint.style.top = `${startIndex * rowHeight}px`;
          subtreeTint.style.height = `${(endIndex - startIndex + 1) * rowHeight}px`;
        } else {
          subtreeTint.style.display = 'none';
        }
      }
      subtreeHoverState = { parentKey: taskKey, descendants };
    };

    hierarchyIndex.rangeByKey.forEach((range, key) => {
      if (!range || range.lastDescendantIndex <= range.parentIndex) return;
      const rowEl = rowByKey.get(key);
      const barEl = barByKey.get(key);
      const onEnter = () => showSubtreeHover(key);
      const onLeave = () => clearSubtreeHover();
      if (rowEl) {
        rowEl.addEventListener('pointerenter', onEnter);
        rowEl.addEventListener('pointerleave', onLeave);
        subtreeCleanups.push(() => {
          rowEl.removeEventListener('pointerenter', onEnter);
          rowEl.removeEventListener('pointerleave', onLeave);
        });
      }
      if (barEl) {
        barEl.addEventListener('pointerenter', onEnter);
        barEl.addEventListener('pointerleave', onLeave);
        subtreeCleanups.push(() => {
          barEl.removeEventListener('pointerenter', onEnter);
          barEl.removeEventListener('pointerleave', onLeave);
        });
      }
    });

    if (bars.container) {
      const onPointerDown = () => clearSubtreeHover();
      bars.container.addEventListener('pointerdown', onPointerDown, { capture: true });
      subtreeCleanups.push(() =>
        bars.container.removeEventListener('pointerdown', onPointerDown, { capture: true })
      );
    }
    subtreeCleanups.push(() => clearSubtreeHover());
  }

  if (notice) {
    const banner = document.createElement('div');
    banner.className = 'timeline-notice';
    banner.textContent = notice;
    shell.appendChild(banner);
  }

  let isRestoringScroll = false;
  if (bars.container && dayHead.container) {
    const sync = () => {
      if (isRestoringScroll) return;
      if (rootEl.dataset.timelineXScroll === 'off') {
        if (bars.container.scrollLeft !== 0) bars.container.scrollLeft = 0;
        if (dayHead.container.scrollLeft !== 0) dayHead.container.scrollLeft = 0;
        updateScrollLeftVar();
        return;
      }
      dayHead.container.scrollLeft = bars.container.scrollLeft;
      updateScrollLeftVar();
    };
    bars.container.addEventListener('scroll', sync);
    cleanups.push(() => bars.container.removeEventListener('scroll', sync));
  }

  if (bars.container && table) {
    let isSyncing = false;
    let lastSync = 0;
    const syncVertical = (source, target) => {
      if (!target) return;
      if (isRestoringScroll) return;
      const now = performance.now();
      if (isSyncing || now - lastSync < SCROLL_SYNC_DEBOUNCE) return;
      isSyncing = true;
      lastSync = now;
      if (target.scrollTop !== source.scrollTop) {
        target.scrollTop = source.scrollTop;
      }
      requestAnimationFrame(() => {
        isSyncing = false;
      });
    };
    const onTableScroll = () => syncVertical(table, bars.container);
    const onGridScroll = () => syncVertical(bars.container, table);
    table.addEventListener('scroll', onTableScroll);
    bars.container.addEventListener('scroll', onGridScroll);
    cleanups.push(() => {
      table.removeEventListener('scroll', onTableScroll);
      bars.container.removeEventListener('scroll', onGridScroll);
    });
  }

  if (bars.container && typeof handlers.onClearTaskSelection === 'function') {
    const onGridPointerDown = (event) => {
      if (rootEl.classList.contains('is-brushing')) return;
      if (event.target.closest('.timeline-bar')) return;
      if (event.target.closest('.timeline-bar-handle')) return;
      if (event.target.closest('.timeline-grid-selection-popover')) return;
      handlers.onClearTaskSelection();
      applySelection(rootEl, handlers.getSelectedTaskKeys?.());
    };
    bars.container.addEventListener('pointerdown', onGridPointerDown);
    cleanups.push(() => bars.container.removeEventListener('pointerdown', onGridPointerDown));
  }

  rootEl.appendChild(shell);

  const applyLeftWidth = (value, { commit = false } = {}) => {
    const clamped = clampTimelineLeftWidth(rootEl, value);
    if (clamped === null) return null;
    rootEl.style.setProperty('--timeline-left-width', `${clamped}px`);
    if (commit && typeof handlers.onLeftWidthCommit === 'function') {
      handlers.onLeftWidthCommit(clamped);
    }
    return clamped;
  };

  const storedLeftWidth = parseNumber(handlers.getLeftWidthPx?.());
  if (storedLeftWidth !== null) {
    applyLeftWidth(storedLeftWidth);
  }

  const resizer = document.createElement('div');
  resizer.className = 'timeline-left-resizer';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-label', 'Resize timeline details width');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.tabIndex = 0;
  rootEl.appendChild(resizer);

  let activePointerId = null;
  let activeMove = null;
  let activeUp = null;
  const stopDrag = () => {
    if (activeMove) document.removeEventListener('pointermove', activeMove);
    if (activeUp) {
      document.removeEventListener('pointerup', activeUp);
      document.removeEventListener('pointercancel', activeUp);
    }
    if (
      activePointerId !== null &&
      resizer.releasePointerCapture &&
      resizer.hasPointerCapture?.(activePointerId)
    ) {
      resizer.releasePointerCapture(activePointerId);
    }
    activePointerId = null;
    activeMove = null;
    activeUp = null;
  };

  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startWidth =
      getTimelineLeftColumnWidth(rootEl) ?? parseNumber(handlers.getLeftWidthPx?.());
    if (startWidth === null) return;
    const startX = event.clientX;
    activePointerId = event.pointerId;
    if (resizer.setPointerCapture) {
      resizer.setPointerCapture(event.pointerId);
    }
    let latest = startWidth;
    activeMove = (moveEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = startWidth + delta;
      const clamped = applyLeftWidth(nextWidth);
      if (clamped !== null) {
        latest = clamped;
      }
    };
    activeUp = () => {
      stopDrag();
      applyLeftWidth(latest, { commit: true });
    };
    document.addEventListener('pointermove', activeMove);
    document.addEventListener('pointerup', activeUp);
    document.addEventListener('pointercancel', activeUp);
  };

  const onKeyDown = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const current = getTimelineLeftColumnWidth(rootEl) ?? parseNumber(handlers.getLeftWidthPx?.());
    if (current === null) return;
    const delta =
      event.key === 'ArrowLeft' ? -TIMELINE_LEFT_RESIZE_STEP : TIMELINE_LEFT_RESIZE_STEP;
    applyLeftWidth(current + delta, { commit: true });
  };

  resizer.addEventListener('pointerdown', onPointerDown);
  resizer.addEventListener('keydown', onKeyDown);
  cleanups.push(() => {
    resizer.removeEventListener('pointerdown', onPointerDown);
    resizer.removeEventListener('keydown', onKeyDown);
    stopDrag();
  });
  if (debugEnabled) {
    const diagnosticsCleanup = attachTimelineLayoutDiagnostics({
      rootEl,
      headerEl: header,
      headScrollEl: dayHead.container,
      gridScrollEl: bars.container,
      rowCount: rows.length,
      prevHeaderHeight,
      prevRowCount,
    });
    cleanups.push(diagnosticsCleanup);
  }
  const restoreScrollState = () => {
    const rawTop = rootEl.dataset.timelineScrollTop;
    const rawLeft = rootEl.dataset.timelineScrollLeft;
    const scrollTop = Number.parseFloat(rawTop);
    const scrollLeft = Number.parseFloat(rawLeft);
    if (!bars.container || !table) return;
    const clamp = (value, max) => Math.min(Math.max(value, 0), Math.max(0, max));
    isRestoringScroll = true;
    const maxTop = Math.max(bars.container.scrollHeight - bars.container.clientHeight, 0);
    const maxLeft = Math.max(bars.container.scrollWidth - bars.container.clientWidth, 0);
    const nextTop = Number.isFinite(scrollTop) ? clamp(scrollTop, maxTop) : 0;
    const nextLeft = Number.isFinite(scrollLeft) ? clamp(scrollLeft, maxLeft) : 0;
    bars.container.scrollTop = nextTop;
    table.scrollTop = nextTop;
    bars.container.scrollLeft = nextLeft;
    if (dayHead?.container) {
      dayHead.container.scrollLeft = nextLeft;
    }
    requestAnimationFrame(() => {
      isRestoringScroll = false;
    });
  };
  const restoreAnchorRow = () => {
    const anchorKey = rootEl.dataset.timelineAnchorKey;
    if (!anchorKey || !bars.container || !table) return;
    const deltaY = Number.parseFloat(rootEl.dataset.timelineAnchorDeltaY);
    const legacyOffsetY = Number.parseFloat(rootEl.dataset.timelineAnchorOffsetY);
    const selector = `[data-task-key="${escapeSelector(anchorKey)}"]`;
    const anchorRow = table.querySelector(selector);
    delete rootEl.dataset.timelineAnchorKey;
    delete rootEl.dataset.timelineAnchorDeltaY;
    delete rootEl.dataset.timelineAnchorOffsetY;
    const offsetY = Number.isFinite(deltaY) ? deltaY : legacyOffsetY;
    if (!anchorRow || !Number.isFinite(offsetY)) return;
    // Keep the row's content-space delta stable: (offsetTop - scrollTop) === offsetY.
    const maxTop = Math.max(table.scrollHeight - table.clientHeight, 0);
    const nextTop = Math.min(Math.max(anchorRow.offsetTop - offsetY, 0), maxTop);
    isRestoringScroll = true;
    table.scrollTop = nextTop;
    bars.container.scrollTop = nextTop;
    rootEl.dataset.timelineScrollTop = String(nextTop);
    rootEl.dataset.timelineScrollLeft = String(bars.container.scrollLeft || 0);
    requestAnimationFrame(() => {
      isRestoringScroll = false;
    });
  };
  restoreScrollState();
  restoreAnchorRow();
  updateScrollLeftVar();
  if (typeof handlers.getSelectedTaskKeys === 'function') {
    applySelection(rootEl, handlers.getSelectedTaskKeys());
  }

  const brushCleanup = attachRangeBrush({
    rootEl,
    scrollEl: bars.container,
    layerEl: bars.layer,
    dayCount,
    dayLabels,
    handlers,
  });
  cleanups.push(brushCleanup);
  if (bars.cleanups?.length) {
    bars.cleanups.forEach((fn) => cleanups.push(fn));
  }
  if (subtreeCleanups.length) {
    subtreeCleanups.forEach((fn) => cleanups.push(fn));
  }

  const sizingCleanup = attachTimelineSizer({
    rootEl,
    gridScrollEl: bars.container,
    headScrollEl: dayHead.container,
    dayCount: Math.max(dayCount, 1),
    baseDayWidthPx: dayWidth,
    minDayWidthPx: minDayWidth,
    maxDayWidthPx: maxDayWidth,
    zoomMode,
  });
  cleanups.push(sizingCleanup);
  return () => {
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch (error) {
        /* ignore cleanup errors */
      }
    });
  };
}
