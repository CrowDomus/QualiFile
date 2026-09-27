import {
  cancelPreview,
  fetchPreview,
  fetchFileUrl,
  fetchNotes,
  handleError,
  openInDefaultApp,
} from '../../shared/api.js';
import { setStatus } from '../../shared/ui.js';
import { state, persistPreferences, selectionArray } from '../../shared/state.js';
import { openWithGreenshot } from './greenshot.js';
import { createLoadingOperation, isAbortError } from '../modals/loading_modal.js';
import { warnDiagnostic } from '../../shared/diagnostics.js';
import { normalizePath } from '../../shared/paths.js';
import { attachPdfFrame } from './pdf_frame.js';

const container = document.getElementById('preview-content');
const clearButton = document.getElementById('preview-close');
const controlsContainer = document.getElementById('preview-controls');
const metadataToggle = document.getElementById('preview-metadata-toggle');
const openButton = document.getElementById('preview-open');
const pdfExtractButton = document.createElement('button');
const notesButton = document.getElementById('preview-notes');
const openSplitButton = document.getElementById('preview-open-dropdown-toggle');
const openDropdownMenu = document.getElementById('preview-open-dropdown');
const openGreenshotButton = document.getElementById('preview-open-greenshot');
const previewNameLabel = document.getElementById('preview-file-label');
const previewLabelTags = document.createElement('span');
const previewLabelDivider = document.createElement('span');
const previewLabelNotes = document.createElement('span');
const fullscreenButton = document.getElementById('preview-fullscreen');
const fullscreenModal = document.getElementById('modal-preview-fullscreen');
const fullscreenBody = document.getElementById('preview-fullscreen-body');
const previewPane = document.getElementById('preview-pane');
let previewPanePlaceholder = null;
let previewPaneOriginalStyle = '';

const MAX_ZOOM_FACTOR = 4;
const MIN_ZOOM_FACTOR = 0.2;
const CONTENT_MIN_ZOOM = 0.5;
const CONTENT_MAX_ZOOM = 3;
const CONTENT_ZOOM_STEP = 0.1;

let previewState = null;
let imageResizeObserver = null;
let resizeTimer = null;
let annotatorModulePromise = null;
let previewLoadingOperation = null;
let disposePdfFrame = null;

if (clearButton) {
  clearButton.addEventListener('click', () => clearPreview());
}

if (previewNameLabel) {
  previewLabelTags.className = 'preview-label-tags file-tags tag-dots';
  previewLabelDivider.className = 'preview-label-divider text-muted';
  previewLabelDivider.textContent = '•';
  previewLabelDivider.style.display = 'none';
  previewLabelNotes.className = 'preview-label-notes';
  previewNameLabel.after(previewLabelTags);
  previewLabelTags.after(previewLabelDivider);
  previewLabelDivider.after(previewLabelNotes);
}
if (metadataToggle) {
  metadataToggle.addEventListener('click', () => toggleMetadata());
  metadataToggle.textContent = state.settings.preview.showMetadata
    ? 'Hide details'
    : 'Show details';
  metadataToggle.setAttribute(
    'aria-pressed',
    state.settings.preview.showMetadata ? 'true' : 'false'
  );
}
if (openButton) {
  openButton.addEventListener('click', () => {
    void openCurrentPreview();
  });
}
if (pdfExtractButton) {
  pdfExtractButton.type = 'button';
  pdfExtractButton.id = 'preview-pdf-extract';
  pdfExtractButton.className = 'btn btn-sm btn-outline-secondary d-none';
  pdfExtractButton.textContent = 'Extract';
  pdfExtractButton.title = 'Extract pages to a new PDF';
  pdfExtractButton.addEventListener('click', () => {
    void openCurrentPdfExtract();
  });
  const openGroup = document.getElementById('preview-open-group');
  openGroup?.insertAdjacentElement('afterend', pdfExtractButton);
}
if (notesButton) {
  notesButton.addEventListener('click', () => {
    void openCurrentNotes();
  });
}
if (openGreenshotButton) {
  openGreenshotButton.addEventListener('click', () => {
    void openCurrentPreviewInGreenshot();
  });
}
if (fullscreenButton) {
  fullscreenButton.addEventListener('click', () => openFullscreenPreview());
}
if (fullscreenModal) {
  fullscreenModal.addEventListener('hidden.bs.modal', () => restorePreviewPane());
}

document.addEventListener('qualifile:preview-refresh', (event) => {
  const targetPath = event.detail?.path;
  if (!previewState?.item) return;
  if (targetPath && previewState.item.path !== targetPath) return;
  if (previewState.type === 'image') {
    void showPreview(previewState.item);
    return;
  }
  void refreshPreviewMeta(previewState.item);
});

document.addEventListener('qualifile:validation-updated', (event) => {
  if (!previewState?.item?.path) return;
  const paths = Array.isArray(event.detail?.paths) ? event.detail.paths : [];
  const target = canonicalItemPath(previewState.item.path);
  const matches = paths.some((path) => canonicalItemPath(path) === target);
  if (!matches) return;
  applyValidationToPreview(Boolean(event.detail?.validated));
});

window.addEventListener('resize', () => {
  if (!previewState?.imageElement) return;
  if (resizeTimer) {
    window.clearTimeout(resizeTimer);
  }
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null;
    if (previewState?.imageElement) {
      updateScaleBounds(previewState.imageElement, false);
      applyImageTransform(previewState.imageElement);
      updateImageButtonState();
    }
  }, 120);
});

