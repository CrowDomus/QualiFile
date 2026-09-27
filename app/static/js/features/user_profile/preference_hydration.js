import { applyPortablePreferences, state } from '../../shared/state.js';
import { applyTheme } from '../../shared/theme.js';
import { requestGlobalRefresh } from '../../shared/refresh.js';
import { refreshSidebarState } from '../../shared/sidebar.js';
import { mergePortablePreferences } from './preferences_cache.js';

function hasOwn(payload, key) {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function syncTheme() {
  const current = document.documentElement?.dataset?.theme || '';
  if (current !== state.theme) {
    applyTheme(state.theme);
  }
}

function syncDesignMode() {
  const toolbar = document.getElementById('toolbar-container');
  const current = toolbar?.dataset?.designMode;
  const next = state.designMode === 'compact' ? 'compact' : 'expanded';
  if (current && current !== next) {
    document.dispatchEvent(new CustomEvent('qualifile:design-mode', { detail: { mode: next } }));
  }
}

function syncSidebarState() {
  if (typeof state.sidebarCompactLocked === 'boolean') {
    document.dispatchEvent(
      new CustomEvent('qualifile:sidebar-compact-lock', {
        detail: { locked: state.sidebarCompactLocked },
      })
    );
  }
  refreshSidebarState();
}

function syncViewMode() {
  const desired = state.viewMode === 'grid' ? 'grid' : 'list';
  const listButton = document.getElementById('view-mode-list');
  const gridButton = document.getElementById('view-mode-grid');
  if (desired === 'list' && listButton && !listButton.classList.contains('active')) {
    listButton.click();
  }
  if (desired === 'grid' && gridButton && !gridButton.classList.contains('active')) {
    gridButton.click();
  }
}

function syncLayoutToggles() {
  document.querySelectorAll('.layout-toggle').forEach((toggle) => {
    if (!(toggle instanceof HTMLInputElement)) return;
    const pane = toggle.dataset.pane;
    if (!pane || !state.layout) return;
    const desired = state.layout[pane] !== false;
    if (toggle.checked !== desired) {
      toggle.checked = desired;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
}

function syncColumnToggles() {
  document.querySelectorAll('.column-toggle').forEach((toggle) => {
    if (!(toggle instanceof HTMLInputElement)) return;
    const key = toggle.dataset.column;
    if (!key) return;
    const desired = key === 'name' ? true : !!state.columns?.[key];
    if (toggle.checked !== desired) {
      toggle.checked = desired;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
}

function syncCategorizeToggle() {
  const toggle = document.getElementById('categorize-toggle');
  if (!(toggle instanceof HTMLInputElement)) return;
  const desired = !!state.categorizeFiles;
  if (toggle.checked !== desired) {
    toggle.checked = desired;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function syncTagModeToggle() {
  const toggle = document.getElementById('tag-mode-toggle');
  if (!toggle) return;
  const wantsDots = state.tagDisplayMode === 'dots';
  const pressed = toggle.getAttribute('aria-pressed') === 'true';
  if (pressed !== wantsDots) {
    toggle.click();
  }
}

function syncTagHierarchy() {
  const enabled = !!state.settings?.tags?.hierarchyView;
  document.dispatchEvent(
    new CustomEvent('qualifile:tags-hierarchy-view-changed', { detail: { enabled } })
  );
}

function syncListPreferences(portable) {
  syncViewMode();
  syncLayoutToggles();
  syncColumnToggles();
  syncCategorizeToggle();
  syncTagModeToggle();
  syncTagHierarchy();
  if (hasOwn(portable, 'sort') && document.getElementById('file-rows')) {
    requestGlobalRefresh({ refreshList: true, refreshTree: false });
  }
}

export function hydratePortablePreferences(portable) {
  if (!portable || typeof portable !== 'object') {
    return;
  }
  mergePortablePreferences(portable);
  applyPortablePreferences(portable);
  syncTheme();
  syncDesignMode();
  syncSidebarState();
  setTimeout(() => syncListPreferences(portable), 0);
}
