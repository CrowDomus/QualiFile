import { normalizePath } from '../../shared/paths.js';

const INTENT_STORAGE_KEY = 'qualifile.reveal_intent.v1';
const REVEAL_PARAM = 'reveal_path';
const SELECT_PARAM = 'select_path';
const PREVIEW_PARAM = 'preview';
const HIGHLIGHT_PARAM = 'highlight';
const MAX_ATTEMPTS = 15;
const RETRY_DELAY_MS = 120;
const MAX_TIMEOUT_MS = 1800;

function parsePreviewFlag(value) {
  if (typeof value === 'boolean') return value;
  if (value == null) return false;
  const text = String(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
}

function normalizeIntentPath(raw) {
  if (raw == null) return '';
  const text = String(raw).trim();
  if (!text) return '';
  const normalized = normalizePath(text);
  return normalized || '.';
}

function parentPath(path) {
  if (!path || path === '.') return '.';
  const parts = path.split('/');
  parts.pop();
  if (!parts.length) return '.';
  return parts.join('/');
}

function readIntentFromUrl() {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search || '');
  const hasIntent =
    params.has(REVEAL_PARAM) || params.has(SELECT_PARAM) || params.has(PREVIEW_PARAM);
  if (!hasIntent) return null;
  return {
    reveal_path: params.get(REVEAL_PARAM),
    select_path: params.get(SELECT_PARAM),
    preview: params.get(PREVIEW_PARAM),
    highlight: params.get(HIGHLIGHT_PARAM),
  };
}

function readIntentFromStorage() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage?.getItem(INTENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      reveal_path: parsed.reveal_path,
      select_path: parsed.select_path,
      preview: parsed.preview,
      highlight: parsed.highlight,
    };
  } catch (error) {
    return null;
  }
}

function clearIntentFromUrl() {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const params = url.searchParams;
  const keys = [REVEAL_PARAM, SELECT_PARAM, PREVIEW_PARAM, HIGHLIGHT_PARAM];
  let changed = false;
  keys.forEach((key) => {
    if (params.has(key)) {
      params.delete(key);
      changed = true;
    }
  });
  if (changed) {
    const nextUrl = url.pathname + (params.toString() ? `?${params.toString()}` : '') + url.hash;
    window.history.replaceState({}, '', nextUrl);
  }
}

function clearIntentFromStorage() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.removeItem(INTENT_STORAGE_KEY);
  } catch (error) {
    return;
  }
}

function resolveIntent() {
  const fromUrl = readIntentFromUrl();
  const raw = fromUrl || readIntentFromStorage();
  if (!raw) return null;
  const revealRaw = normalizeIntentPath(raw.reveal_path);
  const selectRaw = normalizeIntentPath(raw.select_path);
  let revealPath = revealRaw;
  let selectPath = selectRaw || '';
  if (!revealPath && selectPath) {
    revealPath = parentPath(selectPath);
  }
  if (!revealPath && !selectPath) return null;
  if (!revealPath) {
    revealPath = '.';
  }
  return {
    revealPath,
    selectPath: selectPath || '',
    preview: parsePreviewFlag(raw.preview),
    highlight: parsePreviewFlag(raw.highlight),
  };
}

export function consumeRevealIntent({
  navigateToPath,
  selectItem,
  highlightItem,
  openPreviewIfRequested,
  highlightSelection,
} = {}) {
  const intent = resolveIntent();
  if (!intent) return null;
  clearIntentFromUrl();
  clearIntentFromStorage();

  const { revealPath, selectPath, preview, highlight } = intent;
  const start = Date.now();
  let attempts = 0;
  let navigated = false;

  const attemptSelection = () => {
    attempts += 1;
    if (!navigated && typeof navigateToPath === 'function') {
      navigateToPath(revealPath);
      if (typeof highlightItem === 'function') {
        highlightItem(revealPath);
      }
      navigated = true;
    }

    let item = null;
    if (selectPath && typeof selectItem === 'function') {
      item = selectItem(selectPath);
    }
    if (item) {
      if (highlight && typeof highlightSelection === 'function') {
        try {
          highlightSelection(item);
        } catch (error) {
          // Best-effort highlight should never block navigation.
        }
      }
      if (preview && typeof openPreviewIfRequested === 'function') {
        openPreviewIfRequested(item);
      }
      return;
    }

    const elapsed = Date.now() - start;
    if (attempts >= MAX_ATTEMPTS || elapsed >= MAX_TIMEOUT_MS) {
      return;
    }
    window.setTimeout(attemptSelection, RETRY_DELAY_MS);
  };

  attemptSelection();
  return intent;
}