export async function showPreview(item) {
  if (!container || !item || item.is_dir) {
    clearPreview();
    return;
  }
  if (previewLoadingOperation) {
    previewLoadingOperation.cancel({ silent: true });
  }
  const label = item.displayName || item.name || 'Selected file';
  const cancelToken = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const operation = createLoadingOperation({
    message: 'Loading document preview...',
    detail: label,
    onCancel: () => {
      cancelPreview(cancelToken);
      if (previewState?.item?.path === item.path) {
        clearPreview();
      }
    },
  });
  previewLoadingOperation = operation;
  updatePreviewTitle('');
  try {
    setStatus('Loading preview…');
    const data = await fetchPreview(item.path, {
      signal: operation.signal,
      cancelToken,
    });
    if (operation.isAborted()) return;
    renderPreview(data, item);
    updatePreviewTitle(item.displayName || item.name || '');
  } catch (error) {
    if (!operation.isAborted() && !isAbortError(error)) {
      handleError(error);
    }
  } finally {
    operation.finish();
    if (previewLoadingOperation === operation) {
      previewLoadingOperation = null;
      setStatus('Saved/Idle');
    }
  }
}

export function clearPreview() {
  disposePdfFrame?.();
  disposePdfFrame = null;
  if (!container) return;
  container.innerHTML =
    '<div class="preview-placeholder text-muted">Select a file to preview.</div>';
  if (controlsContainer) {
    controlsContainer.innerHTML = '';
  }
  previewState = null;
  setPreviewOpenEnabled(false);
  setFullscreenEnabled(false);
  updatePreviewOpenOptions(false);
  togglePdfExtractButton(false);
  updatePreviewTitle('');
  updatePreviewMetaBadges({});
  if (imageResizeObserver) {
    imageResizeObserver.disconnect();
    imageResizeObserver = null;
  }
}

export function releasePreviewForPaths(paths) {
  if (!previewState || !Array.isArray(paths) || !paths.length) return;
  const normalised = paths.map((path) => String(path));
  if (normalised.some((path) => previewState?.item?.path === path)) {
    clearPreview();
  }
}

/** Dispatch preview rendering based on detected type. */
function renderPreview(data, item) {
  disposePdfFrame?.();
  disposePdfFrame = null;
  if (!container) return;
  container.innerHTML = '';
  previewState = {
    item,
    data,
    zoom: 1,
    rotation: 0,
    page: 1,
    totalPages: data.pages || 0,
    mime: data.mime,
    url: data.url || fetchFileUrl(item.path),
    type: data.type,
    showMetadata: state.settings.preview.showMetadata,
    language: data.language || null,
    bodyElement: null,
  };
  setPreviewOpenEnabled(true);
  setFullscreenEnabled(true);
  updatePreviewOpenOptions(data.type === 'image');
  togglePdfExtractButton(data.type === 'pdf');
  renderMetadata(data.metadata);
  applyMetadataVisibility();
  updatePreviewMetaBadges(item);
  void refreshPreviewMeta(item);
  const body = document.createElement('div');
  body.className = 'preview-body';
  body.id = 'preview-body';
  container.appendChild(body);
  previewState.bodyElement = body;
  if (controlsContainer) {
    controlsContainer.innerHTML = '';
  }
  switch (data.type) {
    case 'text':
      renderText(data, item);
      break;
    case 'code':
      renderCode(data, item);
      break;
    case 'image':
      renderImage(data, item);
      break;
    case 'pdf':
      renderPdf(data, item);
      break;
    case 'notice':
      renderNotice(data, item);
      break;
    default:
      renderBinary(data, item);
      break;
  }
}

/** Render file metadata alongside previews. */
function renderMetadata(metadata = {}) {
  if (!container) return;
  const block = document.createElement('div');
  block.className = 'preview-meta';
  block.id = 'preview-metadata';
  const validationState = Boolean(metadata.validated);
  // qualifile-reviewed-html: preview metadata values are escaped or formatter-controlled
  block.innerHTML = `
        <dl>
            <dt>Name</dt><dd>${escapeHtml(metadata.name || '')}</dd>
            <dt>Type</dt><dd>${escapeHtml(metadata.type || '')}</dd>
            <dt>Validation</dt><dd id="preview-validation-state">${describeValidation(validationState)}</dd>
            <dt>Size</dt><dd>${formatSize(metadata.size)}</dd>
            <dt>Modified</dt><dd>${formatDate(metadata.modified)}</dd>
            <dt>Created</dt><dd>${formatDate(metadata.created)}</dd>
            <dt>Path</dt><dd class="text-break">${escapeHtml(metadata.path || '')}</dd>
            <dt>Location</dt><dd class="text-break">${escapeHtml(metadata.absolute || '')}</dd>
        </dl>
    `;
  container.appendChild(block);
  applyValidationToPreview(validationState);
}

function updatePreviewTitle(name) {
  if (!previewNameLabel) return;
  const value = name || '';
  previewNameLabel.textContent = value;
  if (value) {
    previewNameLabel.setAttribute('title', value);
  } else {
    previewNameLabel.removeAttribute('title');
  }
}

function canonicalTagPath(path) {
  const normalized = normalizePath(path);
  return normalized || '.';
}

