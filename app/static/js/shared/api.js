import { state } from './state.js';
import { showToast, setStatus } from './ui.js';
import { debugDiagnostic, errorDiagnostic } from './diagnostics.js';

let cachedCsrfToken = null;

function getCsrfToken() {
  if (cachedCsrfToken !== null) return cachedCsrfToken;
  const meta = document.querySelector('meta[name="qualifile-csrf"]');
  cachedCsrfToken = meta?.content || '';
  return cachedCsrfToken;
}

function isLocalUrl(url) {
  if (typeof window === 'undefined') return true;
  try {
    const resolved = new URL(url, window.location.href);
    const host = resolved.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch (error) {
    return true;
  }
}

function extractErrorMessage(payload, fallback = 'Operation failed') {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload;
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error?.message) return payload.error.message;
  if (payload.error_message) return payload.error_message;
  if (payload.message) return payload.message;
  return fallback;
}

function buildAbortError(error) {
  const aborted = new Error('Request was cancelled.');
  aborted.name = 'AbortError';
  aborted.silent = true;
  aborted.cause = error;
  return aborted;
}

function formatErrorMessage(error, fallback = 'Unexpected error') {
  if (!error) return fallback;
  if (typeof error === 'string') return error;
  if (error.message) return error.message;
  if (error.error?.message) return error.error.message;
  if (error.error_message) return error.error_message;
  if (error.error) return typeof error.error === 'string' ? error.error : fallback;
  return fallback;
}

async function parseJsonSafely(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

/** Perform a JSON fetch request and surface API errors as exceptions. */
export async function requestJson(url, options = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false && !isLocalUrl(url)) {
    throw new Error('You appear to be offline.');
  }
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const token = getCsrfToken();
    if (token) headers.set('X-CSRF-Token', token);
    if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }
  }
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  let response;
  try {
    response = await fetch(url, { ...options, method, headers });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw buildAbortError(error);
    }
    const message = isLocalUrl(url)
      ? 'Unable to reach the local server. Is QualiFile running?'
      : 'Network error. Please check your connection.';
    const wrapped = new Error(message);
    wrapped.cause = error;
    throw wrapped;
  }
  const payload = await parseJsonSafely(response);
  if (!response.ok) {
    const message = extractErrorMessage(payload, 'Operation failed');
    const err = new Error(message);
    err.status = response.status;
    err.requestId =
      response.headers.get('X-Request-ID') ||
      payload?.request_id ||
      payload?.error?.request_id ||
      null;
    err.url = url;
    err.payload = payload;
    throw err;
  }
  return payload;
}

/** Retrieve the folder tree starting at the provided path. */
export async function fetchTree(path, options = {}) {
  return requestJson(`/api/tree?path=${encodeURIComponent(path)}`, options);
}

/** List folders for the folder picker modal. */
export async function browseRoot(path, scope = 'root') {
  const params = new URLSearchParams({ path, scope });
  return requestJson(`/api/root_picker?${params.toString()}`);
}

/** Fetch the directory listing for the main file table/grid. */
export async function fetchList(path, includeSubfolders, options = {}) {
  return requestJson(
    `/api/list?path=${encodeURIComponent(path)}&include_subfolders=${includeSubfolders}`,
    options
  );
}

/** Create a new folder under the current path. */
export async function createFolder(name) {
  return requestJson('/api/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'folder', path: state.currentPath, name }),
  });
}

/** Create a new empty file under the current path. */
export async function createFile(name) {
  return requestJson('/api/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'file', path: state.currentPath, name }),
  });
}

/** Rename a filesystem entry. */
export async function renameItem(path, newName) {
  return requestJson('/api/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, new_name: newName }),
  });
}

/** Persist a screenshot blob captured via the browser APIs. */
export async function captureScreenshot(blob, options = {}) {
  const form = new FormData();
  form.append('image', blob, 'capture.png');
  const targetPath = options.path || state.currentPath;
  if (targetPath) {
    form.append('path', targetPath);
  }
  const requestedName = typeof options.name === 'string' ? options.name.trim() : '';
  if (requestedName) {
    form.append('name', requestedName);
  }
  const response = await fetch('/api/screenshot', {
    method: 'POST',
    body: form,
    headers: { 'X-CSRF-Token': getCsrfToken(), Accept: 'application/json' },
  });
  const data = await parseJsonSafely(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(data, 'Capture failed'));
  }
  return data;
}

