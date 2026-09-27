const EPSILON = 0.5;

/**
 * Attach a sizing helper to toggle between fit and scroll modes.
 * Returns a cleanup function.
 */
export function attachTimelineSizer(options = {}) {
  const {
    rootEl,
    gridScrollEl,
    headScrollEl = null,
    dayCount = 1,
    baseDayWidthPx = 32,
    minDayWidthPx = 8,
    maxDayWidthPx = 120,
    zoomMode = 'fit',
  } = options;

  if (!rootEl || !gridScrollEl || !Number.isFinite(dayCount) || dayCount <= 0) {
    return () => {};
  }

  const clamp = (value) => Math.min(Math.max(value, minDayWidthPx), maxDayWidthPx);

  const applyMode = (mode, effectiveDayWidth) => {
    rootEl.style.setProperty('--timeline-day-width', `${effectiveDayWidth}px`);
    rootEl.style.setProperty('--timeline-day-count', `${dayCount}`);
    rootEl.dataset.timelineXScroll = mode === 'scroll' ? 'on' : 'off';
    if (mode === 'fit') {
      gridScrollEl.scrollLeft = 0;
      if (headScrollEl) headScrollEl.scrollLeft = 0;
    }
  };

  const resolvedZoomMode =
    zoomMode === 'manual' || rootEl?.dataset.timelineZoomMode === 'manual' ? 'manual' : 'fit';

  const recompute = () => {
    const viewportWidth = gridScrollEl.clientWidth || 0;
    const baseWidth = clamp(baseDayWidthPx);
    const contentWidth = dayCount * baseWidth;
    if (resolvedZoomMode === 'manual') {
      const needsScroll = viewportWidth + EPSILON < contentWidth;
      applyMode(needsScroll ? 'scroll' : 'fit', baseWidth);
      return;
    }
    if (viewportWidth + EPSILON >= contentWidth) {
      const effective = clamp(viewportWidth / Math.max(dayCount, 1));
      applyMode('fit', effective);
      return;
    }
    applyMode('scroll', baseWidth);
  };

  let rafId = null;
  const schedule = () => {
    if (rafId !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      recompute();
      return;
    }
    rafId = requestAnimationFrame(() => {
      rafId = null;
      recompute();
    });
  };

  const observer = new ResizeObserver(() => schedule());
  observer.observe(gridScrollEl);
  schedule();

  return () => {
    if (rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    try {
      observer.disconnect();
    } catch (error) {
      /* ignore */
    }
  };
}