function updatePreviewMetaBadges(item) {
  if (!previewNameLabel) return;
  const tagsHtml = buildTagDots(item);
  const notesHtml = buildNoteIndicators(item);
  // qualifile-reviewed-html: preview badges are DOM-generated or constant fragments
  previewLabelTags.innerHTML = tagsHtml;
  previewLabelTags.style.display = tagsHtml ? 'inline-flex' : 'none';
  // qualifile-reviewed-html: preview badges are DOM-generated or constant fragments
  previewLabelNotes.innerHTML = notesHtml;
  previewLabelNotes.style.display = notesHtml ? 'inline-flex' : 'none';
  const showDivider = Boolean(tagsHtml && notesHtml);
  previewLabelDivider.style.display = showDivider ? 'inline' : 'none';
}

async function refreshPreviewMeta(item) {
  if (!item?.path) return;
  const next = { ...item };
  try {
    const response = await fetchNotes(item.path);
    if (response) {
      next.notes = Array.isArray(response.notes) ? response.notes : [];
      next.note_summary = response.summary || {};
    }
  } catch (error) {
    // Non-blocking: errors here shouldn't break the preview pane
    warnDiagnostic('PreviewNoteMetadataRefreshFailure', error);
  }
  if (previewState) {
    previewState.item = { ...previewState.item, ...next };
  }
  updatePreviewMetaBadges(next);
}

function buildTagDots(item) {
  const tags = Array.isArray(item?.tags) ? item.tags : null;
  const lookup = new Map();
  (state.tags || []).forEach((tag) => {
    if (tag && tag.id) {
      lookup.set(tag.id, tag);
    }
  });
  let tagIds = tags;
  if (!tagIds) {
    const key = canonicalTagPath(item?.path || '');
    tagIds = state.tagAssignments?.[key] || [];
  }
  if (!Array.isArray(tagIds) || !tagIds.length) return '';
  const container = document.createDocumentFragment();
  tagIds.forEach((id) => {
    const tag = lookup.get(id);
    if (!tag) return;
    const colors = resolveTagColors(tag.color);
    const name = tag.name || '';
    const dot = document.createElement('span');
    dot.className = 'tag-dot';
    dot.style.setProperty('--tag-color', colors.background);
    dot.setAttribute('title', name);
    dot.setAttribute('aria-label', name);
    container.appendChild(dot);
  });
  const wrapper = document.createElement('span');
  wrapper.appendChild(container);
  return wrapper.innerHTML;
}

function resolveTagColors(color) {
  const normalized = normalizeHex(color || '#6c757d');
  const text = pickTagTextColor(normalized);
  return { background: normalized, text };
}

function normalizeHex(value) {
  if (!value) return '#6c757d';
  const text = value.trim();
  if (!text) return '#6c757d';
  const hex = text.startsWith('#') ? text.slice(1) : text;
  if (hex.length === 3) {
    const expanded = hex
      .split('')
      .map((ch) => ch + ch)
      .join('');
    return `#${expanded}`.toLowerCase();
  }
  if (hex.length !== 6) {
    return '#6c757d';
  }
  return `#${hex.toLowerCase()}`;
}

function pickTagTextColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const luminance = 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
  return luminance > 0.6 ? '#0f1115' : '#ffffff';
}

