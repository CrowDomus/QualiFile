import { requestJson, revealInFileExplorer } from '../../shared/api.js';
import { pickReadableTextColor } from '../../shared/color-utils.js';
import { showToast } from '../../shared/ui.js';
import { setHeaderStatus } from './sync_manager/header_status.js';
import {
  getSyncManagerPreferences,
  migrateLegacySyncManagerPreferences,
} from './sync_manager/preferences_adapter.js';
import {
  ACTIVITY_DEFAULT_PANEL_WIDTH,
  clampActivityPanelWidth,
  restoreActivityPanelWidth,
  persistActivityPanelWidth,
} from './sync_manager/activity_panel.js';
import {
  getSyncManagerContextMenuNodes,
  isSyncManagerContextMenuVisible,
  closeSyncManagerContextMenu,
  positionSyncManagerContextMenu,
  shouldIgnoreSyncManagerContextMenuTarget,
} from './sync_manager/context_menu_adapter.js';
import {
  resolveRecommendedActionKey,
  resolveVisiblePrimaryActionKey,
} from './sync_manager/recommendation_engine.js';
import { resolveLocalFilesSummary } from './sync_manager/local_files.js';

const STATUS_ENDPOINT = '/api/git-sync/projects/status';
const AUTO_REFRESH_INTERVAL_MS = 7000;
const AUTO_REFRESH_BACKOFF_FAILURE_START = 3;
const AUTO_REFRESH_BACKOFF_MAX_MULTIPLIER = 4;
const AUTO_REFRESH_MAX_INTERVAL_MS = 30000;
const AUTO_REFRESH_INTERVAL_OPTIONS = [7000, 10000, 15000, 30000];
const STALE_REFRESH_INTERVAL_MULTIPLIER = 2;
const STALE_FAILURE_STREAK_THRESHOLD = AUTO_REFRESH_BACKOFF_FAILURE_START;
const SETTINGS_TAB_ORDER = ['overview', 'remote', 'diagnostics'];
const ACTIVITY_STORAGE_KEY = 'qualifile-sync-manager-activity-v1';
const ACTIVITY_MAX_ENTRIES = 200;
const DEFAULT_PROJECT_COLOR_STYLE = 'pill';
const PROJECT_COLOR_STYLE_OPTIONS = new Set(['pill', 'row']);
const PROJECT_COLOR_FALLBACK_PALETTE = [
  '#0D6EFD',
  '#0B7285',
  '#6F42C1',
  '#B02A37',
  '#198754',
  '#FD7E14',
];

const ACTION_ENDPOINTS = {
  export_metadata: '/api/git-sync/project/export',
  import_metadata: '/api/git-sync/project/import',
  init_repo: '/api/git-sync/project/init-repo',
  set_remote: '/api/git-sync/project/set-remote',
  commit_push: '/api/git-sync/project/commit-push',
  pull_import: '/api/git-sync/project/pull-import',
};

const BADGE_CLASS_BY_STATE = {
  ready: 'text-bg-success',
  clean: 'text-bg-success',
  valid: 'text-bg-success',
  dirty: 'text-bg-warning',
  conflicted: 'text-bg-danger',
  incomplete: 'text-bg-danger',
  invalid: 'text-bg-danger',
  missing: 'text-bg-secondary',
  unavailable: 'text-bg-secondary',
  unknown: 'text-bg-secondary',
  'not-initialized': 'text-bg-secondary',
  'git-missing': 'text-bg-danger',
  'no-root': 'text-bg-secondary',
  'root-unavailable': 'text-bg-danger',
  'root-id-missing': 'text-bg-warning',
};

const STATE_LABELS = {
  ready: 'Ready',
  clean: 'Up to date',
  valid: 'Valid',
  dirty: 'Uncommitted changes',
  conflicted: 'Conflicted',
  incomplete: 'Incomplete',
  invalid: 'Invalid',
  missing: 'Missing',
  unavailable: 'Unavailable',
  unknown: 'Unknown',
  'not-initialized': 'Not initialized',
  'git-missing': 'Git missing',
  'no-root': 'No root',
  'root-unavailable': 'Root unavailable',
  'root-id-missing': 'Root ID missing',
};

const CONTEXT_STATE_LABELS = {
  pps: {
    valid: 'Metadata snapshot valid',
    incomplete: 'Metadata snapshot incomplete',
    invalid: 'Metadata snapshot invalid',
    conflicted: 'Snapshot conflicts',
    missing: 'Snapshot missing',
  },
  local: {
    clean: 'Up to date',
    dirty: 'Uncommitted changes',
  },
};

const LOCAL_REASON_LABELS = {
  'clean-fingerprint-match': 'Matches the last synced baseline',
  'dirty-fingerprint-mismatch': 'Local files changed since the last sync check',
  'dirty-baseline-missing': 'No local baseline recorded yet',
  'dirty-lss-root-mismatch': 'Local baseline root does not match this project',
  'dirty-project-root-mismatch': 'Project metadata root does not match this view',
  'project-root-id-missing': 'Project root identifier is missing',
};

const ACTIVITY_STATUS_BADGE_CLASS = {
  Started: 'text-bg-info',
  Succeeded: 'text-bg-success',
  Failed: 'text-bg-danger',
  Cancelled: 'text-bg-secondary',
};

const SMART_HINTS_BY_CODE = {
  'git-auth-failed': {
    summary: 'Authentication to the remote failed.',
    steps: [
      'Verify access rights for the repository.',
      'Check the remote URL and credential helper configuration.',
      'Retry Commit+Push after credentials are refreshed.',
    ],
  },
  'git-sync-auth-failed': {
    summary: 'Authentication to the remote failed.',
    steps: [
      'Verify access rights for the repository.',
      'Check the remote URL and credential helper configuration.',
      'Retry Commit+Push after credentials are refreshed.',
    ],
  },
  'git-not-trusted': {
    summary: 'Git executable is not trusted for Sync Manager actions.',
    steps: [
      'Open Git Sync configuration and confirm the trusted absolute Git path.',
      'Retry the action after trust is restored.',
    ],
  },
  'git-missing': {
    summary: 'Git executable is not available.',
    steps: [
      'Install Git and verify it is available on this machine.',
      'Confirm trusted Git path configuration in Sync Manager.',
    ],
  },
  'git-sync-git-missing': {
    summary: 'Git executable is not available.',
    steps: [
      'Install Git and verify it is available on this machine.',
      'Confirm trusted Git path configuration in Sync Manager.',
    ],
  },
  'git-remote-ambiguous': {
    summary: 'No single remote could be selected automatically.',
    steps: [
      'Set an explicit remote in Git Sync settings.',
      'Retry push or pull/import after remote selection.',
    ],
  },
  'git-pull-non-fast-forward': {
    summary: 'Remote branch cannot be fast-forwarded safely.',
    steps: [
      'Review remote updates and local commits before continuing.',
      'Resolve branch divergence outside Sync Manager, then retry.',
    ],
  },
  'pull-import-dirty-local': {
    summary: 'Local metadata has uncommitted changes.',
    steps: [
      'Commit or export current local metadata first.',
      'Retry Pull+Import after local state is clean.',
    ],
  },
  'git-sync-dirty-local': {
    summary: 'Local metadata has uncommitted changes.',
    steps: [
      'Commit or export current local metadata first.',
      'Retry Pull+Import after local state is clean.',
    ],
  },
  'import-conflict-unmerged': {
    summary: 'Import detected unresolved conflicts.',
    steps: [
      'Resolve conflict markers in tracked metadata files.',
      'Run import again after conflicts are cleared.',
    ],
  },
  'manifest-fingerprint-mismatch': {
    summary: 'Metadata snapshot fingerprint does not match expected state.',
    steps: [
      'Refresh status and export a fresh snapshot.',
      'Retry import using the latest exported metadata.',
    ],
  },
  'import-large-delete-confirmation-required': {
    summary: 'Import requires explicit large-delete confirmation.',
    steps: ['Review delete impact in details.', 'Confirm large delete only if expected.'],
  },
  'import-force-confirmation-required': {
    summary: 'Import requires exact typed confirmation phrase.',
    steps: ['Type the phrase exactly as shown.', 'Retry import after phrase confirmation.'],
  },
  'pull-import-force-confirmation-required': {
    summary: 'Pull+Import requires exact typed confirmation phrase.',
    steps: ['Type the phrase exactly as shown.', 'Retry Pull+Import after phrase confirmation.'],
  },
};

const DIAGNOSTIC_COMMAND_TEMPLATES = [
  'git remote -v',
  'git status --porcelain -b',
  'git ls-remote <remote_name>',
  'git fetch --prune <remote_name>',
  'git log --oneline --left-right --cherry @{u}...HEAD',
];

let loadStatusesPromise = null;
let pollTimerId = null;
let pollFailureStreak = 0;
let staleIndicatorTimerId = null;
let lastSuccessfulRefreshMs = null;
let activityEntries = [];
let activityFilterQuery = '';
let activityPanelVisible = true;
let activityPanelWidth = ACTIVITY_DEFAULT_PANEL_WIDTH;
let autoRefreshEnabled = true;
let autoRefreshIntervalMs = AUTO_REFRESH_INTERVAL_MS;
let showAdvancedRowActions = false;
let projectColorStyle = DEFAULT_PROJECT_COLOR_STYLE;
let rowsByProjectId = new Map();
let activeSettingsProjectId = '';
let settingsReturnFocusNode = null;
let contextMenuProjectId = '';
let contextMenuReturnFocusNode = null;
let activeSettingsTabId = 'overview';
let remoteEditorStateByProjectId = new Map();
let remoteSetRequestInFlight = false;
let activityStateRestoredFromSession = false;

function createElement(tag, className = '') {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  return element;
}

function clearNode(node) {
  if (!node) return;
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function hideNode(node) {
  if (!node) return;
  node.classList.add('d-none');
}

function showNode(node) {
  if (!node) return;
  node.classList.remove('d-none');
}

function clearError() {
  const errorBox = document.getElementById('sync-manager-error');
  if (!errorBox) return;
  clearNode(errorBox);
  hideNode(errorBox);
}

function setFeedback(message) {
  const text = sanitizeActivityText(message);
  if (!text) return;
  showToast(text, false);
}

function sanitizeActivityText(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  let sanitized = raw.replace(/([a-z]+:\/\/)([^@\s/]+)@/gi, '$1***@');
  sanitized = sanitized.replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, '<path>');
  sanitized = sanitized.replace(/(^|[\s(=])\/(?:[^/\s]+\/)*[^/\s)]+/g, '$1<path>');
  return sanitized;
}

function sanitizeActivityList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map((item) => sanitizeActivityText(item)).filter((item) => item.length > 0);
}