/** Trigger a PDF/image merge operation on the server. */
export async function mergeItems(options) {
  const payload = {
    items: options.items,
    path: options.path || state.currentPath,
    mode: options.mode,
    output_name: options.outputName,
    order: options.order,
    paper_size: options.paperSize,
    orientation: options.orientation,
    margin: options.margin,
    fit: options.fit,
    phrases: options.phrases,
    phrase_alignment: options.phraseAlignment,
    phrase_font_size_pt: options.phraseFontSizePt,
    page_numbers: options.pageNumbers,
  };
  return requestJson('/api/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Extract selected pages from a PDF. */
export async function extractPdfPages(options) {
  return requestJson('/api/pdf/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
}

/** Request preview metadata/content for a given file. */
export async function fetchPreview(path, options = {}) {
  const { cancelToken, offset, length, headers = {}, ...rest } = options;
  const body = { path };
  if (cancelToken) body.cancel_token = cancelToken;
  if (Number.isInteger(offset)) body.offset = offset;
  if (Number.isInteger(length)) body.length = length;
  return requestJson('/api/preview', {
    ...rest,
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Request cancellation of an in-progress preview conversion. */
export async function cancelPreview(token) {
  if (!token) return;
  return requestJson('/api/preview/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

/** Construct a download URL for the provided path. */
export function fetchFileUrl(path) {
  return `/api/file?path=${encodeURIComponent(path)}`;
}

/** Fetch task-alert header/dropdown summary data. */
export async function fetchTaskAlertsSummary(options = {}) {
  const params = new URLSearchParams();
  const limit = Number(options?.limit);
  if (Number.isFinite(limit) && limit > 0) {
    params.set('limit', String(Math.floor(limit)));
  }
  const query = params.toString();
  const url = query ? `/api/alerts/summary?${query}` : '/api/alerts/summary';
  return requestJson(url);
}

/** Acknowledge currently active task alerts (mark as seen). */
export async function acknowledgeTaskAlerts(options = {}) {
  const params = new URLSearchParams();
  const limit = Number(options?.limit);
  if (Number.isFinite(limit) && limit > 0) {
    params.set('limit', String(Math.floor(limit)));
  }
  const query = params.toString();
  const url = query ? `/api/alerts/acknowledge?${query}` : '/api/alerts/acknowledge';
  return requestJson(url, { method: 'POST' });
}

/** Dismiss or undismiss an active task alert. */
export async function dismissTaskAlert(taskId, options = {}) {
  const task = String(taskId || '').trim();
  if (!task) {
    throw new Error('Task id is required.');
  }
  const params = new URLSearchParams();
  const limit = Number(options?.limit);
  if (Number.isFinite(limit) && limit > 0) {
    params.set('limit', String(Math.floor(limit)));
  }
  const query = params.toString();
  const url = query
    ? `/api/alerts/${encodeURIComponent(task)}/dismiss?${query}`
    : `/api/alerts/${encodeURIComponent(task)}/dismiss`;
  return requestJson(url, {
    method: 'POST',
    body: JSON.stringify({ dismissed: Boolean(options?.dismissed) }),
  });
}

/** Snooze or clear snooze for an active task alert. */
export async function snoozeTaskAlert(taskId, options = {}) {
  const task = String(taskId || '').trim();
  if (!task) {
    throw new Error('Task id is required.');
  }
  const preset = String(options?.preset || '').trim();
  if (!preset) {
    throw new Error('Snooze preset is required.');
  }
  const params = new URLSearchParams();
  const limit = Number(options?.limit);
  if (Number.isFinite(limit) && limit > 0) {
    params.set('limit', String(Math.floor(limit)));
  }
  const query = params.toString();
  const url = query
    ? `/api/alerts/${encodeURIComponent(task)}/snooze?${query}`
    : `/api/alerts/${encodeURIComponent(task)}/snooze`;
  return requestJson(url, {
    method: 'POST',
    body: JSON.stringify({ preset }),
  });
}

/** Request the server to open a file using the system default application. */
export async function openInDefaultApp(path) {
  if (!path) {
    throw new Error('No file selected to open.');
  }
  const result = await requestJson('/api/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  showToast('Opened in default app');
  return result;
}

/** Launch the default mail client with the provided files attached. */
export async function sendFileViaEmail(paths) {
  const items = Array.isArray(paths) ? paths.filter(Boolean) : paths ? [paths] : [];
  if (!items.length) {
    throw new Error('No file selected to email.');
  }
  return requestJson('/api/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: items }),
  });
}

/** Persist an annotated image to disk. */
export async function saveAnnotation(options) {
  const payload = {
    path: options.path,
    mode: options.mode || 'overwrite',
    data_url: options.dataUrl,
    document: options.document,
    overlay: options.overlay,
    expected_hash: options.expectedHash,
    filename: options.filename || '',
  };
  return requestJson('/api/annotate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Reveal a file or folder in the host file explorer. */
export async function revealInFileExplorer(path, select = false) {
  return requestJson('/api/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, select }),
  });
}

/** Move items to a destination, applying conflict behaviour. */
export async function moveItems(items, destination, conflict = 'rename') {
  return requestJson('/api/move_copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, destination, operation: 'move', on_conflict: conflict }),
  });
}

/** Copy items to a destination, applying conflict behaviour. */
export async function copyItems(items, destination, conflict = 'rename') {
  return requestJson('/api/move_copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, destination, operation: 'copy', on_conflict: conflict }),
  });
}

/** Create a ZIP archive from selected files/folders. */
export async function createZipArchive(options = {}) {
  const payload = {
    items: Array.isArray(options.items) ? options.items : [],
    destination: options.destination || state.currentPath || '.',
  };
  if (options.name) {
    payload.name = options.name;
  }
  return requestJson('/api/zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Delete items permanently or via the trash folder. */
export async function deleteItems(items, permanent = false) {
  return requestJson('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, permanent }),
  });
}

/** Import a folder/file structure from a template file. */
export async function importStructure(formData) {
  const response = await fetch('/api/import', {
    method: 'POST',
    body: formData,
    headers: { 'X-CSRF-Token': getCsrfToken(), Accept: 'application/json' },
  });
  const payload = await parseJsonSafely(response);
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, 'Import failed'));
  }
  return payload;
}

/** Persist a new root path for the application. */
export async function updateRoot(path) {
  return requestJson('/api/root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}

/** Clear the configured root path. */
export async function clearRoot() {
  return requestJson('/api/root', { method: 'DELETE' });
}

/** Ask the backend to shut down (portable mode). */
export async function shutdownServer() {
  return requestJson('/api/shutdown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Launch Greenshot using user-configured settings. */
export async function launchGreenshot(options = {}) {
  return requestJson('/api/greenshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
}

/** Persist the Greenshot integration enabled/disabled state. */
export async function setGreenshotIntegrationEnabled(enabled) {
  return requestJson('/api/settings/greenshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !!enabled }),
  });
}

/** Persist Office preview quality profile used for conversions. */
export async function setOfficePreviewQuality(quality) {
  return requestJson('/api/settings/office_preview_quality', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quality }),
  });
}

/** Retrieve all tag definitions and cached assignments. */
export async function fetchTagsState() {
  return requestJson('/api/tags');
}

/** Create a new tag definition. */
export async function createTagDefinition(name, color, parentId = null) {
  return requestJson('/api/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color, parent_id: parentId ?? null }),
  });
}

/** Rename or recolour an existing tag. */
export async function updateTagDefinition(tagId, updates = {}) {
  return requestJson(`/api/tags/${encodeURIComponent(tagId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}

/** Delete a tag definition and remove its assignments. */
export async function deleteTagDefinition(tagId) {
  return requestJson(`/api/tags/${encodeURIComponent(tagId)}`, {
    method: 'DELETE',
  });
}

/** Assign a set of tags to the provided relative path. */
export async function assignTagsToPath(path, tags = []) {
  return requestJson('/api/tags/assign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, tags }),
  });
}

/** Toggle or set the validation state for a file. */
export async function setValidationState(path, validated) {
  return requestJson('/api/validation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, validated }),
  });
}

/** Display an error toast and log to the console. */
export function handleError(error) {
  if (error?.name === 'AbortError' || error?.silent) {
    debugDiagnostic('RequestAborted', error);
    return;
  }
  errorDiagnostic('RequestFailure', error);
  showToast(formatErrorMessage(error), true);
  setStatus('Error');
}

/** Retrieve notes for a file or folder. */
export async function fetchNotes(path) {
  return requestJson(`/api/notes?path=${encodeURIComponent(path)}`);
}

/** Create a new note on the provided path. */
export async function createNote(path, payload = {}) {
  return requestJson('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, path }),
  });
}

/** Update an existing note. */
export async function updateNote(path, noteId, payload = {}) {
  return requestJson(`/api/notes/${encodeURIComponent(noteId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, path }),
  });
}

/** Delete a note. */
export async function deleteNote(path, noteId) {
  return requestJson(`/api/notes/${encodeURIComponent(noteId)}?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  });
}