function linearize(value) {
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function buildNoteIndicators(item) {
  const notes = item?.notes;
  const summary = item?.note_summary;
  const noteChildren = item?.note_children;
  const noteList = Array.isArray(notes) ? notes : [];
  const hasDirect = noteList.length || (summary && (summary.open_count || summary.closed_count));
  const allClosed =
    hasDirect &&
    ((noteList.length && noteList.every((note) => (note?.status || 'none') === 'closed')) ||
      (!noteList.length && (summary?.open_count || 0) === 0 && (summary?.closed_count || 0) > 0));
  const effectiveHasDirect = hasDirect && !allClosed;
  const hasAny = noteChildren || effectiveHasDirect;
  if (!hasAny) return '';
  const hasDeadline =
    effectiveHasDirect &&
    (noteList.some((note) => !!note.deadline) || Boolean(summary?.has_overdue));
  const hasHighPriority =
    effectiveHasDirect &&
    (noteList.some((note) => note.priority === 'high') || Boolean(summary?.has_high_priority));
  const parts = [];
  if (effectiveHasDirect) {
    parts.push(
      '<span class="note-indicator" title="Notes available" aria-label="Notes available">📄</span>'
    );
    if (hasDeadline) {
      parts.push(
        '<span class="note-indicator" title="Deadline present" aria-label="Deadline present">⏰</span>'
      );
    }
    if (hasHighPriority) {
      parts.push(
        '<span class="note-indicator" title="High priority note" aria-label="High priority note">❗</span>'
      );
    }
  }
  if (noteChildren && !effectiveHasDirect) {
    parts.push(
      '<span class="note-indicator" title="Folder contains noted items" aria-label="Folder contains noted items">📚</span>'
    );
  } else if (noteChildren && effectiveHasDirect) {
    parts.push(
      '<span class="note-indicator" title="Folder contains noted items" aria-label="Folder contains noted items">📚</span>'
    );
  }
  return parts.join('');
}

function getPreviewBody() {
  if (previewState?.bodyElement) {
    return previewState.bodyElement;
  }
  if (!container) {
    throw new Error('Preview container not ready');
  }
  const body = document.createElement('div');
  body.className = 'preview-body';
  body.id = 'preview-body';
  container.appendChild(body);
  if (previewState) {
    previewState.bodyElement = body;
  }
  return body;
}

function createPreviewRegion(options = {}) {
  const body = getPreviewBody();
  const region = document.createElement('div');
  region.className = 'preview-region';
  if (options.scrollable) {
    region.classList.add('preview-scroll-region');
  }
  body.appendChild(region);
  return region;
}

/** Show or hide metadata based on preferences. */
function applyMetadataVisibility() {
  const block = document.getElementById('preview-metadata');
  if (!block) return;
  const visible = Boolean(previewState?.showMetadata);
  block.classList.toggle('d-none', !visible);
  if (metadataToggle) {
    metadataToggle.textContent = visible ? 'Hide details' : 'Show details';
    metadataToggle.setAttribute('aria-pressed', visible ? 'true' : 'false');
  }
}

/** Toggle metadata visibility and persist preference. */
function toggleMetadata() {
  if (!previewState) {
    state.settings.preview.showMetadata = !state.settings.preview.showMetadata;
    persistPreferences();
    if (metadataToggle) {
      metadataToggle.textContent = state.settings.preview.showMetadata
        ? 'Hide details'
        : 'Show details';
    }
    return;
  }
  previewState.showMetadata = !previewState.showMetadata;
  state.settings.preview.showMetadata = previewState.showMetadata;
  persistPreferences();
  applyMetadataVisibility();
}

/** Render textual previews with pagination. */
function renderText(data, item) {
  const region = createPreviewRegion({ scrollable: true });
  const pre = document.createElement('pre');
  pre.className = 'preview-text-block';
  pre.textContent = data.content || '';
  pre.setAttribute('aria-live', 'polite');
  region.appendChild(pre);
  const externalButton = document.createElement('button');
  externalButton.className = 'btn btn-sm btn-outline-secondary mt-3';
  externalButton.type = 'button';
  externalButton.textContent = 'Open externally';
  externalButton.addEventListener('click', async () => {
    try {
      await openInDefaultApp(item.path);
    } catch (error) {
      handleError(error);
    }
  });
  getPreviewBody().appendChild(externalButton);
  setupContentWheelZoom();
}

/** Render syntax-highlighted source previews. */
function renderCode(data, item) {
  const language = String(data.language || 'plain').toLowerCase();
  const languageClass = `language-${language}`;
  const region = createPreviewRegion({ scrollable: true });
  const pre = document.createElement('pre');
  pre.className = `preview-code-block ${languageClass}`;
  pre.dataset.language = language;
  pre.setAttribute('aria-live', 'polite');
  const code = document.createElement('code');
  code.className = languageClass;
  code.textContent = data.content || '';
  pre.appendChild(code);
  region.appendChild(pre);
  highlightCodeBlock(code);
  setupContentWheelZoom();
}

/** Render image previews with zoom controls. */
function renderImage(data, item) {
  const region = createPreviewRegion();
  const wrapper = document.createElement('div');
  wrapper.className = 'preview-image-container';
  const img = document.createElement('img');
  const baseUrl = data.url || fetchFileUrl(item.path);
  img.alt = item.name;
  img.decoding = 'async';
  img.loading = 'eager';
  img.draggable = false;
  img.style.transformOrigin = 'center center';
  img.style.transform = 'scale(1) rotate(0deg)';
  img.style.opacity = '0';
  wrapper.appendChild(img);
  region.appendChild(wrapper);
  const errorNotice = document.createElement('div');
  errorNotice.className = 'alert alert-warning mt-3 d-none';
  errorNotice.role = 'status';
  const errorText = document.createElement('div');
  errorText.textContent = 'Image preview failed to load.';
  const errorActions = document.createElement('div');
  errorActions.className = 'd-flex flex-wrap gap-2 mt-2';
  const retryButton = document.createElement('button');
  retryButton.type = 'button';
  retryButton.className = 'btn btn-sm btn-outline-secondary';
  retryButton.textContent = 'Retry';
  const openExternalButton = document.createElement('button');
  openExternalButton.type = 'button';
  openExternalButton.className = 'btn btn-sm btn-outline-secondary';
  openExternalButton.textContent = 'Open externally';
  errorActions.appendChild(retryButton);
  errorActions.appendChild(openExternalButton);
  errorNotice.appendChild(errorText);
  errorNotice.appendChild(errorActions);
  region.appendChild(errorNotice);

  const setImageSource = (bustCache = false) => {
    const url = new URL(baseUrl, window.location.origin);
    if (bustCache) {
      url.searchParams.set('ts', Date.now().toString());
    }
    img.src = url.toString();
  };
  const initialize = () => {
    errorNotice.classList.add('d-none');
    img.style.opacity = '1';
    initializeImageState(img);
  };
  const handleImageError = () => {
    img.style.opacity = '0';
    errorNotice.classList.remove('d-none');
  };
  img.addEventListener('load', initialize);
  img.addEventListener('error', handleImageError);
  retryButton.addEventListener('click', () => {
    errorNotice.classList.add('d-none');
    img.style.opacity = '0';
    setImageSource(true);
  });
  openExternalButton.addEventListener('click', async () => {
    try {
      await openInDefaultApp(item.path);
    } catch (error) {
      handleError(error);
    }
  });
  setImageSource(false);
  if (img.complete && img.naturalWidth) {
    initialize();
  }
  setupImageControls(img);
  enableImagePanning(wrapper, img);
  setupImageWheelZoom(wrapper, img);
}

/** Highlight a code block with Prism.js when available. */
function highlightCodeBlock(codeElement) {
  const prism = window.Prism;
  if (!prism || typeof prism.highlightElement !== 'function') return;
  try {
    prism.highlightElement(codeElement);
  } catch (error) {
    warnDiagnostic('SyntaxHighlightFailure', error);
  }
}

/** Open the current previewed file using the system handler. */
async function openCurrentPreview() {
  if (!previewState?.item) return;
  setPreviewOpenBusy(true);
  try {
    await openInDefaultApp(previewState.item.path);
  } catch (error) {
    handleError(error);
  } finally {
    setPreviewOpenBusy(false);
  }
}

async function openCurrentPreviewInGreenshot() {
  if (!previewState?.item) return;
  setPreviewOpenBusy(true);
  try {
    await openWithGreenshot(previewState.item.path);
  } catch (error) {
    // already handled in helper
  } finally {
    setPreviewOpenBusy(false);
  }
}

async function openCurrentNotes() {
  const targetPath = previewState?.item?.path || selectionArray()[0];
  if (!targetPath) return;
  try {
    const module = await import('../modals/modals.js');
    const opener = module?.openNotesModal;
    if (typeof opener === 'function') {
      const label = previewState?.item?.displayName || previewState?.item?.name || '';
      await opener(targetPath, label);
    }
  } catch (error) {
    handleError(error);
  }
}

function setPreviewOpenEnabled(enabled) {
  const hasTarget = enabled || selectionArray().length === 1;
  if (openButton) {
    openButton.disabled = !enabled;
    openButton.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    if (!enabled) {
      openButton.removeAttribute('aria-busy');
    }
  }
  togglePdfExtractButton(enabled && previewState?.type === 'pdf');
  if (notesButton) {
    notesButton.disabled = !hasTarget;
    notesButton.setAttribute('aria-disabled', hasTarget ? 'false' : 'true');
  }
  if (openSplitButton) {
    openSplitButton.disabled = !enabled;
    openSplitButton.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  }
}

function setPreviewOpenBusy(busy) {
  if (openButton) {
    openButton.disabled = busy;
    openButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
    if (busy) {
      openButton.setAttribute('aria-busy', 'true');
    } else {
      openButton.removeAttribute('aria-busy');
    }
  }
  if (openSplitButton && !openSplitButton.classList.contains('d-none')) {
    openSplitButton.disabled = busy;
    openSplitButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
  }
}

function updatePreviewOpenOptions(enableGreenshot) {
  if (!openSplitButton || !openDropdownMenu) return;
  if (enableGreenshot) {
    openSplitButton.classList.remove('d-none');
    openDropdownMenu.classList.remove('d-none');
  } else {
    openSplitButton.classList.add('d-none');
    openDropdownMenu.classList.add('d-none');
  }
}

function openFullscreenPreview() {
  if (!previewState || !fullscreenModal || !fullscreenBody || !previewPane) return;
  if (!previewPanePlaceholder) {
    previewPanePlaceholder = document.createElement('div');
    previewPanePlaceholder.id = 'preview-pane-placeholder';
    previewPanePlaceholder.style.display = 'none';
    previewPane.parentElement?.insertBefore(previewPanePlaceholder, previewPane);
  }
  previewPaneOriginalStyle = previewPane.getAttribute('style') || '';
  previewPane.removeAttribute('style');
  previewPane.classList.add('preview-pane-fullscreen');
  fullscreenBody.appendChild(previewPane);
  const modal = bootstrap.Modal.getOrCreateInstance(fullscreenModal);
  modal.show();
}

function setFullscreenEnabled(enabled) {
  if (!fullscreenButton) return;
  fullscreenButton.disabled = !enabled;
  fullscreenButton.setAttribute('aria-disabled', enabled ? 'false' : 'true');
}

function restorePreviewPane() {
  if (!previewPane || !previewPanePlaceholder) return;
  previewPane.classList.remove('preview-pane-fullscreen');
  if (previewPaneOriginalStyle) {
    previewPane.setAttribute('style', previewPaneOriginalStyle);
  } else {
    previewPane.removeAttribute('style');
  }
  previewPaneOriginalStyle = '';
  previewPanePlaceholder.parentNode?.insertBefore(previewPane, previewPanePlaceholder);
  previewPanePlaceholder.remove();
  previewPanePlaceholder = null;
}

/** Initialise scaling state once an image loads. */
function initializeImageState(img) {
  if (!previewState) return;
  previewState.imageElement = img;
  previewState.imageSize = {
    width: img.naturalWidth || img.width || 1,
    height: img.naturalHeight || img.height || 1,
  };
  previewState.rotation = previewState.rotation || 0;
  previewState.pan = { x: 0, y: 0 };
  updateScaleBounds(img, true);
  applyImageTransform(img);
  updateImageButtonState();
  observeImageContainer(img);
}

/** Observe container resizing to adjust zoom bounds. */
function observeImageContainer(img) {
  if (imageResizeObserver) {
    imageResizeObserver.disconnect();
    imageResizeObserver = null;
  }
  if (!window.ResizeObserver) return;
  const wrapper = img.closest('.preview-image-container');
  if (!wrapper) return;
  imageResizeObserver = new ResizeObserver(() => {
    if (!previewState?.imageElement) return;
    updateScaleBounds(previewState.imageElement, false);
    applyImageTransform(previewState.imageElement);
    updateImageButtonState();
  });
  imageResizeObserver.observe(wrapper);
}

/** Recalculate zoom limits for the current image. */
function updateScaleBounds(img, resetZoom) {
  if (!previewState?.imageSize) return;
  const containerSize = getImageContainerSize(img);
  const rotation = previewState.rotation || 0;
  const dims = rotatedDimensions(previewState.imageSize, rotation);
  const widthRatio = containerSize.width / dims.width;
  const heightRatio = containerSize.height / dims.height;
  const base = Math.min(widthRatio, heightRatio);
  const prefersWidth = dims.width >= dims.height;
  const previousDefault = previewState.defaultZoom ?? 1;
  const wasAtDefault = Math.abs((previewState.zoom ?? previousDefault) - previousDefault) <= 0.01;
  previewState.baseScale = base;
  const safeBase = Math.max(base, 1e-6);
  const minZoom = Math.min(MIN_ZOOM_FACTOR, 1 / safeBase);
  previewState.minZoom = minZoom;
  previewState.maxZoom = MAX_ZOOM_FACTOR;
  const fillScale = prefersWidth ? widthRatio : heightRatio;
  const containScale = Math.max(Math.min(widthRatio, heightRatio), 0);
  const autoScale = Math.max(fillScale, containScale);
  const defaultZoom = clamp(autoScale / safeBase, minZoom, previewState.maxZoom);
  previewState.defaultZoom = defaultZoom;
  if (resetZoom || wasAtDefault) {
    previewState.zoom = defaultZoom;
    previewState.pan = { x: 0, y: 0 };
  } else {
    previewState.zoom = clamp(
      previewState.zoom || defaultZoom,
      previewState.minZoom,
      previewState.maxZoom
    );
    if (!previewState.pan) {
      previewState.pan = { x: 0, y: 0 };
    }
  }
}

/** Measure the effective preview container size. */
function getImageContainerSize(img) {
  const wrapper = img.closest('.preview-image-container');
  const rect = wrapper?.getBoundingClientRect();
  const fallbackRect = container?.getBoundingClientRect();
  return {
    width: Math.max(rect?.width || fallbackRect?.width || 1, 1),
    height: Math.max(rect?.height || fallbackRect?.height || 1, 1),
  };
}

/** Compute the base scale that fits an image. */
/** Return image dimensions accounting for rotation. */
function rotatedDimensions(size, rotation) {
  const angle = ((rotation % 360) + 360) % 360;
  if (angle % 180 === 90) {
    return { width: size.height || 1, height: size.width || 1 };
  }
  return { width: size.width || 1, height: size.height || 1 };
}

/** Clamp numeric values to a range. */
function clamp(value, min, max) {
  if (min > max) return min;
  return Math.max(min, Math.min(max, value));
}

/** Apply scaling and rotation to the preview image. */
function applyImageTransform(img) {
  if (!previewState) return;
  const scale = (previewState.baseScale || 1) * (previewState.zoom || 1);
  const pan = constrainPan(img);
  img.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${scale}) rotate(${previewState.rotation}deg)`;
}

/** Enable or disable zoom controls based on limits. */
function updateImageButtonState() {
  if (!previewState?.imageControls) return;
  const epsilon = 0.01;
  const atMin = (previewState.zoom || 1) <= (previewState.minZoom || 1) + epsilon;
  const atMax = (previewState.zoom || 1) >= (previewState.maxZoom || 1) - epsilon;
  const defaultZoom = previewState.defaultZoom ?? 1;
  const atDefault = Math.abs((previewState.zoom || defaultZoom) - defaultZoom) <= epsilon;
  previewState.imageControls.forEach(({ id, element }) => {
    if (!element) return;
    if (id === 'zoom-in') {
      element.disabled = atMax;
    } else if (id === 'zoom-out') {
      element.disabled = atMin;
    } else if (id === 'reset-image') {
      element.disabled = atDefault && (previewState.rotation || 0) === 0;
    }
  });
}

/** Create image-specific control buttons. */
function setupImageControls(img) {
  if (!controlsContainer) return;
  controlsContainer.innerHTML = '';
  if (!previewState) return;
  previewState.imageControls = [];
  const buttons = [
    {
      id: 'zoom-in',
      icon: '+',
      label: 'Zoom in',
      handler: () => updateImageTransform(img, 0.2, 0),
    },
    {
      id: 'zoom-out',
      icon: '−',
      label: 'Zoom out',
      handler: () => updateImageTransform(img, -0.2, 0),
    },
    {
      id: 'rotate-left',
      icon: '⟲',
      label: 'Rotate left',
      handler: () => updateImageTransform(img, 0, -90),
    },
    {
      id: 'rotate-right',
      icon: '⟳',
      label: 'Rotate right',
      handler: () => updateImageTransform(img, 0, 90),
    },
    { id: 'reset-image', icon: '⟲⟲', label: 'Reset', handler: () => resetImageTransform(img) },
  ];
  buttons.forEach(({ id, icon, label, handler }) => {
    const button = createControlButton(id, icon, label, handler);
    previewState.imageControls.push({ id, element: button });
    controlsContainer.appendChild(button);
  });
  const annotateButton = document.createElement('button');
  annotateButton.type = 'button';
  annotateButton.id = 'preview-annotate';
  annotateButton.className = 'btn btn-outline-primary';
  annotateButton.textContent = 'Annotate';
  annotateButton.title = 'Annotate this image';
  annotateButton.addEventListener('click', () => {
    void openAnnotationWorkspace();
  });
  controlsContainer.appendChild(annotateButton);
  updateImageButtonState();
}

/** Update zoom/rotation in response to button presses. */
function updateImageTransform(img, zoomDelta, rotateDelta) {
  if (!previewState) return;
  if (rotateDelta) {
    previewState.rotation = (previewState.rotation + rotateDelta + 360) % 360;
    updateScaleBounds(img, false);
  }
  if (zoomDelta) {
    const minZoom = previewState.minZoom || 1;
    const maxZoom = previewState.maxZoom || 1;
    const target = (previewState.zoom || 1) + zoomDelta;
    previewState.zoom = clamp(target, minZoom, maxZoom);
  }
  applyImageTransform(img);
  updateImageButtonState();
}

/** Reset zoom and rotation to defaults. */
function resetImageTransform(img) {
  if (!previewState) return;
  previewState.rotation = 0;
  updateScaleBounds(img, true);
  applyImageTransform(img);
  updateImageButtonState();
}

/** Render PDFs via iframe with page controls. */
function renderPdf(data, item) {
  const url = data.url || fetchFileUrl(item.path);
  const region = createPreviewRegion();
  const wrapper = document.createElement('div');
  wrapper.className = 'preview-pdf-container';
  const iframe = document.createElement('iframe');
  iframe.title = item.name;
  wrapper.appendChild(iframe);
  region.appendChild(wrapper);
  disposePdfFrame = attachPdfFrame(iframe, url);
  setupPdfControls();
}

/** Create simple pagination controls for PDFs. */
function setupPdfControls() {
  if (!controlsContainer) return;
  controlsContainer.innerHTML = '';
  if (!previewState?.totalPages) {
    return;
  }
  const info = document.createElement('div');
  info.className = 'd-flex align-items-center gap-2 preview-page-count';
  const label = document.createElement('span');
  const count = previewState.totalPages;
  label.textContent = `${count} page${count === 1 ? '' : 's'}`;
  info.appendChild(label);
  controlsContainer.appendChild(info);
}

/** Render non-previewable files as download links. */
function renderBinary(data, item) {
  const download = document.createElement('a');
  download.href = data.url || fetchFileUrl(item.path);
  download.target = '_blank';
  download.rel = 'noreferrer';
  download.className = 'btn btn-outline-primary';
  download.textContent = 'Download file';
  getPreviewBody().appendChild(download);
  setupContentWheelZoom();
}

/** Render a notice when previews are unavailable. */
function renderNotice(data, item) {
  const alert = document.createElement('div');
  alert.className = 'alert alert-warning';
  alert.role = 'status';
  alert.textContent = data.notice || 'Preview unavailable for this file.';
  const body = getPreviewBody();
  body.appendChild(alert);
  if (!item) return;
  const externalButton = document.createElement('button');
  externalButton.className = 'btn btn-sm btn-outline-secondary mt-3';
  externalButton.type = 'button';
  externalButton.textContent = 'Open externally';
  externalButton.addEventListener('click', async () => {
    try {
      await openInDefaultApp(item.path);
    } catch (error) {
      handleError(error);
    }
  });
  body.appendChild(externalButton);
  setupContentWheelZoom();
}

/** Create a button element used by preview controls. */
function createControlButton(id, icon, label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-outline-secondary';
  button.id = id;
  button.dataset.action = id;
  // qualifile-reviewed-html: preview control icons come from the local constant control table
  button.innerHTML = `<span aria-hidden="true">${icon}</span>`;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', handler);
  return button;
}

async function openCurrentPdfExtract() {
  if (!previewState?.item) return;
  try {
    const module = await import('../modals/modals.js');
    const opener = module?.openPdfExtractModal;
    if (typeof opener === 'function') {
      opener(previewState.item.path);
    }
  } catch (error) {
    handleError(error);
  }
}

function togglePdfExtractButton(show) {
  if (!pdfExtractButton) return;
  const shouldShow = Boolean(show && previewState?.type === 'pdf');
  pdfExtractButton.classList.toggle('d-none', !shouldShow);
  pdfExtractButton.disabled = !shouldShow;
  pdfExtractButton.setAttribute('aria-disabled', shouldShow ? 'false' : 'true');
}

/** Ensure panning offsets keep the image within view. */
function constrainPan(img) {
  if (!previewState) return { x: 0, y: 0 };
  if (!previewState.pan) {
    previewState.pan = { x: 0, y: 0 };
  }
  const containerSize = getImageContainerSize(img);
  const dims = rotatedDimensions(
    previewState.imageSize || { width: 1, height: 1 },
    previewState.rotation || 0
  );
  const scale = (previewState.baseScale || 1) * (previewState.zoom || 1);
  const scaledWidth = dims.width * scale;
  const scaledHeight = dims.height * scale;
  const maxX = Math.max(0, (scaledWidth - containerSize.width) / 2);
  const maxY = Math.max(0, (scaledHeight - containerSize.height) / 2);
  const clamped = {
    x: clamp(previewState.pan.x, -maxX, maxX),
    y: clamp(previewState.pan.y, -maxY, maxY),
  };
  previewState.pan = clamped;
  return clamped;
}

/** Allow dragging the image to reveal zoomed areas. */
function enableImagePanning(wrapper, img) {
  if (!wrapper || !img) return;
  let isActive = false;
  let start = { x: 0, y: 0 };
  let origin = { x: 0, y: 0 };
  const endPan = (event) => {
    if (!isActive) return;
    isActive = false;
    wrapper.classList.remove('panning');
    if (event?.pointerId !== undefined) {
      try {
        wrapper.releasePointerCapture(event.pointerId);
      } catch (error) {
        // Ignore release failures when pointer capture is already cleared.
      }
    }
  };
  wrapper.addEventListener('pointerdown', (event) => {
    if (!previewState) return;
    if (event.button !== 0 && event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    isActive = true;
    start = { x: event.clientX, y: event.clientY };
    origin = { ...(previewState.pan || { x: 0, y: 0 }) };
    wrapper.classList.add('panning');
    event.preventDefault();
    try {
      wrapper.setPointerCapture(event.pointerId);
    } catch (error) {
      // Pointer capture may not be supported; continue without it.
    }
  });
  wrapper.addEventListener('pointermove', (event) => {
    if (!isActive || !previewState) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    previewState.pan = { x: origin.x + dx, y: origin.y + dy };
    applyImageTransform(img);
    event.preventDefault();
  });
  wrapper.addEventListener('pointerup', endPan);
  wrapper.addEventListener('pointercancel', endPan);
  wrapper.addEventListener('pointerleave', endPan);
}

/** Escape HTML entities for preview content. */
function escapeHtml(value = '') {
  return value.replace(
    /[&<>'"]/g,
    (match) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[match] || match
  );
}

function describeValidation(flag) {
  return flag ? 'Validated' : 'Not validated';
}

function applyValidationToPreview(validated) {
  if (previewState?.item) {
    previewState.item.validated = validated;
  }
  const validationRow = document.getElementById('preview-validation-state');
  if (validationRow) {
    validationRow.textContent = describeValidation(validated);
  }
}

function canonicalItemPath(path) {
  const normalized = normalizePath(path);
  return normalized || '.';
}

/** Format file sizes for metadata display. */
function formatSize(bytes) {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(1)} ${units[idx]}`;
}