function normalizeHintCode(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function resolveSmartHint({ code = '', message = '', guidanceSummary = '' } = {}) {
  const normalizedCode = normalizeHintCode(code);
  if (normalizedCode && SMART_HINTS_BY_CODE[normalizedCode]) {
    const mapped = SMART_HINTS_BY_CODE[normalizedCode];
    return {
      summary: sanitizeActivityText(mapped.summary),
      steps: sanitizeActivityList(mapped.steps),
    };
  }

  const combined = `${message} ${guidanceSummary}`.toLowerCase();
  if (
    combined.includes('no upstream') ||
    combined.includes('no tracking information') ||
    combined.includes('not tracking a remote branch')
  ) {
    return {
      summary: 'Branch is not tracking a remote branch.',
      steps: [
        'Open Sync settings > Remote to configure a default upstream.',
        'Run Commit+Push once to establish upstream tracking.',
      ],
    };
  }
  if (combined.includes('authentication failed') || combined.includes('permission denied')) {
    return {
      summary: 'Authentication to the remote failed.',
      steps: [
        'Check repository access rights and credentials.',
        'Retry after credentials are refreshed.',
      ],
    };
  }
  if (combined.includes('not a git repository') || combined.includes('repository not found')) {
    return {
      summary: 'Repository path or state could not be verified.',
      steps: [
        'Confirm the project root still points to a valid Git repository.',
        'Run Refresh and retry after repository access is restored.',
      ],
    };
  }
  return null;
}

function setListVisibility(node, visible) {
  if (!node) return;
  node.classList.toggle('d-none', !visible);
}

function replaceListItems(node, values) {
  if (!node) return;
  clearNode(node);
  values.forEach((textValue) => {
    const item = createElement('li');
    item.textContent = sanitizeActivityText(textValue);
    node.appendChild(item);
  });
}

function normalizeRefreshIntervalMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return AUTO_REFRESH_INTERVAL_MS;
  }
  const normalized = Math.round(parsed);
  if (AUTO_REFRESH_INTERVAL_OPTIONS.includes(normalized)) {
    return normalized;
  }
  if (normalized < AUTO_REFRESH_INTERVAL_OPTIONS[0]) {
    return AUTO_REFRESH_INTERVAL_OPTIONS[0];
  }
  return AUTO_REFRESH_INTERVAL_OPTIONS[AUTO_REFRESH_INTERVAL_OPTIONS.length - 1];
}

function normalizeProjectColorStyle(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (PROJECT_COLOR_STYLE_OPTIONS.has(normalized)) {
    return normalized;
  }
  return DEFAULT_PROJECT_COLOR_STYLE;
}

function applySyncManagerPreferences(nextPreferences, { applyPanelDefault = false } = {}) {
  const preferences =
    nextPreferences && typeof nextPreferences === 'object'
      ? nextPreferences
      : getSyncManagerPreferences();
  autoRefreshEnabled = Boolean(preferences.autoRefreshEnabled);
  autoRefreshIntervalMs = normalizeRefreshIntervalMs(preferences.autoRefreshIntervalMs);
  showAdvancedRowActions = Boolean(preferences.showAdvancedRowActions);
  projectColorStyle = normalizeProjectColorStyle(preferences.projectColorStyle);
  if (applyPanelDefault) {
    setActivityPanelVisible(Boolean(preferences.activityPanelVisibleByDefault), { persist: false });
  }
}

function projectPathLabel(value) {
  const text = String(value || '').trim();
  if (!text) {
    return 'No root';
  }
  const segments = text.split(/[\\/]/).filter((segment) => segment.length > 0);
  if (!segments.length) {
    return text;
  }
  return segments[segments.length - 1];
}

