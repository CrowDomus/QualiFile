import { state, persistPreferences } from './state.js';

const layout = document.querySelector('.app-layout');
const sidebar = document.querySelector('.app-sidebar');
const pinToggle = document.querySelector('[data-sidebar-pin-toggle]');
const brandTrigger = document.getElementById('toolbar-brand');

const COLLAPSE_DELAY = 180;
let hoverSidebar = false;
let hoverBrand = false;
let focusSidebar = false;
let collapseTimer = null;

function isPinned() {
  if (state.sidebarCompactLocked) return false;
  return state.sidebarPinned !== false;
}

function reflectPinnedPreference() {
  const locked = state.sidebarCompactLocked === true;
  const pinned = locked ? false : isPinned();
  const value = pinned ? 'true' : 'false';
  document.documentElement.dataset.sidebarPinned = value;
  document.documentElement.dataset.sidebarCompactLocked = locked ? 'true' : 'false';
  if (document.body) {
    document.body.dataset.sidebarPinned = value;
    document.body.dataset.sidebarCompactLocked = locked ? 'true' : 'false';
  }
}

function clearSidebarPreload() {
  document.documentElement.classList.remove('sidebar-preload');
  document.body?.classList?.remove('sidebar-preload');
}

function setPinned(value) {
  if (state.sidebarCompactLocked) {
    state.sidebarPinned = false;
  } else {
    state.sidebarPinned = !!value;
  }
  persistPreferences();
  reflectPinnedPreference();
  syncSidebarState(true);
}

function syncSidebarState(immediate = false) {
  if (!layout || !sidebar) return;
  clearTimeout(collapseTimer);
  const locked = state.sidebarCompactLocked === true;
  const pinned = locked ? false : isPinned();
  reflectPinnedPreference();
  layout.classList.toggle('sidebar-pinned', pinned);
  layout.classList.toggle('sidebar-unpinned', !pinned);
  const shouldOpen = !locked && (pinned || hoverSidebar || hoverBrand || focusSidebar);
  if (shouldOpen) {
    layout.classList.add('sidebar-open');
  } else if (!pinned) {
    if (immediate) {
      layout.classList.remove('sidebar-open');
    } else {
      collapseTimer = setTimeout(() => layout.classList.remove('sidebar-open'), COLLAPSE_DELAY);
    }
  } else {
    layout.classList.add('sidebar-open');
  }
  if (pinToggle) {
    const pressed = pinned ? 'true' : 'false';
    const label = pinned ? 'Unpin sidebar' : 'Pin sidebar';
    pinToggle.setAttribute('aria-pressed', pressed);
    pinToggle.setAttribute('aria-label', label);
    pinToggle.setAttribute('title', label);
  }
}

function bindSidebarInteractions() {
  if (!layout || !sidebar) return;
  pinToggle?.addEventListener('click', () => setPinned(!isPinned()));

  sidebar.addEventListener('mouseenter', () => {
    if (state.sidebarCompactLocked) return;
    hoverSidebar = true;
    syncSidebarState(true);
  });
  sidebar.addEventListener('mouseleave', () => {
    if (state.sidebarCompactLocked) return;
    hoverSidebar = false;
    syncSidebarState();
  });
  sidebar.addEventListener('focusin', () => {
    if (state.sidebarCompactLocked) return;
    focusSidebar = true;
    syncSidebarState(true);
  });
  sidebar.addEventListener('focusout', (event) => {
    if (state.sidebarCompactLocked) return;
    const nextTarget = event.relatedTarget;
    if (nextTarget && sidebar.contains(nextTarget)) return;
    focusSidebar = sidebar.contains(document.activeElement);
    if (!focusSidebar) {
      syncSidebarState();
    }
  });

  if (brandTrigger) {
    brandTrigger.addEventListener('mouseenter', () => {
      if (state.sidebarCompactLocked) return;
      hoverBrand = true;
      syncSidebarState(true);
    });
    brandTrigger.addEventListener('mouseleave', () => {
      if (state.sidebarCompactLocked) return;
      hoverBrand = false;
      syncSidebarState();
    });
    brandTrigger.addEventListener('focusin', () => {
      if (state.sidebarCompactLocked) return;
      hoverBrand = true;
      syncSidebarState(true);
    });
    brandTrigger.addEventListener('focusout', () => {
      if (state.sidebarCompactLocked) return;
      hoverBrand = false;
      syncSidebarState();
    });
  }
}

export function refreshSidebarState() {
  syncSidebarState(true);
}

document.addEventListener('qualifile:sidebar-compact-lock', (event) => {
  const locked = Boolean(event?.detail?.locked);
  state.sidebarCompactLocked = locked;
  if (locked) {
    state.sidebarPinned = false;
    hoverSidebar = false;
    hoverBrand = false;
    focusSidebar = false;
  }
  syncSidebarState(true);
});

function initSidebarChrome() {
  reflectPinnedPreference();
  if (!layout || !sidebar) {
    clearSidebarPreload();
    return;
  }
  syncSidebarState(true);
  bindSidebarInteractions();
  clearSidebarPreload();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSidebarChrome);
} else {
  initSidebarChrome();
}