/** Format ISO timestamps for display. */
function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString();
}

async function openAnnotationWorkspace() {
  if (!previewState || previewState.type !== 'image' || !previewState.item) return;
  try {
    await ensureFullscreenClosed();
    const module = await loadAnnotatorModule();
    const annotator = module?.openAnnotationModal;
    if (typeof annotator !== 'function') {
      throw new Error('Annotation module failed to load.');
    }
    annotator({
      path: previewState.item.path,
      displayName: previewState.item.displayName || previewState.item.name,
      name: previewState.item.name,
      url: previewState.url,
      mime: previewState.mime,
    });
  } catch (error) {
    handleError(error);
  }
}

async function ensureFullscreenClosed() {
  if (!fullscreenModal) return;
  const isOpen = fullscreenModal.classList.contains('show');
  if (!isOpen) return;
  const modalInstance = bootstrap.Modal.getOrCreateInstance(fullscreenModal);
  await new Promise((resolve) => {
    const handler = () => {
      fullscreenModal.removeEventListener('hidden.bs.modal', handler);
      resolve();
    };
    fullscreenModal.addEventListener('hidden.bs.modal', handler);
    modalInstance.hide();
  });
}

async function loadAnnotatorModule() {
  if (!annotatorModulePromise) {
    annotatorModulePromise = import('./annotator.js');
  }
  return annotatorModulePromise;
}