function normalizeProjectColorValue(value) {
  let text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (!text.startsWith('#')) {
    text = `#${text}`;
  }
  if (/^#[0-9a-fA-F]{3}$/.test(text)) {
    text = `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(text)) {
    return text.toUpperCase();
  }
  return '';
}

function fallbackProjectColor(projectId) {
  const text = String(projectId || '').trim();
  if (!text) {
    return PROJECT_COLOR_FALLBACK_PALETTE[0];
  }
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  const offset = Math.abs(hash) % PROJECT_COLOR_FALLBACK_PALETTE.length;
  return PROJECT_COLOR_FALLBACK_PALETTE[offset];
}

function resolveProjectAccentColor(row) {
  const explicit = normalizeProjectColorValue(row?.project_color);
  if (explicit) {
    return explicit;
  }
  return fallbackProjectColor(row?.project_id);
}

function redactedProjectRootLabel(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '<project_root>';
  }
  const folderName = projectPathLabel(text);
  if (folderName === 'No root') {
    return '<project_root>';
  }
  return `.../${folderName}`;
}

function isLikelyWindowsPath(value) {
  const text = String(value || '').trim();
  if (!text) {
    return false;
  }
  return /^[A-Za-z]:[\\/]/.test(text) || /^\\\\/.test(text);
}

function normalizeActivityFilterQuery(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function getFilteredActivityEntries() {
  const query = normalizeActivityFilterQuery(activityFilterQuery);
  if (!query) {
    return activityEntries;
  }
  return activityEntries.filter((entry) => {
    const projectLabel = String(entry?.projectLabel || '').toLowerCase();
    const projectId = String(entry?.projectId || '').toLowerCase();
    return projectLabel.includes(query) || projectId.includes(query);
  });
}

function formatActivityTimestamp(timestampMs) {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.valueOf())) {
    return '--:--:--';
  }
  return formatRefreshTimestamp(date);
}

function getActivityNodes() {
  return {
    panel: document.getElementById('sync-manager-activity-panel'),
    toggle: document.getElementById('sync-manager-activity-toggle'),
    list: document.getElementById('sync-manager-activity-list'),
    empty: document.getElementById('sync-manager-activity-empty'),
    clearButton: document.getElementById('sync-manager-activity-clear'),
    copyButton: document.getElementById('sync-manager-activity-copy'),
    filterInput: document.getElementById('sync-manager-activity-filter'),
    resizer: document.getElementById('sync-manager-activity-resizer'),
  };
}

function getRefreshNodes() {
  return {
    lastRefreshed: document.getElementById('sync-manager-last-refreshed'),
    staleIndicator: document.getElementById('sync-manager-stale-indicator'),
    autoRefreshOffHint: document.getElementById('sync-manager-auto-refresh-off-hint'),
  };
}

function getSettingsNodes() {
  return {
    dialog: document.getElementById('sync-manager-settings-dialog'),
    title: document.getElementById('sync-manager-settings-title'),
    summary: document.getElementById('sync-manager-settings-summary'),
    root: document.getElementById('sync-manager-settings-root'),
    branch: document.getElementById('sync-manager-settings-branch'),
    tracking: document.getElementById('sync-manager-settings-tracking'),
    remoteName: document.getElementById('sync-manager-settings-remote-name'),
    remoteUrl: document.getElementById('sync-manager-settings-remote-url'),
    remoteUrlPreview: document.getElementById('sync-manager-settings-remote-url-preview'),
    remoteStatus: document.getElementById('sync-manager-settings-remote-status'),
    setRemoteButton: document.getElementById('sync-manager-settings-set-remote'),
    actions: document.getElementById('sync-manager-settings-actions'),
    tabList: document.getElementById('sync-manager-settings-tablist'),
    tabs: Array.from(
      document.querySelectorAll('#sync-manager-settings-tablist [data-settings-tab]')
    ),
    panels: Array.from(
      document.querySelectorAll('#sync-manager-settings-dialog [data-settings-panel]')
    ),
    pps: document.getElementById('sync-manager-settings-pps'),
    local: document.getElementById('sync-manager-settings-local'),
    diagnosticsHint: document.getElementById('sync-manager-settings-diagnostics-hint'),
    diagnosticsCode: document.getElementById('sync-manager-settings-diagnostics-code'),
    diagnosticsSteps: document.getElementById('sync-manager-settings-diagnostics-steps'),
    diagnosticsDetailsWrap: document.getElementById(
      'sync-manager-settings-diagnostics-details-wrap'
    ),
    diagnosticsDetails: document.getElementById('sync-manager-settings-diagnostics-details'),
    diagnosticsPreview: document.getElementById('sync-manager-settings-diagnostics-preview'),
    copyDiagnosticsButton: document.getElementById('sync-manager-settings-copy-diagnostics'),
    closeButton: document.getElementById('sync-manager-settings-close'),
  };
}

function normalizeSettingsTabId(tabId) {
  const normalized = String(tabId || '')
    .trim()
    .toLowerCase();
  if (SETTINGS_TAB_ORDER.includes(normalized)) {
    return normalized;
  }
  return SETTINGS_TAB_ORDER[0];
}

function setActiveSettingsTab(tabId, { focusTab = false } = {}) {
  const nodes = getSettingsNodes();
  const normalized = normalizeSettingsTabId(tabId);
  activeSettingsTabId = normalized;

  let activeButton = null;
  nodes.tabs.forEach((tabButton) => {
    const buttonTab = normalizeSettingsTabId(tabButton?.dataset?.settingsTab);
    const isActive = buttonTab === normalized;
    tabButton.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tabButton.setAttribute('tabindex', isActive ? '0' : '-1');
    tabButton.classList.toggle('btn-primary', isActive);
    tabButton.classList.toggle('btn-outline-secondary', !isActive);
    if (isActive) {
      activeButton = tabButton;
    }
  });

  nodes.panels.forEach((panel) => {
    const panelTab = normalizeSettingsTabId(panel?.dataset?.settingsPanel);
    const isActive = panelTab === normalized;
    panel.classList.toggle('d-none', !isActive);
    panel.setAttribute('aria-hidden', isActive ? 'false' : 'true');
  });

  if (focusTab && activeButton instanceof HTMLElement) {
    activeButton.focus();
  }
}

function onSettingsTabClick(event) {
  const tabButton =
    event.target instanceof HTMLElement ? event.target.closest('[data-settings-tab]') : null;
  if (!(tabButton instanceof HTMLElement)) {
    return;
  }
  setActiveSettingsTab(tabButton.dataset.settingsTab, { focusTab: true });
}

function onSettingsTabKeydown(event) {
  const key = String(event?.key || '');
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
    return;
  }
  const nodes = getSettingsNodes();
  const orderedTabs = nodes.tabs.filter((tab) => tab instanceof HTMLElement);
  if (!orderedTabs.length) {
    return;
  }

  const current =
    event.target instanceof HTMLElement ? event.target.closest('[data-settings-tab]') : null;
  const currentIndex = orderedTabs.findIndex((tab) => tab === current);
  if (currentIndex < 0) {
    return;
  }

  let nextIndex = currentIndex;
  if (key === 'ArrowRight') {
    nextIndex = (currentIndex + 1) % orderedTabs.length;
  } else if (key === 'ArrowLeft') {
    nextIndex = (currentIndex - 1 + orderedTabs.length) % orderedTabs.length;
  } else if (key === 'Home') {
    nextIndex = 0;
  } else if (key === 'End') {
    nextIndex = orderedTabs.length - 1;
  }

  event.preventDefault();
  const nextButton = orderedTabs[nextIndex];
  setActiveSettingsTab(nextButton?.dataset?.settingsTab, { focusTab: true });
}

function getContextMenuNodes() {
  return getSyncManagerContextMenuNodes();
}

function persistActivityState() {
  try {
    const payload = {
      visible: activityPanelVisible,
      filter_query: activityFilterQuery,
      entries: activityEntries,
    };
    window.sessionStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(payload));
  } catch (_error) {
    // Session storage is best effort only.
  }
}

function restoreActivityState() {
  try {
    const raw = window.sessionStorage.getItem(ACTIVITY_STORAGE_KEY);
    if (!raw) {
      activityStateRestoredFromSession = false;
      return;
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed?.visible === 'boolean') {
      activityPanelVisible = parsed.visible;
    }
    if (Array.isArray(parsed?.entries)) {
      activityEntries = parsed.entries
        .filter((entry) => entry && typeof entry === 'object')
        .slice(0, ACTIVITY_MAX_ENTRIES);
    }
    activityFilterQuery = String(parsed?.filter_query || '').trim();
    activityStateRestoredFromSession = true;
  } catch (_error) {
    activityEntries = [];
    activityFilterQuery = '';
    activityStateRestoredFromSession = false;
  }
}

function setActivityPanelWidth(width, { persist = true } = {}) {
  const nodes = getActivityNodes();
  if (!nodes.panel) return;
  const nextWidth = clampActivityPanelWidth(width, ACTIVITY_DEFAULT_PANEL_WIDTH);
  activityPanelWidth = nextWidth;
  nodes.panel.style.width = `${nextWidth}px`;
  if (persist) {
    persistActivityPanelWidth(nextWidth);
    persistActivityState();
  }
}

function setActivityPanelVisible(visible, { persist = true } = {}) {
  const nodes = getActivityNodes();
  activityPanelVisible = Boolean(visible);
  if (nodes.panel) {
    nodes.panel.classList.toggle('d-none', !activityPanelVisible);
  }
  if (nodes.resizer) {
    nodes.resizer.classList.toggle('d-none', !activityPanelVisible);
  }
  if (nodes.toggle) {
    nodes.toggle.textContent = activityPanelVisible ? 'Hide Activity' : 'Show Activity';
    nodes.toggle.setAttribute('aria-expanded', activityPanelVisible ? 'true' : 'false');
  }
  const settingsNodes = getSettingsNodes();
  if (settingsNodes.panelVisibleToggle) {
    settingsNodes.panelVisibleToggle.checked = activityPanelVisible;
  }
  if (persist) {
    persistActivityState();
  }
}

function buildActivityCopyText() {
  const visibleEntries = getFilteredActivityEntries();
  if (!visibleEntries.length) {
    return '';
  }
  return visibleEntries
    .map((entry) => {
      const codePart = entry.code ? ` [${entry.code}]` : '';
      return `${entry.timestampLabel} | ${entry.projectLabel} | ${entry.actionLabel} | ${entry.status}${codePart} | ${entry.summary}`;
    })
    .join('\n');
}

function renderActivityEntries() {
  const nodes = getActivityNodes();
  if (!nodes.list || !nodes.empty) return;
  const visibleEntries = getFilteredActivityEntries();
  const hasFilter = normalizeActivityFilterQuery(activityFilterQuery).length > 0;
  if (nodes.filterInput && document.activeElement !== nodes.filterInput) {
    nodes.filterInput.value = activityFilterQuery;
  }

  clearNode(nodes.list);
  if (!activityEntries.length) {
    nodes.empty.textContent = 'No activity yet.';
    nodes.empty.classList.remove('d-none');
    if (nodes.clearButton) {
      nodes.clearButton.disabled = true;
    }
    if (nodes.copyButton) {
      nodes.copyButton.disabled = true;
    }
    return;
  }

  if (!visibleEntries.length) {
    nodes.empty.textContent = hasFilter
      ? 'No activity matches the current filter.'
      : 'No activity yet.';
    nodes.empty.classList.remove('d-none');
    if (nodes.clearButton) {
      nodes.clearButton.disabled = false;
    }
    if (nodes.copyButton) {
      nodes.copyButton.disabled = true;
    }
    return;
  }

  nodes.empty.classList.add('d-none');
  if (nodes.clearButton) {
    nodes.clearButton.disabled = false;
  }
  if (nodes.copyButton) {
    nodes.copyButton.disabled = false;
  }

  const fragment = document.createDocumentFragment();
  visibleEntries.forEach((entry) => {
    const article = createElement(
      'article',
      'sync-manager-activity-entry border rounded p-2 bg-body'
    );

    const topRow = createElement('div', 'd-flex align-items-center justify-content-between gap-2');
    const title = createElement('div', 'small fw-semibold');
    title.textContent = `${entry.projectLabel} - ${entry.actionLabel}`;
    topRow.appendChild(title);
    const badge = createElement('span', 'badge');
    badge.classList.add(ACTIVITY_STATUS_BADGE_CLASS[entry.status] || 'text-bg-secondary');
    badge.textContent = entry.status;
    topRow.appendChild(badge);
    article.appendChild(topRow);

    const meta = createElement('div', 'text-muted small');
    meta.textContent = entry.timestampLabel;
    article.appendChild(meta);

    const summary = createElement('div', 'small mt-1');
    summary.textContent = entry.summary;
    article.appendChild(summary);

    const hasDetailContent = Boolean(
      entry.code ||
      entry.guidanceSummary ||
      (entry.nextSteps && entry.nextSteps.length) ||
      (entry.details && entry.details.length)
    );
    if (hasDetailContent) {
      const detailsNode = createElement('details', 'mt-2');
      const summaryNode = createElement('summary', 'small');
      summaryNode.textContent = 'Details';
      detailsNode.appendChild(summaryNode);

      const detailContainer = createElement('div', 'small mt-1 d-flex flex-column gap-1');
      if (entry.code) {
        const codeLine = createElement('div');
        codeLine.textContent = `Code: ${entry.code}`;
        detailContainer.appendChild(codeLine);
      }
      const smartHint = resolveSmartHint({
        code: entry.code,
        message: entry.summary,
        guidanceSummary: entry.guidanceSummary,
      });
      if (smartHint?.summary) {
        const hintLine = createElement('div');
        hintLine.textContent = `Hint: ${smartHint.summary}`;
        detailContainer.appendChild(hintLine);
      }
      if (Array.isArray(smartHint?.steps) && smartHint.steps.length) {
        const hintSteps = createElement('ul', 'mb-0 ps-3');
        smartHint.steps.forEach((hintStepText) => {
          const item = createElement('li');
          item.textContent = hintStepText;
          hintSteps.appendChild(item);
        });
        detailContainer.appendChild(hintSteps);
      }
      if (entry.guidanceSummary) {
        const guidanceLine = createElement('div');
        guidanceLine.textContent = entry.guidanceSummary;
        detailContainer.appendChild(guidanceLine);
      }
      if (Array.isArray(entry.nextSteps) && entry.nextSteps.length) {
        const steps = createElement('ul', 'mb-0 ps-3');
        entry.nextSteps.forEach((stepText) => {
          const item = createElement('li');
          item.textContent = stepText;
          steps.appendChild(item);
        });
        detailContainer.appendChild(steps);
      }
      if (Array.isArray(entry.details) && entry.details.length) {
        const detailList = createElement('ul', 'mb-0 ps-3');
        entry.details.forEach((detailText) => {
          const item = createElement('li');
          item.textContent = detailText;
          detailList.appendChild(item);
        });
        detailContainer.appendChild(detailList);
      }
      detailsNode.appendChild(detailContainer);
      article.appendChild(detailsNode);
    }

    fragment.appendChild(article);
  });
  nodes.list.appendChild(fragment);
}

function appendActivityEntry(entry, { autoOpen = false } = {}) {
  activityEntries = [entry, ...activityEntries].slice(0, ACTIVITY_MAX_ENTRIES);
  renderActivityEntries();
  refreshOpenSettingsDialog();
  if (autoOpen) {
    setActivityPanelVisible(true, { persist: false });
  }
  persistActivityState();
}

function logActivityEvent({
  row,
  actionKey,
  status,
  summary,
  code = '',
  details = [],
  guidanceSummary = '',
  nextSteps = [],
  autoOpen = false,
}) {
  const timestampMs = Date.now();
  const entry = {
    timestampMs,
    timestampLabel: formatActivityTimestamp(timestampMs),
    projectId: sanitizeActivityText(row?.project_id || ''),
    projectLabel: sanitizeActivityText(row?.project_name || row?.project_id || 'Project'),
    actionLabel: sanitizeActivityText(actionLabel(actionKey)),
    status,
    summary: sanitizeActivityText(summary) || 'No summary.',
    code: sanitizeActivityText(code),
    details: sanitizeActivityList(details),
    guidanceSummary: sanitizeActivityText(guidanceSummary),
    nextSteps: sanitizeActivityList(nextSteps),
  };
  appendActivityEntry(entry, { autoOpen });
}

function extractActivityError(error, fallbackMessage = 'Action failed.') {
  const payload = error?.payload || {};
  const code = sanitizeActivityText(payload?.code || '');
  const message = sanitizeActivityText(error?.message || fallbackMessage) || fallbackMessage;
  const guidance = payload?.guidance || {};
  return {
    code,
    message,
    details: sanitizeActivityList(payload?.details),
    guidanceSummary: sanitizeActivityText(guidance?.summary || ''),
    nextSteps: sanitizeActivityList(guidance?.next_steps),
  };
}

function onActivityClear() {
  activityEntries = [];
  renderActivityEntries();
  persistActivityState();
  setFeedback('Activity log cleared.');
}

function onActivityFilterInput(event) {
  activityFilterQuery = String(event?.target?.value || '').trim();
  renderActivityEntries();
  persistActivityState();
}

async function onActivityCopy() {
  const text = buildActivityCopyText();
  if (!text) {
    const hasFilter = normalizeActivityFilterQuery(activityFilterQuery).length > 0;
    showToast(
      hasFilter ? 'No activity matches the current filter.' : 'Activity log is empty.',
      true
    );
    return;
  }
  if (!navigator?.clipboard?.writeText) {
    showToast('Clipboard API is unavailable in this browser.', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setFeedback('Activity log copied.');
  } catch (_error) {
    showToast('Unable to copy activity log.', true);
  }
}

async function onCopyDiagnosticsTemplate() {
  const row = rowsByProjectId.get(activeSettingsProjectId);
  if (!row) {
    showToast('Open project settings before copying diagnostics.', true);
    return;
  }

  const diagnosticsModel = buildDiagnosticsModel(row);
  const text = diagnosticsModel.copyTemplateText;
  if (!text.trim()) {
    showToast('Diagnostics template is empty.', true);
    return;
  }
  if (!navigator?.clipboard?.writeText) {
    showToast('Clipboard API is unavailable in this browser.', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setFeedback('Diagnostics template copied.');
  } catch (_error) {
    showToast('Unable to copy diagnostics template.', true);
  }
}

function onActivityResizeStart(event) {
  if (event.button !== 0 || !activityPanelVisible) {
    return;
  }
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = activityPanelWidth;

  const onMouseMove = (moveEvent) => {
    const delta = startX - moveEvent.clientX;
    setActivityPanelWidth(startWidth + delta, { persist: false });
  };

  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    setActivityPanelWidth(activityPanelWidth);
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function setLoading(loading, message = '') {
  setHeaderStatus(Boolean(loading), message);
}

function formatRefreshTimestamp(date) {
  try {
    return date.toLocaleTimeString([], { hour12: false });
  } catch (_error) {
    return `${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`;
  }
}

function staleAgeThresholdMs() {
  return Math.max(1000, autoRefreshIntervalMs * STALE_REFRESH_INTERVAL_MULTIPLIER);
}

function isStatusStale() {
  if (pollFailureStreak >= STALE_FAILURE_STREAK_THRESHOLD) {
    return true;
  }
  if (!Number.isFinite(lastSuccessfulRefreshMs)) {
    return false;
  }
  return Date.now() - lastSuccessfulRefreshMs > staleAgeThresholdMs();
}

function stopStaleIndicatorTimer() {
  if (staleIndicatorTimerId === null) {
    return;
  }
  window.clearTimeout(staleIndicatorTimerId);
  staleIndicatorTimerId = null;
}

function scheduleStaleIndicatorCheck() {
  stopStaleIndicatorTimer();
  if (document.visibilityState !== 'visible') {
    return;
  }
  if (pollFailureStreak >= STALE_FAILURE_STREAK_THRESHOLD) {
    return;
  }
  if (!Number.isFinite(lastSuccessfulRefreshMs)) {
    return;
  }

  const remainingMs = staleAgeThresholdMs() - (Date.now() - lastSuccessfulRefreshMs);
  if (remainingMs <= 0) {
    return;
  }

  staleIndicatorTimerId = window.setTimeout(() => {
    staleIndicatorTimerId = null;
    updateRefreshIndicators();
  }, remainingMs + 50);
}

function updateRefreshIndicators() {
  const nodes = getRefreshNodes();
  if (nodes.autoRefreshOffHint) {
    nodes.autoRefreshOffHint.classList.toggle('d-none', autoRefreshEnabled);
  }

  const staleNow = isStatusStale();
  if (nodes.staleIndicator) {
    nodes.staleIndicator.classList.toggle('d-none', !staleNow);
    nodes.staleIndicator.disabled = loadStatusesPromise !== null;
    const hasRefreshErrors = pollFailureStreak >= STALE_FAILURE_STREAK_THRESHOLD;
    nodes.staleIndicator.textContent = hasRefreshErrors
      ? 'Status may be stale (refresh errors)'
      : 'Status may be stale';
  }

  scheduleStaleIndicatorCheck();
}

function setLastRefreshed(date) {
  const nodes = getRefreshNodes();
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
    lastSuccessfulRefreshMs = null;
    if (nodes.lastRefreshed) {
      nodes.lastRefreshed.textContent = 'Last refreshed: --';
    }
    updateRefreshIndicators();
    return;
  }
  lastSuccessfulRefreshMs = date.valueOf();
  if (nodes.lastRefreshed) {
    nodes.lastRefreshed.textContent = `Last refreshed: ${formatRefreshTimestamp(date)}`;
  }
  updateRefreshIndicators();
}

function mapStateLabel(value, context = 'generic') {
  const key = String(value || '').trim() || 'unknown';
  const contextLabels = CONTEXT_STATE_LABELS[context] || null;
  if (contextLabels && contextLabels[key]) {
    return contextLabels[key];
  }
  return STATE_LABELS[key] || key;
}

function buildStateBadge(value, context = 'generic') {
  const key = String(value || '').trim() || 'unknown';
  const badge = createElement('span', 'badge');
  badge.classList.add(BADGE_CLASS_BY_STATE[key] || 'text-bg-secondary');
  badge.textContent = mapStateLabel(key, context);
  return badge;
}

function gitStateSummary(row) {
  const state = row?.states?.git || 'unknown';
  const status = row?.git_status;
  if (!status) {
    return mapStateLabel(state);
  }
  const branch = status.branch || 'detached';
  const ahead = Number(status.ahead || 0);
  const behind = Number(status.behind || 0);
  const dirty = status.is_dirty ? ', has uncommitted changes' : ', up to date';
  return `${branch} (${ahead} ahead, ${behind} behind${dirty})`;
}

function mapLocalReasonLabel(reasonCode) {
  const key = String(reasonCode || '').trim();
  if (!key) {
    return '';
  }
  if (LOCAL_REASON_LABELS[key]) {
    return LOCAL_REASON_LABELS[key];
  }
  return key.replace(/[-_]+/g, ' ');
}

function localStateSummary(row) {
  const localState = row?.states?.local_metadata || 'unknown';
  const reason = row?.states?.local_reason;
  const stateLabel = mapStateLabel(localState, 'local');
  const reasonLabel = mapLocalReasonLabel(reason);
  if (!reasonLabel) {
    return stateLabel;
  }
  return `${stateLabel} (${reasonLabel})`;
}

function buildActionButton(
  row,
  key,
  label,
  { buttonClass = 'btn btn-outline-secondary btn-sm' } = {}
) {
  const config = resolveRowActionState(row, key);
  const button = createElement('button', buttonClass);
  button.type = 'button';
  button.textContent = label;
  button.dataset.action = key;
  button.dataset.projectId = String(row.project_id || '');
  if (!config.enabled) {
    button.disabled = true;
  }
  if (config.reason) {
    button.title = String(config.reason);
  }
  button.addEventListener('click', () => {
    void triggerAction(row, key);
  });
  return button;
}

function resolveRowActionState(row, actionKey) {
  if (actionKey === 'status') {
    return { enabled: true, reason: '' };
  }
  const config = row?.actions?.[actionKey] || { enabled: false, reason: 'unsupported' };
  return {
    enabled: Boolean(config.enabled),
    reason: String(config.reason || ''),
  };
}

function resolveRowActionStateForRecommendation(row, actionKey) {
  return resolveRowActionState(row, actionKey);
}

function resolveRecommendedActionKeyForRow(row) {
  return resolveRecommendedActionKey(row, resolveRowActionStateForRecommendation);
}

function getRowPrimaryActionKey(row, visibleActionKeys) {
  return resolveVisiblePrimaryActionKey(
    row,
    visibleActionKeys,
    resolveRowActionStateForRecommendation
  );
}

function contextActionLabel(actionKey) {
  const labels = {
    settings: 'Sync settings...',
    status: 'Refresh status',
    commit_push: 'Commit & Push',
    pull_import: 'Pull & Import',
    export_metadata: 'Export metadata',
    import_metadata: 'Import metadata',
    open_folder: 'Open folder',
  };
  return labels[actionKey] || actionKey;
}

function updateContextMenuActions(row) {
  const nodes = getContextMenuNodes();
  if (!nodes.menu) {
    return;
  }
  const recommendedActionKey = resolveRecommendedActionKeyForRow(row);
  let recommendedAssigned = false;
  nodes.actionButtons.forEach((button) => {
    const actionKey = String(button?.dataset?.contextAction || '').trim();
    if (!actionKey) {
      return;
    }
    button.classList.remove('sync-manager-context-menu-recommended');
    button.removeAttribute('data-context-recommended');
    if (actionKey === 'settings') {
      button.disabled = false;
      const isRecommended = !recommendedAssigned && recommendedActionKey === actionKey;
      if (isRecommended) {
        recommendedAssigned = true;
        button.classList.add('sync-manager-context-menu-recommended');
        button.dataset.contextRecommended = 'true';
        button.title = `Recommended next step: ${contextActionLabel(actionKey)}`;
      } else {
        button.title = contextActionLabel(actionKey);
      }
      return;
    }
    const actionState = resolveRowActionState(row, actionKey);
    button.disabled = !actionState.enabled;
    const reasonText = actionState.reason ? sanitizeActivityText(actionState.reason) : '';
    const isRecommended =
      !recommendedAssigned && recommendedActionKey === actionKey && actionState.enabled;
    if (isRecommended) {
      recommendedAssigned = true;
      button.classList.add('sync-manager-context-menu-recommended');
      button.dataset.contextRecommended = 'true';
    }
    if (actionState.enabled) {
      button.title = isRecommended
        ? `Recommended next step: ${contextActionLabel(actionKey)}`
        : contextActionLabel(actionKey);
    } else {
      button.title = reasonText || `${contextActionLabel(actionKey)} is unavailable.`;
    }
  });
}

function buildSettingsButton(
  row,
  { buttonClass = 'btn btn-outline-secondary btn-sm', isRecommended = false } = {}
) {
  const button = createElement('button', buttonClass);
  button.type = 'button';
  button.textContent = '...';
  button.title = `Sync settings for ${row?.project_name || row?.project_id || 'project'}`;
  button.setAttribute('aria-label', button.title);
  if (isRecommended) {
    button.dataset.recommendedAction = 'settings';
    button.title = `Recommended next step: Sync settings for ${row?.project_name || row?.project_id || 'project'}`;
  } else {
    button.removeAttribute('data-recommended-action');
  }
  button.addEventListener('click', (event) => {
    openSettingsDialog(row, event.currentTarget);
  });
  return button;
}

function trackingHintText(row) {
  const gitState = String(row?.states?.git || '').trim();
  const upstream = String(row?.git_status?.upstream || '').trim();
  if (gitState !== 'ready') {
    return 'Initialize Git repository and configure a remote to enable tracking.';
  }
  if (!upstream) {
    return 'Branch is not tracking a remote branch yet. Use the Remote tab and then run Commit+Push.';
  }
  return `Tracking ${upstream}.`;
}

function normalizeRemoteField(value) {
  return String(value || '').trim();
}

function parseRemoteNameFromUpstream(upstream) {
  const text = normalizeRemoteField(upstream);
  if (!text) {
    return '';
  }
  const slashIndex = text.indexOf('/');
  if (slashIndex <= 0) {
    return '';
  }
  return text.slice(0, slashIndex).trim();
}

function redactRemoteUrlPreview(value) {
  const raw = normalizeRemoteField(value);
  if (!raw) {
    return '--';
  }
  return raw.replace(/([a-z]+:\/\/)([^@\s/]+)@/gi, '$1***@');
}

function deriveInitialRemoteState(row) {
  const projectId = String(row?.project_id || '').trim();
  const trackedRemote = parseRemoteNameFromUpstream(row?.git_status?.upstream);
  return {
    projectId,
    baseName: trackedRemote || 'origin',
    baseUrl: '',
    draftName: trackedRemote || 'origin',
    draftUrl: '',
    redactedUrl: '--',
  };
}

function isRemoteStateDirty(state) {
  if (!state) {
    return false;
  }
  return (
    normalizeRemoteField(state.draftName) !== normalizeRemoteField(state.baseName) ||
    normalizeRemoteField(state.draftUrl) !== normalizeRemoteField(state.baseUrl)
  );
}

function getRemoteEditorState(row) {
  const projectId = String(row?.project_id || '').trim();
  if (!projectId) {
    return null;
  }
  const existing = remoteEditorStateByProjectId.get(projectId);
  if (!existing) {
    const initial = deriveInitialRemoteState(row);
    remoteEditorStateByProjectId.set(projectId, initial);
    return initial;
  }

  const trackedRemote = parseRemoteNameFromUpstream(row?.git_status?.upstream);
  if (
    !isRemoteStateDirty(existing) &&
    trackedRemote &&
    normalizeRemoteField(existing.baseName) !== trackedRemote
  ) {
    existing.baseName = trackedRemote;
    existing.draftName = trackedRemote;
  } else if (!normalizeRemoteField(existing.baseName) && trackedRemote) {
    existing.baseName = trackedRemote;
    if (!normalizeRemoteField(existing.draftName)) {
      existing.draftName = trackedRemote;
    }
  }
  if (!normalizeRemoteField(existing.redactedUrl)) {
    existing.redactedUrl = '--';
  }
  return existing;
}

function updateRemoteEditorControls(row) {
  const nodes = getSettingsNodes();
  const projectId = String(row?.project_id || '').trim();
  if (!projectId) {
    return;
  }
  const state = getRemoteEditorState(row);
  if (!state) {
    return;
  }

  const actionState = row?.actions?.set_remote || { enabled: false, reason: 'unsupported' };
  const canUseRemoteAction = Boolean(actionState.enabled);
  const dirty = isRemoteStateDirty(state);
  const draftUrl = normalizeRemoteField(state.draftUrl);
  const remoteName = normalizeRemoteField(state.draftName) || 'origin';

  if (nodes.remoteName) {
    nodes.remoteName.disabled = !canUseRemoteAction || remoteSetRequestInFlight;
  }
  if (nodes.remoteUrl) {
    nodes.remoteUrl.disabled = !canUseRemoteAction || remoteSetRequestInFlight;
  }

  const redactedFromDraft = draftUrl ? redactRemoteUrlPreview(draftUrl) : '';
  const redactedPreview = redactedFromDraft || normalizeRemoteField(state.redactedUrl) || '--';
  if (nodes.remoteUrlPreview) {
    nodes.remoteUrlPreview.textContent = `Remote URL preview: ${redactedPreview}`;
  }

  if (nodes.tracking) {
    nodes.tracking.textContent = trackingHintText(row);
  }

  let statusText = 'Set Remote is enabled when remote name or URL changes.';
  let canSubmit = false;
  if (!canUseRemoteAction) {
    statusText = actionState.reason
      ? `Set Remote unavailable: ${sanitizeActivityText(actionState.reason)}`
      : 'Set Remote is unavailable for this project state.';
  } else if (!dirty) {
    statusText = 'No remote changes detected.';
  } else if (!draftUrl) {
    statusText = 'Remote URL is required before applying changes.';
  } else if (remoteSetRequestInFlight) {
    statusText = `Applying remote ${remoteName}...`;
  } else {
    statusText = `Ready to apply changes to remote ${remoteName}.`;
    canSubmit = true;
  }

  if (nodes.remoteStatus) {
    nodes.remoteStatus.textContent = statusText;
  }
  if (nodes.setRemoteButton) {
    nodes.setRemoteButton.disabled = !canSubmit;
  }
}

function renderSettingsRemote(row) {
  const nodes = getSettingsNodes();
  const projectId = String(row?.project_id || '').trim();
  if (!projectId) {
    return;
  }
  const state = getRemoteEditorState(row);
  if (!state) {
    return;
  }

  if (nodes.remoteName && document.activeElement !== nodes.remoteName) {
    nodes.remoteName.value = normalizeRemoteField(state.draftName) || 'origin';
  }
  if (nodes.remoteUrl && document.activeElement !== nodes.remoteUrl) {
    nodes.remoteUrl.value = normalizeRemoteField(state.draftUrl);
  }
  updateRemoteEditorControls(row);
}

function extractSetRemoteResultPayload(result) {
  if (result && typeof result === 'object' && result.result && typeof result.result === 'object') {
    return result.result;
  }
  if (result && typeof result === 'object') {
    return result;
  }
  return {};
}

function applyRemoteActionResult(row, actionResult) {
  const projectId = String(row?.project_id || '').trim();
  if (!projectId) {
    return;
  }
  const state = getRemoteEditorState(row);
  if (!state) {
    return;
  }
  const payload = extractSetRemoteResultPayload(actionResult);
  const nextName =
    normalizeRemoteField(payload?.remote_name) || normalizeRemoteField(state.draftName) || 'origin';
  const nextUrl = normalizeRemoteField(state.draftUrl);
  const nextRedacted =
    normalizeRemoteField(payload?.remote_url_redacted) || redactRemoteUrlPreview(nextUrl);
  state.baseName = nextName;
  state.baseUrl = nextUrl;
  state.draftName = nextName;
  state.draftUrl = nextUrl;
  state.redactedUrl = nextRedacted || '--';
  remoteEditorStateByProjectId.set(projectId, state);
}

function renderSettingsActions(row) {
  const nodes = getSettingsNodes();
  if (!nodes.actions) return;
  clearNode(nodes.actions);

  const recommendedActionKey = resolveRecommendedActionKeyForRow(row);
  const statusButtonClass =
    recommendedActionKey === 'status'
      ? 'btn btn-primary btn-sm'
      : 'btn btn-outline-secondary btn-sm';
  const buttons = [];
  buttons.push(buildActionButton(row, 'status', 'Refresh', { buttonClass: statusButtonClass }));

  const recommendedActions = [
    ['init_repo', 'Init Repo'],
    ['commit_push', 'Commit & Push'],
    ['pull_import', 'Pull & Import'],
    ['export_metadata', 'Export metadata'],
    ['import_metadata', 'Import metadata'],
    ['open_folder', 'Open folder'],
  ];
  let primaryActionEntry = null;
  if (recommendedActionKey && !['status', 'settings'].includes(recommendedActionKey)) {
    const match = recommendedActions.find(([actionKey]) => actionKey === recommendedActionKey);
    if (match && resolveRowActionState(row, recommendedActionKey).enabled) {
      primaryActionEntry = match;
    }
  }
  if (!primaryActionEntry) {
    primaryActionEntry =
      recommendedActions.find(([actionKey]) => resolveRowActionState(row, actionKey).enabled) ||
      null;
  }
  if (primaryActionEntry) {
    const [actionKey, label] = primaryActionEntry;
    const buttonClass =
      recommendedActionKey === 'status'
        ? 'btn btn-outline-secondary btn-sm'
        : 'btn btn-primary btn-sm';
    buttons.push(buildActionButton(row, actionKey, label, { buttonClass }));
  }

  let focusedButtonAssigned = false;
  buttons.forEach((button) => {
    if (!focusedButtonAssigned && !button.disabled) {
      button.dataset.settingsPrimary = 'true';
      focusedButtonAssigned = true;
    }
    nodes.actions.appendChild(button);
  });
}

function findLatestFailedEntryForProject(row) {
  const projectId = String(row?.project_id || '').trim();
  const projectName = sanitizeActivityText(row?.project_name || '');
  if (!projectId && !projectName) {
    return null;
  }
  return (
    activityEntries.find((entry) => {
      if (entry?.status !== 'Failed') {
        return false;
      }
      const entryProjectId = String(entry?.projectId || '').trim();
      const entryProjectLabel = sanitizeActivityText(entry?.projectLabel || '');
      return (
        (projectId && entryProjectId === projectId) ||
        (projectId && entryProjectLabel === projectId) ||
        (projectName && entryProjectLabel === projectName)
      );
    }) || null
  );
}

function resolveDiagnosticsRemoteName(row) {
  const upstreamRemote = parseRemoteNameFromUpstream(row?.git_status?.upstream);
  if (upstreamRemote) {
    return upstreamRemote;
  }
  return 'origin';
}

function buildDiagnosticsTemplateText(row, latestFailure, hint, { includeFullPath = false } = {}) {
  const projectName = sanitizeActivityText(row?.project_name || row?.project_id || 'Project');
  const projectId = sanitizeActivityText(row?.project_id || 'unknown');
  const rawRootPath = normalizeRemoteField(row?.root_path);
  const diagnosticsRootPath = includeFullPath
    ? rawRootPath || '<project_root>'
    : redactedProjectRootLabel(rawRootPath);
  const remoteName = sanitizeActivityText(resolveDiagnosticsRemoteName(row)) || 'origin';
  const rootCommand = isLikelyWindowsPath(diagnosticsRootPath)
    ? `cd /d "${diagnosticsRootPath}"`
    : `cd "${diagnosticsRootPath}"`;
  const lines = [
    '# Sync Manager diagnostics template',
    `Project: ${projectName}`,
    `Project ID: ${projectId}`,
  ];

  if (latestFailure?.code) {
    lines.push(`Last failure code: ${sanitizeActivityText(latestFailure.code)}`);
  }
  if (hint?.summary) {
    lines.push(`Hint: ${sanitizeActivityText(hint.summary)}`);
  }

  lines.push('');
  lines.push('# Run these commands in a terminal from a safe local context');
  lines.push(`1. ${rootCommand}`);
  DIAGNOSTIC_COMMAND_TEMPLATES.forEach((commandText, index) => {
    const withRemote = commandText.replace('<remote_name>', remoteName);
    lines.push(`${index + 2}. ${withRemote}`);
  });
  return lines.join('\n');
}

function buildDiagnosticsModel(row) {
  const latestFailure = findLatestFailedEntryForProject(row);
  const hint = resolveSmartHint({
    code: latestFailure?.code || '',
    message: latestFailure?.summary || '',
    guidanceSummary: latestFailure?.guidanceSummary || '',
  });
  return {
    latestFailure,
    hint,
    previewTemplateText: buildDiagnosticsTemplateText(row, latestFailure, hint, {
      includeFullPath: false,
    }),
    copyTemplateText: buildDiagnosticsTemplateText(row, latestFailure, hint, {
      includeFullPath: true,
    }),
  };
}

function renderSettingsDiagnostics(row) {
  const nodes = getSettingsNodes();
  if (!row) return;

  const diagnosticsModel = buildDiagnosticsModel(row);
  const latestFailure = diagnosticsModel.latestFailure;
  const hint = diagnosticsModel.hint;

  if (nodes.diagnosticsHint) {
    nodes.diagnosticsHint.textContent =
      hint?.summary || 'No recent sync failures for this project.';
  }
  if (nodes.diagnosticsCode) {
    const codeText = latestFailure?.code ? sanitizeActivityText(latestFailure.code) : '--';
    nodes.diagnosticsCode.textContent = `Last code: ${codeText}`;
  }

  const hintSteps = hint?.steps || [];
  replaceListItems(nodes.diagnosticsSteps, hintSteps);
  setListVisibility(nodes.diagnosticsSteps, hintSteps.length > 0);

  const failureDetails = Array.isArray(latestFailure?.details) ? latestFailure.details : [];
  replaceListItems(nodes.diagnosticsDetails, failureDetails);
  setListVisibility(nodes.diagnosticsDetailsWrap, failureDetails.length > 0);

  if (nodes.diagnosticsPreview) {
    nodes.diagnosticsPreview.textContent = diagnosticsModel.previewTemplateText;
  }
}

function renderSettingsDialog(row) {
  const nodes = getSettingsNodes();
  if (!row || !nodes.dialog) return;

  const projectName = String(row?.project_name || row?.project_id || 'Project');
  if (nodes.title) {
    nodes.title.textContent = `Sync settings - ${projectName}`;
  }
  if (nodes.summary) {
    nodes.summary.textContent = `${gitStateSummary(row)}; ${localStateSummary(row)}.`;
  }
  if (nodes.root) {
    nodes.root.textContent = projectPathLabel(row?.root_path);
  }
  if (nodes.branch) {
    const branch = sanitizeActivityText(row?.git_status?.branch || 'detached');
    const upstream = sanitizeActivityText(row?.git_status?.upstream || 'none');
    nodes.branch.textContent = `${branch} (upstream: ${upstream})`;
  }
  if (nodes.pps) {
    const ppsState = mapStateLabel(row?.states?.pps || 'unknown', 'pps');
    nodes.pps.textContent = ppsState;
  }
  if (nodes.local) {
    nodes.local.textContent = localStateSummary(row);
  }

  renderSettingsActions(row);
  renderSettingsRemote(row);
  renderSettingsDiagnostics(row);
  setActiveSettingsTab(activeSettingsTabId);
}

function findSettingsTriggerForProject(projectId) {
  const projectIdValue = String(projectId || '').trim();
  if (!projectIdValue) {
    return null;
  }
  const rowNode = document.querySelector(`tr[data-project-id="${projectIdValue}"]`);
  if (!rowNode) {
    return null;
  }
  return rowNode.querySelector('button[aria-label^="Sync settings for"]');
}

function isContextMenuVisible() {
  const nodes = getContextMenuNodes();
  if (!nodes.menu) return false;
  return isSyncManagerContextMenuVisible(nodes.menu);
}

function closeContextMenu({ restoreFocus = false } = {}) {
  const nodes = getContextMenuNodes();
  if (!nodes.menu || !isContextMenuVisible()) {
    return;
  }
  closeSyncManagerContextMenu(nodes.menu);
  const focusTarget = contextMenuReturnFocusNode;
  contextMenuProjectId = '';
  contextMenuReturnFocusNode = null;
  if (restoreFocus && focusTarget instanceof HTMLElement && document.contains(focusTarget)) {
    focusTarget.focus();
  }
}

function positionContextMenu(menuNode, x, y) {
  if (!menuNode) {
    return;
  }
  positionSyncManagerContextMenu(menuNode, x, y);
}

function openContextMenuForRow(row, { x, y, triggerNode = null } = {}) {
  const rowProjectId = String(row?.project_id || '').trim();
  if (!rowProjectId) {
    return;
  }
  const nodes = getContextMenuNodes();
  if (!nodes.menu || !nodes.actionButtons.length) {
    return;
  }

  updateContextMenuActions(row);
  contextMenuProjectId = rowProjectId;
  contextMenuReturnFocusNode =
    triggerNode instanceof HTMLElement ? triggerNode : document.activeElement;
  positionContextMenu(nodes.menu, Number(x) || 0, Number(y) || 0);
  const firstEnabled = nodes.actionButtons.find((button) => !button.disabled);
  if (firstEnabled instanceof HTMLElement) {
    firstEnabled.focus();
  }
}

function shouldIgnoreContextMenuTarget(targetNode) {
  return shouldIgnoreSyncManagerContextMenuTarget(targetNode);
}

function handleRowContextMenu(event, row, rowNode) {
  if (!row || !rowNode) {
    return;
  }
  if (shouldIgnoreContextMenuTarget(event.target)) {
    return;
  }
  event.preventDefault();
  openContextMenuForRow(row, {
    x: event.clientX,
    y: event.clientY,
    triggerNode: findSettingsTriggerForProject(row.project_id) || rowNode,
  });
}

function handleRowContextMenuKeydown(event, row, rowNode) {
  if (!row || !rowNode) {
    return;
  }
  const key = String(event.key || '');
  const isKeyboardContextMenu = key === 'ContextMenu' || (event.shiftKey && key === 'F10');
  if (!isKeyboardContextMenu) {
    return;
  }
  event.preventDefault();
  const rowRect = rowNode.getBoundingClientRect();
  const y = rowRect.top + Math.min(24, Math.max(8, rowRect.height / 2));
  const x = rowRect.left + 24;
  openContextMenuForRow(row, {
    x,
    y,
    triggerNode: findSettingsTriggerForProject(row.project_id) || rowNode,
  });
}

function openSettingsDialog(row, triggerNode = null) {
  const nodes = getSettingsNodes();
  if (!row || !nodes.dialog) {
    return;
  }

  closeContextMenu({ restoreFocus: false });
  activeSettingsProjectId = String(row.project_id || '');
  activeSettingsTabId = 'overview';
  settingsReturnFocusNode =
    triggerNode instanceof HTMLElement ? triggerNode : document.activeElement;
  renderSettingsDialog(row);

  if (!nodes.dialog.open && typeof nodes.dialog.showModal === 'function') {
    nodes.dialog.showModal();
  }

  setActiveSettingsTab(activeSettingsTabId);

  const firstAction = nodes.actions?.querySelector(
    'button[data-settings-primary="true"]:not([disabled])'
  );
  if (firstAction instanceof HTMLElement) {
    firstAction.focus();
    return;
  }
  const activeTabButton = nodes.tabs.find(
    (tabButton) => tabButton.getAttribute('aria-selected') === 'true'
  );
  if (activeTabButton instanceof HTMLElement) {
    activeTabButton.focus();
    return;
  }
  if (nodes.closeButton instanceof HTMLElement) {
    nodes.closeButton.focus();
  }
}

function closeSettingsDialog() {
  const nodes = getSettingsNodes();
  if (!nodes.dialog || !nodes.dialog.open) {
    return;
  }
  nodes.dialog.close();
}

function refreshOpenSettingsDialog() {
  const nodes = getSettingsNodes();
  if (!nodes.dialog || !nodes.dialog.open || !activeSettingsProjectId) {
    return;
  }
  const row = rowsByProjectId.get(activeSettingsProjectId);
  if (!row) {
    closeSettingsDialog();
    return;
  }
  renderSettingsDialog(row);
}

function openSettingsDialogFromContextMenu() {
  const projectId = contextMenuProjectId;
  if (!projectId) {
    closeContextMenu({ restoreFocus: false });
    return;
  }
  const row = rowsByProjectId.get(projectId);
  const settingsTrigger = findSettingsTriggerForProject(projectId);
  closeContextMenu({ restoreFocus: false });
  if (!row) {
    return;
  }
  openSettingsDialog(row, settingsTrigger);
}

function onContextMenuActionClick(event) {
  const button =
    event.target instanceof HTMLElement ? event.target.closest('[data-context-action]') : null;
  if (!(button instanceof HTMLButtonElement) || button.disabled) {
    return;
  }
  const actionKey = String(button.dataset.contextAction || '').trim();
  if (!actionKey) {
    return;
  }
  if (actionKey === 'settings') {
    openSettingsDialogFromContextMenu();
    return;
  }

  const projectId = String(contextMenuProjectId || '').trim();
  const row = rowsByProjectId.get(projectId);
  closeContextMenu({ restoreFocus: false });
  if (!row) {
    return;
  }
  void triggerAction(row, actionKey);
}

function collectRowActionButtons(row) {
  const group = createElement('div', 'd-flex flex-wrap justify-content-end gap-1');
  const visibleActionKeys = ['status'];
  if (showAdvancedRowActions) {
    visibleActionKeys.push(
      'open_folder',
      'export_metadata',
      'import_metadata',
      'init_repo',
      'commit_push',
      'pull_import'
    );
  }
  const recommendedActionKey = resolveRecommendedActionKeyForRow(row);
  const primaryActionKey = getRowPrimaryActionKey(row, visibleActionKeys);
  visibleActionKeys.forEach((actionKey) => {
    const labelMap = {
      status: 'Refresh',
      open_folder: 'Open folder',
      export_metadata: 'Export',
      import_metadata: 'Import',
      init_repo: 'Init Repo',
      commit_push: 'Commit & Push',
      pull_import: 'Pull & Import',
    };
    const buttonClass =
      actionKey === primaryActionKey
        ? 'btn btn-primary btn-sm'
        : 'btn btn-outline-secondary btn-sm';
    group.appendChild(
      buildActionButton(row, actionKey, labelMap[actionKey] || actionKey, { buttonClass })
    );
  });
  const settingsIsRecommended = recommendedActionKey === 'settings';
  group.appendChild(
    buildSettingsButton(row, {
      buttonClass: settingsIsRecommended
        ? 'btn btn-primary btn-sm'
        : 'btn btn-outline-secondary btn-sm',
      isRecommended: settingsIsRecommended,
    })
  );
  return group;
}

function renderRows(rows) {
  const body = document.getElementById('sync-manager-body');
  const empty = document.getElementById('sync-manager-empty-row');
  if (!body) return;

  const list = Array.isArray(rows) ? rows : [];
  rowsByProjectId = new Map(list.map((row) => [String(row?.project_id || ''), row]));
  for (const cachedProjectId of Array.from(remoteEditorStateByProjectId.keys())) {
    if (!rowsByProjectId.has(cachedProjectId)) {
      remoteEditorStateByProjectId.delete(cachedProjectId);
    }
  }
  if (contextMenuProjectId) {
    const contextRow = rowsByProjectId.get(contextMenuProjectId);
    if (!contextRow) {
      closeContextMenu({ restoreFocus: false });
    } else if (isContextMenuVisible()) {
      updateContextMenuActions(contextRow);
    }
  }
  const existingRows = body.querySelectorAll('tr[data-project-id]');
  existingRows.forEach((row) => row.remove());

  if (!list.length) {
    if (empty) {
      empty.classList.remove('d-none');
    }
    return;
  }
  if (empty) {
    empty.classList.add('d-none');
  }

  const fragment = document.createDocumentFragment();
  list.forEach((row) => {
    const tr = createElement('tr');
    const accentColor = resolveProjectAccentColor(row);
    tr.style.setProperty('--sync-project-color', accentColor);
    if (projectColorStyle === 'row') {
      tr.classList.add('sync-manager-row-colored');
    }
    tr.dataset.projectId = String(row.project_id || '');
    tr.addEventListener('contextmenu', (event) => {
      handleRowContextMenu(event, row, tr);
    });
    tr.addEventListener('keydown', (event) => {
      handleRowContextMenuKeydown(event, row, tr);
    });

    const projectTd = createElement('td');
    const projectName = String(row.project_name || row.project_id || 'Unnamed project');
    const nameLine = createElement('div', 'fw-semibold sync-manager-project-name');
    if (projectColorStyle === 'pill') {
      const pill = createElement('span', 'sync-manager-project-pill');
      pill.textContent = projectName;
      pill.style.setProperty('--sync-project-color', accentColor);
      pill.style.setProperty('--sync-project-pill-text', pickReadableTextColor(accentColor));
      nameLine.appendChild(pill);
    } else {
      nameLine.textContent = projectName;
    }
    projectTd.appendChild(nameLine);
    if (projectColorStyle !== 'pill') {
      const rootLabel = projectPathLabel(row.root_path);
      const rootLine = createElement('div', 'small text-muted');
      rootLine.textContent = rootLabel;
      projectTd.appendChild(rootLine);
    }
    tr.appendChild(projectTd);

    const gitTd = createElement('td');
    gitTd.appendChild(buildStateBadge(row?.states?.git, 'git'));
    tr.appendChild(gitTd);

    const ppsTd = createElement('td');
    ppsTd.appendChild(buildStateBadge(row?.states?.pps, 'pps'));
    tr.appendChild(ppsTd);

    const localTd = createElement('td');
    localTd.appendChild(buildStateBadge(row?.states?.local_metadata, 'local'));
    tr.appendChild(localTd);

    const localFilesTd = createElement('td');
    const localFilesSummary = resolveLocalFilesSummary(row);
    if (localFilesSummary.kind === 'chips') {
      const localFilesChips = createElement(
        'div',
        'd-inline-flex flex-wrap align-items-center gap-1'
      );
      localFilesChips.title = String(localFilesSummary.title || '');
      (localFilesSummary.chips || []).forEach((chip) => {
        const tone = String(chip?.tone || 'neutral');
        let chipClass = 'badge rounded-pill text-bg-secondary';
        if (tone === 'modified') {
          chipClass = 'badge rounded-pill text-bg-primary';
        } else if (tone === 'added') {
          chipClass = 'badge rounded-pill text-bg-success';
        } else if (tone === 'deleted') {
          chipClass = 'badge rounded-pill text-bg-danger';
        } else if (tone === 'untracked') {
          chipClass = 'badge rounded-pill text-bg-warning';
        } else if (tone === 'clean') {
          chipClass = 'badge rounded-pill text-bg-success';
        }
        const chipNode = createElement('span', chipClass);
        chipNode.title = String(localFilesSummary.title || '');
        chipNode.textContent = String(chip?.label || '');
        localFilesChips.appendChild(chipNode);
      });
      localFilesTd.appendChild(localFilesChips);
    } else {
      const localFilesLabel = createElement('span', 'small text-muted');
      localFilesLabel.textContent = String(localFilesSummary.label || '--');
      localFilesLabel.title = String(localFilesSummary.title || '');
      localFilesTd.appendChild(localFilesLabel);
    }
    tr.appendChild(localFilesTd);

    const actionsTd = createElement('td', 'text-end');
    actionsTd.appendChild(collectRowActionButtons(row));
    tr.appendChild(actionsTd);

    fragment.appendChild(tr);
  });

  body.appendChild(fragment);
  refreshOpenSettingsDialog();
}

function parseDeleteCount(details) {
  if (!Array.isArray(details)) {
    return null;
  }
  for (const item of details) {
    const text = String(item || '').trim();
    const match = /^delete_count=(\d+)$/i.exec(text);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

function parseRequiredPhrase(details) {
  if (!Array.isArray(details)) {
    return null;
  }
  for (const item of details) {
    const text = String(item || '').trim();
    const match = /^required_phrase=(.+)$/i.exec(text);
    if (match) {
      return String(match[1]).trim() || null;
    }
  }
  return null;
}

function renderApiError(error, fallbackMessage = 'Action failed.') {
  const errorBox = document.getElementById('sync-manager-error');
  if (!errorBox) return;

  clearNode(errorBox);
  const payload = error?.payload || {};
  const code = sanitizeActivityText(payload?.code || '');
  const message = sanitizeActivityText(error?.message || fallbackMessage) || fallbackMessage;

  const headline = createElement('div', 'fw-semibold');
  headline.textContent = code ? `[${code}] ${message}` : message;
  errorBox.appendChild(headline);

  const guidance = payload?.guidance;
  const guidanceSummary = sanitizeActivityText(guidance?.summary || '');
  if (guidanceSummary) {
    const guidanceText = createElement('div', 'small mt-1');
    guidanceText.textContent = guidanceSummary;
    errorBox.appendChild(guidanceText);
  }

  const guidanceSteps = Array.isArray(guidance?.next_steps) ? guidance.next_steps : [];
  if (guidanceSteps.length) {
    const list = createElement('ul', 'small mb-0 mt-1 ps-3');
    guidanceSteps.forEach((step) => {
      const item = createElement('li');
      item.textContent = sanitizeActivityText(step);
      list.appendChild(item);
    });
    errorBox.appendChild(list);
  }

  const details = sanitizeActivityList(payload?.details);
  if (details.length) {
    const detailsBlock = createElement('details', 'mt-2');
    const summary = createElement('summary', 'small');
    summary.textContent = 'Technical details';
    detailsBlock.appendChild(summary);
    const list = createElement('ul', 'small mb-0 mt-1 ps-3');
    details.forEach((entry) => {
      const item = createElement('li');
      item.textContent = entry;
      list.appendChild(item);
    });
    detailsBlock.appendChild(list);
    errorBox.appendChild(detailsBlock);
  }

  showNode(errorBox);
}

function renderActionErrorToast(error, fallbackMessage = 'Action failed.') {
  const activityError = extractActivityError(error, fallbackMessage);
  showToast(
    activityError.code ? `[${activityError.code}] ${activityError.message}` : activityError.message,
    true
  );
}

async function loadStatuses({ showLoading = true, silentError = false } = {}) {
  if (loadStatusesPromise) {
    updateRefreshIndicators();
    return loadStatusesPromise;
  }

  clearError();
  if (showLoading) {
    setLoading(true, 'Loading project sync status...');
  }

  loadStatusesPromise = (async () => {
    const payload = await requestJson(STATUS_ENDPOINT);
    renderRows(payload?.projects || []);
    setLastRefreshed(new Date());
    pollFailureStreak = 0;
    updateRefreshIndicators();
    return payload;
  })();
  updateRefreshIndicators();

  try {
    return await loadStatusesPromise;
  } catch (error) {
    if (!silentError) {
      renderApiError(error, 'Unable to load Sync Manager status.');
    }
    throw error;
  } finally {
    loadStatusesPromise = null;
    updateRefreshIndicators();
    if (showLoading) {
      setLoading(false);
    }
  }
}

function confirmImportRun(projectName, actionLabel) {
  return window.confirm(
    `${actionLabel} for "${projectName}"?\n\nThis will apply the current metadata snapshot to local metadata.`
  );
}

function buildActionPayload(row, actionKey) {
  const projectId = String(row?.project_id || '').trim();
  if (!projectId) {
    throw new Error('Missing project identifier.');
  }

  if (actionKey === 'set_remote') {
    const state = getRemoteEditorState(row);
    if (!state) {
      return null;
    }
    const remoteName = normalizeRemoteField(state.draftName) || 'origin';
    const remoteUrl = normalizeRemoteField(state.draftUrl);
    if (!remoteUrl || !isRemoteStateDirty(state)) {
      return null;
    }
    return {
      project_id: projectId,
      remote_url: remoteUrl,
      remote_name: remoteName,
    };
  }

  if (actionKey === 'commit_push') {
    const commitMessage = window.prompt('Commit message:', 'Sync metadata');
    if (commitMessage === null) {
      return null;
    }
    return {
      project_id: projectId,
      commit_message: commitMessage.trim() || 'Sync metadata',
    };
  }

  if (actionKey === 'import_metadata') {
    const confirmed = confirmImportRun(row.project_name || projectId, 'Run Import');
    if (!confirmed) {
      return null;
    }
    return {
      project_id: projectId,
      confirm_apply: true,
      confirm_large_delete: false,
      allow_force_import: false,
    };
  }

  if (actionKey === 'pull_import') {
    const confirmed = confirmImportRun(row.project_name || projectId, 'Run Pull & Import');
    if (!confirmed) {
      return null;
    }
    return {
      project_id: projectId,
      confirm_apply: true,
      confirm_large_delete: false,
      allow_force_import: false,
    };
  }

  if (actionKey === 'init_repo') {
    return {
      project_id: projectId,
      acknowledge_warnings: true,
    };
  }

  return { project_id: projectId };
}

function actionLabel(actionKey) {
  const labels = {
    status: 'refresh status',
    open_folder: 'open folder',
    export_metadata: 'export metadata',
    import_metadata: 'import metadata',
    init_repo: 'init repo',
    set_remote: 'set remote',
    commit_push: 'commit + push',
    pull_import: 'pull + import',
  };
  return labels[actionKey] || actionKey.replace(/_/g, ' ');
}

function isForcePhraseCode(code) {
  return (
    code === 'pull-import-force-confirmation-required' ||
    code === 'import-force-confirmation-required'
  );
}

async function runActionWithRetries(actionKey, payload, row) {
  const endpoint = ACTION_ENDPOINTS[actionKey];
  let activePayload = { ...payload };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await requestJson(endpoint, {
        method: 'POST',
        body: JSON.stringify(activePayload),
      });
    } catch (error) {
      const code = String(error?.payload?.code || '').trim();

      if (code === 'import-large-delete-confirmation-required') {
        const deleteCount = parseDeleteCount(error?.payload?.details);
        const summary = Number.isFinite(deleteCount)
          ? `Large delete confirmation required (${deleteCount} items).`
          : 'Large delete confirmation required.';
        logActivityEvent({
          row,
          actionKey,
          status: 'Started',
          summary,
          code,
          details: error?.payload?.details,
          autoOpen: true,
        });
        const baseMessage = Number.isFinite(deleteCount)
          ? `This import will delete ${deleteCount} item(s). Continue?`
          : 'This import may delete many items. Continue?';
        const confirmed = window.confirm(
          `${baseMessage}\n\nProject: "${row.project_name || row.project_id}"`
        );
        if (!confirmed) {
          return null;
        }
        activePayload = {
          ...activePayload,
          confirm_apply: true,
          confirm_large_delete: true,
        };
        continue;
      }

      if (isForcePhraseCode(code)) {
        const requiredPhrase = parseRequiredPhrase(error?.payload?.details);
        logActivityEvent({
          row,
          actionKey,
          status: 'Started',
          summary: 'Typed confirmation phrase is required before retry.',
          code,
          details: error?.payload?.details,
          autoOpen: true,
        });
        const promptMessage = requiredPhrase
          ? `Force import confirmation is required.\nType exactly: ${requiredPhrase}`
          : 'Force import confirmation is required.\nType the exact confirmation phrase and retry:';
        const typedPhrase = window.prompt(promptMessage, '');
        if (!typedPhrase || !typedPhrase.trim()) {
          return null;
        }
        activePayload = {
          ...activePayload,
          confirm_apply: true,
          allow_force_import: true,
          force_import_typed_phrase: typedPhrase.trim(),
        };
        continue;
      }

      throw error;
    }
  }
  throw new Error('Action could not complete after confirmation retries.');
}

function shouldAutoRefresh() {
  return autoRefreshEnabled && document.visibilityState === 'visible';
}

function nextPollingDelayMs() {
  if (pollFailureStreak < AUTO_REFRESH_BACKOFF_FAILURE_START) {
    return autoRefreshIntervalMs;
  }
  const multiplier = Math.min(
    AUTO_REFRESH_BACKOFF_MAX_MULTIPLIER,
    2 ** (pollFailureStreak - AUTO_REFRESH_BACKOFF_FAILURE_START + 1)
  );
  return Math.min(AUTO_REFRESH_MAX_INTERVAL_MS, autoRefreshIntervalMs * multiplier);
}

function schedulePolling(delayMs = nextPollingDelayMs()) {
  if (pollTimerId !== null || !shouldAutoRefresh()) {
    return;
  }
  const normalizedDelay = Math.max(0, Number(delayMs) || autoRefreshIntervalMs);
  pollTimerId = window.setTimeout(() => {
    pollTimerId = null;
    void runPollingCycle();
  }, normalizedDelay);
}

async function runPollingCycle() {
  if (!shouldAutoRefresh()) {
    return;
  }
  try {
    await loadStatuses({ showLoading: false, silentError: true });
  } catch (_error) {
    pollFailureStreak += 1;
    updateRefreshIndicators();
  } finally {
    schedulePolling(nextPollingDelayMs());
  }
}

function stopPolling() {
  if (pollTimerId === null) {
    return;
  }
  window.clearTimeout(pollTimerId);
  pollTimerId = null;
}

function handleVisibilityChange() {
  if (document.visibilityState !== 'visible') {
    stopPolling();
    stopStaleIndicatorTimer();
    return;
  }
  updateRefreshIndicators();
  if (shouldAutoRefresh()) {
    schedulePolling(0);
    void loadStatuses({ showLoading: false, silentError: true });
  }
}

function onGlobalSyncManagerSettingsChanged(event) {
  const detail =
    event?.detail && typeof event.detail === 'object' ? event.detail : getSyncManagerPreferences();
  applySyncManagerPreferences(detail, { applyPanelDefault: true });
  pollFailureStreak = 0;
  updateRefreshIndicators();
  renderRows(Array.from(rowsByProjectId.values()));
  refreshOpenSettingsDialog();
  stopPolling();
  if (shouldAutoRefresh()) {
    schedulePolling(0);
    void loadStatuses({ showLoading: false, silentError: true });
  }
}

function onSettingsRemoteFieldInput() {
  const projectId = String(activeSettingsProjectId || '').trim();
  if (!projectId) {
    return;
  }
  const row = rowsByProjectId.get(projectId);
  if (!row) {
    return;
  }
  const state = getRemoteEditorState(row);
  if (!state) {
    return;
  }
  const nodes = getSettingsNodes();
  state.draftName = normalizeRemoteField(nodes.remoteName?.value) || 'origin';
  state.draftUrl = normalizeRemoteField(nodes.remoteUrl?.value);
  remoteEditorStateByProjectId.set(projectId, state);
  updateRemoteEditorControls(row);
}

async function onSettingsSetRemoteClick() {
  const projectId = String(activeSettingsProjectId || '').trim();
  if (!projectId) {
    return;
  }
  const row = rowsByProjectId.get(projectId);
  if (!row) {
    return;
  }
  await triggerAction(row, 'set_remote');
}

function onGlobalPointerDown(event) {
  if (!isContextMenuVisible()) {
    return;
  }
  const nodes = getContextMenuNodes();
  if (nodes.menu && event.target instanceof Node && nodes.menu.contains(event.target)) {
    return;
  }
  closeContextMenu({ restoreFocus: false });
}

function onGlobalKeydown(event) {
  if (String(event.key || '') !== 'Escape' || !isContextMenuVisible()) {
    return;
  }
  event.preventDefault();
  closeContextMenu({ restoreFocus: true });
}

async function triggerAction(row, actionKey) {
  if (actionKey === 'status') {
    logActivityEvent({
      row,
      actionKey,
      status: 'Started',
      summary: 'Refreshing project status.',
    });
    try {
      await loadStatuses({ showLoading: true });
      setFeedback(`Status refreshed for "${row.project_name || row.project_id}".`);
      logActivityEvent({
        row,
        actionKey,
        status: 'Succeeded',
        summary: 'Status refresh completed.',
      });
    } catch (error) {
      const activityError = extractActivityError(error, 'Unable to refresh status.');
      renderActionErrorToast(error, 'Unable to refresh status.');
      logActivityEvent({
        row,
        actionKey,
        status: 'Failed',
        summary: activityError.message,
        code: activityError.code,
        details: activityError.details,
        guidanceSummary: activityError.guidanceSummary,
        nextSteps: activityError.nextSteps,
        autoOpen: true,
      });
    }
    return;
  }

  if (actionKey === 'open_folder') {
    const rootPath = String(row?.root_path || '').trim();
    if (!rootPath) {
      showToast('Open folder is unavailable because this project has no root path.', true);
      logActivityEvent({
        row,
        actionKey,
        status: 'Failed',
        summary: 'Open folder is unavailable because this project has no root path.',
        autoOpen: true,
      });
      return;
    }
    logActivityEvent({
      row,
      actionKey,
      status: 'Started',
      summary: 'Opening project folder.',
    });
    try {
      await revealInFileExplorer(rootPath, false);
      setFeedback(`Opened folder for "${row.project_name || row.project_id}".`);
      logActivityEvent({
        row,
        actionKey,
        status: 'Succeeded',
        summary: 'Project folder opened.',
      });
    } catch (error) {
      const activityError = extractActivityError(error, 'Unable to open project folder.');
      renderActionErrorToast(error, 'Unable to open project folder.');
      logActivityEvent({
        row,
        actionKey,
        status: 'Failed',
        summary: activityError.message,
        code: activityError.code,
        details: activityError.details,
        guidanceSummary: activityError.guidanceSummary,
        nextSteps: activityError.nextSteps,
        autoOpen: true,
      });
    }
    return;
  }

  const endpoint = ACTION_ENDPOINTS[actionKey];
  if (!endpoint) {
    return;
  }

  clearError();
  logActivityEvent({
    row,
    actionKey,
    status: 'Started',
    summary: `Running ${actionLabel(actionKey)}.`,
  });
  let payload = null;
  try {
    payload = buildActionPayload(row, actionKey);
  } catch (error) {
    const activityError = extractActivityError(error, 'Unable to start action.');
    renderActionErrorToast(error, 'Unable to start action.');
    logActivityEvent({
      row,
      actionKey,
      status: 'Failed',
      summary: activityError.message,
      code: activityError.code,
      details: activityError.details,
      guidanceSummary: activityError.guidanceSummary,
      nextSteps: activityError.nextSteps,
      autoOpen: true,
    });
    return;
  }
  if (!payload) {
    logActivityEvent({
      row,
      actionKey,
      status: 'Cancelled',
      summary: `Cancelled ${actionLabel(actionKey)} before request.`,
    });
    return;
  }

  const isSetRemoteAction = actionKey === 'set_remote';
  if (isSetRemoteAction) {
    remoteSetRequestInFlight = true;
    updateRemoteEditorControls(row);
  }

  setLoading(true, `Running ${actionLabel(actionKey)}...`);
  try {
    const result = await runActionWithRetries(actionKey, payload, row);
    if (result === null) {
      setFeedback(
        `Cancelled ${actionLabel(actionKey)} for "${row.project_name || row.project_id}".`
      );
      logActivityEvent({
        row,
        actionKey,
        status: 'Cancelled',
        summary: `Cancelled ${actionLabel(actionKey)} during confirmation.`,
      });
      return;
    }
    if (isSetRemoteAction) {
      applyRemoteActionResult(row, result);
      updateRemoteEditorControls(row);
    }
    setFeedback(`Completed ${actionLabel(actionKey)} for "${row.project_name || row.project_id}".`);
    logActivityEvent({
      row,
      actionKey,
      status: 'Succeeded',
      summary: `Completed ${actionLabel(actionKey)}.`,
    });
    await loadStatuses({ showLoading: false });
  } catch (error) {
    renderActionErrorToast(error, 'Action failed.');
    const activityError = extractActivityError(error, 'Action failed.');
    logActivityEvent({
      row,
      actionKey,
      status: 'Failed',
      summary: activityError.message,
      code: activityError.code,
      details: activityError.details,
      guidanceSummary: activityError.guidanceSummary,
      nextSteps: activityError.nextSteps,
      autoOpen: true,
    });
  } finally {
    if (isSetRemoteAction) {
      remoteSetRequestInFlight = false;
      updateRemoteEditorControls(row);
    }
    setLoading(false);
  }
}

export function initSyncManagerPage() {
  const root = document.getElementById('sync-manager-page-root');
  if (!root) {
    return;
  }

  const syncPreferences = migrateLegacySyncManagerPreferences();
  applySyncManagerPreferences(syncPreferences);

  const refreshButton = document.getElementById('sync-manager-refresh');
  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      void loadStatuses({ showLoading: true });
    });
  }
  const staleIndicatorButton = document.getElementById('sync-manager-stale-indicator');
  if (staleIndicatorButton) {
    staleIndicatorButton.addEventListener('click', () => {
      void loadStatuses({ showLoading: true });
    });
  }
  const activityToggleButton = document.getElementById('sync-manager-activity-toggle');
  if (activityToggleButton) {
    activityToggleButton.addEventListener('click', () => {
      setActivityPanelVisible(!activityPanelVisible);
    });
  }
  const activityClearButton = document.getElementById('sync-manager-activity-clear');
  if (activityClearButton) {
    activityClearButton.addEventListener('click', onActivityClear);
  }
  const activityCopyButton = document.getElementById('sync-manager-activity-copy');
  if (activityCopyButton) {
    activityCopyButton.addEventListener('click', () => {
      void onActivityCopy();
    });
  }
  const activityFilterInput = document.getElementById('sync-manager-activity-filter');
  if (activityFilterInput) {
    activityFilterInput.addEventListener('input', onActivityFilterInput);
    activityFilterInput.addEventListener('change', onActivityFilterInput);
  }
  const activityResizer = document.getElementById('sync-manager-activity-resizer');
  if (activityResizer) {
    activityResizer.addEventListener('mousedown', onActivityResizeStart);
  }
  const contextMenuNodes = getContextMenuNodes();
  if (contextMenuNodes.menu) {
    contextMenuNodes.menu.addEventListener('click', onContextMenuActionClick);
  }
  const settingsNodes = getSettingsNodes();
  if (settingsNodes.closeButton) {
    settingsNodes.closeButton.addEventListener('click', () => {
      closeSettingsDialog();
    });
  }
  if (settingsNodes.tabList) {
    settingsNodes.tabList.addEventListener('click', onSettingsTabClick);
    settingsNodes.tabList.addEventListener('keydown', onSettingsTabKeydown);
  }
  if (settingsNodes.dialog) {
    settingsNodes.dialog.addEventListener('close', () => {
      const focusTarget = settingsReturnFocusNode;
      const projectFocusId = activeSettingsProjectId;
      settingsReturnFocusNode = null;
      activeSettingsProjectId = '';
      if (focusTarget instanceof HTMLElement && document.contains(focusTarget)) {
        focusTarget.focus();
        return;
      }
      const projectFallback = findSettingsTriggerForProject(projectFocusId);
      if (projectFallback instanceof HTMLElement && document.contains(projectFallback)) {
        projectFallback.focus();
        return;
      }
      if (refreshButton instanceof HTMLElement) {
        refreshButton.focus();
      }
    });
  }
  if (settingsNodes.remoteName) {
    settingsNodes.remoteName.addEventListener('input', onSettingsRemoteFieldInput);
    settingsNodes.remoteName.addEventListener('change', onSettingsRemoteFieldInput);
  }
  if (settingsNodes.remoteUrl) {
    settingsNodes.remoteUrl.addEventListener('input', onSettingsRemoteFieldInput);
    settingsNodes.remoteUrl.addEventListener('change', onSettingsRemoteFieldInput);
  }
  if (settingsNodes.setRemoteButton) {
    settingsNodes.setRemoteButton.addEventListener('click', () => {
      void onSettingsSetRemoteClick();
    });
  }
  if (settingsNodes.copyDiagnosticsButton) {
    settingsNodes.copyDiagnosticsButton.addEventListener('click', () => {
      void onCopyDiagnosticsTemplate();
    });
  }

  window.addEventListener('focus', () => {
    if (!shouldAutoRefresh()) return;
    void loadStatuses({ showLoading: false, silentError: true });
  });
  document.addEventListener('visibilitychange', handleVisibilityChange);
  document.addEventListener('pointerdown', onGlobalPointerDown);
  document.addEventListener('keydown', onGlobalKeydown);
  document.addEventListener('qualifile:sync-manager-settings', onGlobalSyncManagerSettingsChanged);
  window.addEventListener('resize', () => {
    closeContextMenu({ restoreFocus: false });
  });
  window.addEventListener(
    'scroll',
    () => {
      closeContextMenu({ restoreFocus: false });
    },
    true
  );

  restoreActivityState();
  activityPanelWidth = restoreActivityPanelWidth({
    legacySessionStorageKey: ACTIVITY_STORAGE_KEY,
  });
  setActivityPanelWidth(activityPanelWidth, { persist: false });
  if (!activityStateRestoredFromSession) {
    setActivityPanelVisible(Boolean(syncPreferences.activityPanelVisibleByDefault), {
      persist: false,
    });
  }
  setActivityPanelVisible(activityPanelVisible, { persist: false });
  renderActivityEntries();
  setLastRefreshed(null);
  renderRows(Array.from(rowsByProjectId.values()));
  schedulePolling();
  void loadStatuses({ showLoading: true });
}
