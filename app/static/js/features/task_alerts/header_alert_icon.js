import { acknowledgeTaskAlerts, fetchTaskAlertsSummary } from '../../shared/api.js';
import { createTaskAlertsDropdownController } from './alerts_dropdown.js';

const DEFAULT_POLL_INTERVAL_MS = 30000;
const DEFAULT_LIMIT = 20;

function clampCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
}

function setBadgeState(badgeElement, count) {
  if (!badgeElement) return;
  badgeElement.textContent = String(count);
  badgeElement.classList.toggle('d-none', count <= 0);
}

function setDotState(dotElement, hasNew) {
  if (!dotElement) return;
  dotElement.classList.toggle('d-none', !hasNew);
}

function buildAriaLabel({ iconVisible, badgeCount, newCount }) {
  if (!iconVisible) {
    return 'Task alerts';
  }
  if (badgeCount > 0) {
    return `${badgeCount} alerts need attention`;
  }
  if (newCount > 0) {
    return `${newCount} new alerts`;
  }
  return 'Task alerts';
}

export function initTaskAlertsHeader({ pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
  const slotElement = document.getElementById('task-alerts-slot');
  const toggleElement = document.getElementById('task-alerts-toggle');
  const badgeElement = document.getElementById('task-alerts-badge');
  const dotElement = document.getElementById('task-alerts-new-dot');
  const listElement = document.getElementById('task-alerts-list');
  const emptyElement = document.getElementById('task-alerts-empty');
  const dropdownMenu = document.getElementById('task-alerts-dropdown');

  if (!slotElement || !toggleElement || !listElement || !emptyElement || !dropdownMenu) {
    return null;
  }

  const dropdownController = createTaskAlertsDropdownController({
    listElement,
    emptyElement,
  });
  dropdownController.setIdleEmptyMessage();

  let inflightRefresh = null;
  let refreshTimerId = null;
  let destroyed = false;

  const applySummary = (summary) => {
    const iconVisible = Boolean(summary?.icon_visible);
    const badgeCount = clampCount(summary?.badge_count);
    const newCount = clampCount(summary?.new_count);

    slotElement.hidden = !iconVisible;
    slotElement.classList.toggle('d-none', !iconVisible);
    setBadgeState(badgeElement, badgeCount);
    setDotState(dotElement, newCount > 0 && badgeCount === 0);
    toggleElement.setAttribute('aria-label', buildAriaLabel({ iconVisible, badgeCount, newCount }));
    dropdownController.render(summary);
  };

  const refresh = async () => {
    if (destroyed) return;
    if (inflightRefresh) {
      await inflightRefresh;
      return;
    }
    inflightRefresh = fetchTaskAlertsSummary({ limit: DEFAULT_LIMIT })
      .then((summary) => {
        applySummary(summary);
      })
      .catch(() => {
        dropdownController.showError('Unable to load alerts.');
      })
      .finally(() => {
        inflightRefresh = null;
      });
    await inflightRefresh;
  };

  const acknowledgeAndRefresh = async () => {
    if (destroyed) return;
    try {
      const summary = await acknowledgeTaskAlerts({ limit: DEFAULT_LIMIT });
      applySummary(summary);
    } catch {
      // Keep existing summary in place; next refresh cycle will retry.
    }
  };

  const onDropdownShown = () => {
    void acknowledgeAndRefresh();
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      void refresh();
    }
  };
  const onManualRefresh = () => {
    void refresh();
  };

  toggleElement.addEventListener('shown.bs.dropdown', onDropdownShown);
  document.addEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('qualifile:task-alerts-refresh', onManualRefresh);
  refreshTimerId = window.setInterval(
    () => {
      void refresh();
    },
    Math.max(5000, Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS)
  );

  void refresh();

  return {
    refresh,
    destroy() {
      destroyed = true;
      if (refreshTimerId !== null) {
        window.clearInterval(refreshTimerId);
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('qualifile:task-alerts-refresh', onManualRefresh);
      toggleElement.removeEventListener('shown.bs.dropdown', onDropdownShown);
    },
  };
}