export function getPreviewedItem() {
  return previewState?.item || null;
}

clearPreview();

function setupContentWheelZoom() {
  if (!previewState?.bodyElement) return;
  if (previewState.type === 'image' || previewState.type === 'pdf') {
    teardownContentWheelZoom();
    return;
  }
  const body = previewState.bodyElement;
  body.classList.add('preview-content-zooming');
  previewState.contentZoom = clamp(
    previewState.contentZoom || 1,
    CONTENT_MIN_ZOOM,
    CONTENT_MAX_ZOOM
  );
  applyContentZoom();
  if (previewState.contentWheelHandler) {
    body.removeEventListener('wheel', previewState.contentWheelHandler);
  }
  const handler = (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const delta = event.deltaY;
    const step = delta < 0 ? CONTENT_ZOOM_STEP : -CONTENT_ZOOM_STEP;
    previewState.contentZoom = clamp(
      (previewState.contentZoom || 1) + step,
      CONTENT_MIN_ZOOM,
      CONTENT_MAX_ZOOM
    );
    applyContentZoom();
  };
  body.addEventListener('wheel', handler, { passive: false });
  previewState.contentWheelHandler = handler;
}

function teardownContentWheelZoom() {
  if (!previewState?.bodyElement) return;
  const body = previewState.bodyElement;
  if (previewState.contentWheelHandler) {
    body.removeEventListener('wheel', previewState.contentWheelHandler);
    previewState.contentWheelHandler = null;
  }
  body.classList.remove('preview-content-zooming');
  clearContentZoom();
}

function setupImageWheelZoom(wrapper, img) {
  if (!wrapper || !img) return;
  const handler = (event) => {
    event.preventDefault();
    const delta = event.deltaY;
    const step = delta < 0 ? 0.1 : -0.1;
    updateImageTransform(img, step, 0);
  };
  wrapper.addEventListener('wheel', handler, { passive: false });
}

function applyContentZoom() {
  if (!previewState?.bodyElement) return;
  const zoom = previewState.contentZoom || 1;
  const targets = previewState.bodyElement.querySelectorAll(
    '.preview-text-block, .preview-code-block, pre.preview-text-block, pre.preview-code-block, code'
  );
  targets.forEach((el) => {
    el.style.fontSize = `${zoom}rem`;
    el.style.lineHeight = '1.5';
  });
}

function clearContentZoom() {
  if (!previewState?.bodyElement) return;
  const targets = previewState.bodyElement.querySelectorAll(
    '.preview-text-block, .preview-code-block, pre.preview-text-block, pre.preview-code-block, code'
  );
  targets.forEach((el) => {
    el.style.removeProperty('font-size');
    el.style.removeProperty('line-height');
  });
}
