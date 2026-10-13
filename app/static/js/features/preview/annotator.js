import {
  loadAnnotationDocument,
  annotationBaseUrl,
  chooseAnnotationReference,
  supportedImage,
} from './image_history.js';
import { saveAnnotation, fetchList, handleError } from '../../shared/api.js';
import { showToast, setStatus } from '../../shared/ui.js';
import { requestGlobalRefresh } from '../../shared/refresh.js';
import { errorDiagnostic, warnDiagnostic } from '../../shared/diagnostics.js';
import {
  nextAnnotationNumber,
  selectionRectangle,
  rectanglesIntersect,
  isAnnotationTypingTarget,
} from './annotation_selection.js';
import {
  COLOR_TOOLS,
  buildDefaultToolColors,
  loadStoredToolColors,
  syncToolPalette,
  applyToolPalette,
  mimeToExtension,
  colorWithOpacity,
  clamp,
} from './annotator_helpers.js';
import { PdfAnnotationSession } from './pdf_annotations.js';
import { createAnnotationPanels } from './annotation_panels.js';

/**
 * Annotation workspace powered by Konva.js.
 *
 * Konva was selected instead of Fabric because its lightweight scene graph,
 * layer isolation, and built-in transformer support make it easier to keep the
 * preview image, annotations, and zoom/pan transforms perfectly in sync without
 * rewriting the existing preview pipeline. Konva's CDN bundle is smaller and
 * can be lazy-loaded only when needed, keeping the default preview payload
 * unchanged while still exposing an extensible API for future tools.
 */
const KONVA_CDN = 'https://cdn.jsdelivr.net/npm/konva@9.3.1/konva.min.js';
const OFFLINE_ASSETS = window.__QUALIFILE__?.offlineAssets === true;
const KONVA_LOCAL = '/static/dist/vendor/konva/konva.min.js';
const KONVA_SRC = OFFLINE_ASSETS ? KONVA_LOCAL : KONVA_CDN;

const elements = {
  modal: document.getElementById('modal-annotate'),
  fileLabel: document.getElementById('annotate-file-label'),
  stageHost: document.getElementById('annotate-stage'),
  stageWrapper: document.getElementById('annotate-stage-wrapper'),
  stageOverlay: document.getElementById('annotate-stage-overlay'),
  stageMessage: document.getElementById('annotate-stage-message'),
  toolButtons: Array.from(document.querySelectorAll('[data-annotate-tool]')),
  strokeColor: document.getElementById('annotate-stroke-color'),
  strokeWidth: document.getElementById('annotate-stroke-width'),
  highlightColor: document.getElementById('annotate-highlight-color'),
  highlightOpacity: document.getElementById('annotate-highlight-opacity'),
  zoomSlider: document.getElementById('annotate-zoom-slider'),
  zoomIn: document.getElementById('annotate-zoom-in'),
  zoomOut: document.getElementById('annotate-zoom-out'),
  zoomReset: document.getElementById('annotate-zoom-reset'),
  statusDisplay: document.getElementById('annotate-status-message'),
  actionSave: document.getElementById('annotate-action-save'),
  actionPrevious: document.getElementById('annotate-action-previous'),
  actionNext: document.getElementById('annotate-action-next'),
  pageControls: document.getElementById('annotate-pdf-pages'),
  pageNumber: document.getElementById('annotate-pdf-page'),
  pageCount: document.getElementById('annotate-pdf-page-count'),
  navigateDialog: document.getElementById('modal-annotate-navigate'),
  navigateSave: document.getElementById('annotate-navigate-save'),
  navigateDiscard: document.getElementById('annotate-navigate-discard'),
  actionUndo: document.getElementById('annotate-action-undo'),
  actionRedo: document.getElementById('annotate-action-redo'),
  actionDelete: document.getElementById('annotate-action-delete'),
  actionReset: document.getElementById('annotate-action-reset'),
  saveDialog: document.getElementById('modal-annotate-save'),
  saveDialogConfirm: document.getElementById('annotate-dialog-save'),
  saveDialogOverwrite: document.getElementById('annotate-dialog-overwrite'),
  saveDialogCopy: document.getElementById('annotate-dialog-copy'),
  saveDialogName: document.getElementById('annotate-dialog-name'),
  counterControls: document.getElementById('annotate-counter-controls'),
  counterNext: document.getElementById('annotate-counter-next'),
  counterRestart: document.getElementById('annotate-counter-restart'),
};

const DEFAULT_TOOL_COLORS = buildDefaultToolColors(elements);

const state = {
  konvaPromise: null,
  konva: null,
  modalInstance: null,
  saveModalInstance: null,
  stage: null,
  workspaceLayer: null,
  transformerLayer: null,
  contentGroup: null,
  annotationsGroup: null,
  transformer: null,
  imageNode: null,
  image: null,
  imageSize: { width: 1, height: 1 },
  baseScale: 1,
  zoom: 1,
  minZoom: 0.5,
  maxZoom: 4,
  tool: 'select',
  drawingShape: null,
  drawingStart: null,
  panStart: null,
  panOrigin: null,
  panAlt: false,
  nextCounterOverride: null,
  history: [],
  future: [],
  commandSerial: 0,
  historyManager: null,
  isRestoring: false,
  selectedNodes: [],
  selectionBox: null,
  selectionStart: null,
  selectionInitial: [],
  actionBefore: null,
  keyHandler: null,
  spacePanning: false,
  resizeObserver: null,
  filePath: '',
  fileName: '',
  mime: 'image/png',
  copyNameSuggestion: '',
  saving: false,
  navigationBusy: false,
  savedDocumentSnapshot: '',
  pdf: null,
  generation: 0,
  allowClose: false,
  closePending: false,
  closing: null,
  finishClosing: null,
  toolColors: loadStoredToolColors(DEFAULT_TOOL_COLORS),
};

const panelElementKeys = ['stageHost', 'stageWrapper', 'stageOverlay', 'stageMessage'];
const singlePanelElements = Object.fromEntries(panelElementKeys.map((key) => [key, elements[key]]));
const panelControlKeys = ['strokeColor', 'strokeWidth', 'highlightColor', 'highlightOpacity'];
const sessionKeys = [
  'stage',
  'workspaceLayer',
  'transformerLayer',
  'contentGroup',
  'annotationsGroup',
  'transformer',
  'imageNode',
  'image',
  'imageSize',
  'baseScale',
  'zoom',
  'tool',
  'drawingShape',
  'drawingStart',
  'panStart',
  'panOrigin',
  'panAlt',
  'nextCounterOverride',
  'history',
  'future',
  'commandSerial',
  'historyManager',
  'isRestoring',
  'selectedNodes',
  'selectionBox',
  'selectionStart',
  'selectionInitial',
  'actionBefore',
  'spacePanning',
  'resizeObserver',
  'filePath',
  'fileName',
  'mime',
  'copyNameSuggestion',
  'expectedHash',
  'savedDocumentSnapshot',
  'pdf',
  'toolColors',
];
let panels = null;

function storeActivePanel(deactivate = true) {
  const panel = panels?.panels.get(panels.active);
  if (!panel || !state.stage) return;
  panels.status(state.filePath, hasUnsavedChanges());
  if (deactivate) {
    state.resizeObserver?.disconnect();
    state.resizeObserver = null;
    state.stage.listening(false);
    state.transformer?.visible(false);
    state.transformerLayer?.draw();
  }
  panel.snapshot = Object.fromEntries(sessionKeys.map((key) => [key, state[key]]));
  panel.controls = Object.fromEntries(panelControlKeys.map((key) => [key, elements[key].value]));
}

function activatePanel(path, force = false) {
  const panel = panels?.panels.get(path);
  if (!panel?.snapshot || (!force && (panels.busy || state.saving || state.navigationBusy)))
    return false;
  if (panels.active === path && !force) return true;
  storeActivePanel();
  Object.assign(state, panel.snapshot);
  for (const key of panelControlKeys) elements[key].value = panel.controls[key];
  Object.assign(elements, {
    stageHost: panel.stageHost,
    stageWrapper: panel.wrapper,
    stageOverlay: panel.stageOverlay,
    stageMessage: panel.stageMessage,
  });
  panels.setActive(path);
  state.stage.listening(true);
  state.transformer?.visible(true);
  state.transformerLayer?.draw();
  elements.fileLabel.textContent = state.fileName;
  elements.saveDialogName.placeholder = state.copyNameSuggestion;
  elements.zoomSlider.value = String(state.zoom);
  updateDocumentControls(Boolean(state.pdf));
  const selected = state.selectedNodes;
  updateToolButtons(state.tool);
  setSelection(selected);
  updateHistoryButtons();
  observeStageResize();
  updateStatusMessage();
  elements.modal.focus({ preventScroll: true });
  return false;
}

async function openAnnotationPanels(options) {
  resetState();
  const area = singlePanelElements.stageWrapper.parentElement;
  panels = createAnnotationPanels({
    area,
    wrapper: singlePanelElements.stageWrapper,
    entries: options.files,
    activate: activatePanel,
  });
  panels.grid.dataset.layout = options.layout || '';
  panels.busy = true;
  updateEditingBusy();
  document.getElementById('annotate-action-save-all').classList.remove('d-none');
  document.getElementById('modal-annotate-label').textContent = 'Annotate files';
  elements.fileLabel.textContent = '';
  bindModalEvents();
  showModal();
  try {
    for (const panel of panels.panels.values()) {
      if (panel.entry.readOnly) continue;
      storeActivePanel();
      state.stage = null;
      state.pdf = null;
      state.resizeObserver = null;
      panels.setActive(panel.entry.path);
      Object.assign(elements, {
        stageHost: panel.stageHost,
        stageWrapper: panel.wrapper,
        stageOverlay: panel.stageOverlay,
        stageMessage: panel.stageMessage,
      });
      try {
        const saved = await loadAnnotationDocument(panel.entry.path);
        if (saved.document.kind === 'pdf') await preparePdfModal({ ...panel.entry, saved });
        else
          await prepareModal({ ...panel.entry, saved, url: annotationBaseUrl(panel.entry.path) });
        if (state.stage) storeActivePanel();
      } catch (error) {
        panels.status(panel.entry.path, false, 'Unavailable');
        setOverlay(true, error.message || 'Unable to load this file.');
      } finally {
        if (!state.stage) {
          state.pdf?.destroy();
          state.pdf = null;
          panels.status(panel.entry.path, false, 'Unavailable');
        }
      }
    }
    const first = panels.panels.get(options.path)?.snapshot
      ? options.path
      : [...panels.panels.values()].find((panel) => panel.snapshot)?.entry.path;
    if (first) activatePanel(first, true);
    else elements.modal.querySelector('.annotate-header-toolbar').inert = true;
  } finally {
    panels.busy = false;
    updateEditingBusy();
  }
}

async function saveAllPanels() {
  if (!panels || panels.busy || state.saving || state.navigationBusy) return false;
  const initial = panels.active;
  storeActivePanel();
  panels.busy = true;
  updateEditingBusy();
  let success = true;
  try {
    const dirty = [...panels.panels.values()].filter((panel) => panel.dirty && panel.snapshot);
    for (const [index, panel] of dirty.entries()) {
      activatePanel(panel.entry.path, true);
      updateStatusMessage(`Saving ${index + 1} of ${dirty.length}`);
      if (!(await handleSave('overwrite', '', true))) {
        success = false;
        panels.status(panel.entry.path, true, 'Save failed');
      }
      storeActivePanel();
    }
  } finally {
    activatePanel(initial, true);
    panels.busy = false;
    updateEditingBusy();
  }
  return success;
}

export async function openAnnotationModal(options = {}) {
  if (!elements.modal || !elements.stageHost || !elements.stageWrapper) {
    errorDiagnostic('AnnotationModalMarkupMissing');
    return;
  }
  try {
    if (state.closing) await state.closing;
    await ensureKonvaLoaded();
    if (options.files?.length > 1) {
      await openAnnotationPanels(options);
      return;
    }
    const saved = await loadAnnotationDocument(options.path);
    if (saved.document.kind === 'pdf') {
      await preparePdfModal({ ...options, mime: 'application/pdf', saved });
    } else {
      void prepareModal({ ...options, url: annotationBaseUrl(options.path), saved }).catch(
        handleError
      );
    }
  } catch (error) {
    handleError(error);
  }
}

function hasUnsavedChanges() {
  if (!state.annotationsGroup) return false;
  if (state.pdf) {
    state.pdf.update(annotationDocument());
    return state.pdf.dirty;
  }
  return JSON.stringify(annotationDocument()) !== state.savedDocumentSnapshot;
}

function updateEditingBusy() {
  const busy = state.saving || state.navigationBusy || Boolean(panels?.busy);
  elements.modal.querySelector('.modal-content').inert = busy;
  state.stage?.listening(!busy);
}

function updateDocumentControls(isPdf) {
  document.getElementById('modal-annotate-label').textContent = isPdf
    ? 'Annotate PDF'
    : 'Annotate image';
  elements.pageControls?.classList.toggle('d-none', !isPdf);
  for (const [button, direction] of [
    [elements.actionPrevious, 'Previous'],
    [elements.actionNext, 'Next'],
  ]) {
    if (!button) continue;
    const label = `${direction} ${isPdf ? 'page' : 'image'}`;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = false;
  }
  if (state.pdf) {
    elements.pageNumber.value = String(state.pdf.pageIndex + 1);
    elements.pageNumber.max = String(state.pdf.count);
    elements.pageCount.textContent = `of ${state.pdf.count}`;
    elements.actionPrevious.disabled = state.pdf.pageIndex === 0;
    elements.actionNext.disabled = state.pdf.pageIndex === state.pdf.count - 1;
  } else if (panels) {
    elements.actionPrevious.disabled = true;
    elements.actionNext.disabled = true;
  }
}

async function preparePdfModal(options) {
  resetState();
  const generation = state.generation;
  state.filePath = options.path;
  state.fileName = options.displayName || options.name || options.path;
  state.mime = 'application/pdf';
  state.expectedHash = options.saved.hash;
  state.copyNameSuggestion = `${state.fileName
    .replace(/\.[^.]+$/, '')
    .split(/[\\/]/)
    .pop()}-annotated.pdf`;
  elements.fileLabel.textContent = state.fileName;
  elements.saveDialogName.value = '';
  elements.saveDialogName.placeholder = state.copyNameSuggestion;
  elements.saveDialogOverwrite.checked = true;
  elements.saveDialogCopy.checked = false;
  updateSaveMode();
  updateDocumentControls(true);
  setOverlay(true, 'Loading PDF...');
  elements.actionSave.disabled = true;
  bindModalEvents();
  showModal();
  try {
    const session = await PdfAnnotationSession.open(options.path, options.saved);
    if (generation !== state.generation) {
      session.destroy();
      return;
    }
    state.pdf = session;
    await navigatePdfPage(0, true);
  } catch (error) {
    if (generation === state.generation) setOverlay(true, error.message);
    throw error;
  }
}

async function navigatePdfPage(index, initial = false) {
  const session = state.pdf;
  if (!session || state.navigationBusy || state.saving || index < 0 || index >= session.count)
    return;
  if (!initial && index === session.pageIndex) return;
  if (state.annotationsGroup) {
    session.update(annotationDocument());
    session.histories.set(session.pageIndex, {
      manager: state.historyManager,
      next: state.nextCounterOverride,
    });
  }
  state.navigationBusy = true;
  updateEditingBusy();
  elements.actionSave.disabled = true;
  elements.pageNumber.disabled = true;
  setOverlay(true, `Loading page ${index + 1}...`);
  try {
    const canvas = await session.render(index);
    if (session !== state.pdf) return;
    teardownStage();
    state.image = canvas;
    state.imageSize = { width: session.current.width, height: session.current.height };
    state.zoom = 1;
    initializeStage();
    installDocument(session.current);
    const history = session.histories.get(index);
    state.historyManager = history?.manager || createHistoryManager();
    state.nextCounterOverride = history?.next ?? null;
    updateCounterControls();
    updateHistoryButtons();
    updateDocumentControls(true);
    setOverlay(false);
    updateStatusMessage(`Page ${index + 1} of ${session.count}`);
  } catch (error) {
    if (session === state.pdf) {
      setOverlay(true, 'Unable to load this page. Choose another page or close the editor.');
      updateDocumentControls(true);
      handleError(error);
    }
  } finally {
    state.navigationBusy = false;
    updateEditingBusy();
    elements.actionSave.disabled = !state.stage;
    elements.pageNumber.disabled = false;
    elements.modal.focus({ preventScroll: true });
  }
}

async function prepareModal(options) {
  resetState();
  const generation = state.generation;
  updateDocumentControls(false);
  elements.actionSave.disabled = false;
  state.filePath = options.path;
  state.expectedHash = options.saved.hash;
  state.fileName = options.displayName || options.name || options.path || 'image.png';
  state.mime = options.mime || 'image/png';
  if (elements.fileLabel) {
    elements.fileLabel.textContent = state.fileName;
  }
  const extension = mimeToExtension(state.mime);
  const base = state.fileName.replace(/\.[^.]+$/, '') || 'image';
  state.copyNameSuggestion = `${base}-annotated${extension}`;
  if (elements.saveDialogName) {
    elements.saveDialogName.placeholder = state.copyNameSuggestion;
    elements.saveDialogName.value = '';
    elements.saveDialogName.disabled = true;
  }
  if (elements.saveDialogOverwrite) {
    elements.saveDialogOverwrite.checked = true;
  }
  if (elements.saveDialogCopy) {
    elements.saveDialogCopy.checked = false;
  }
  updateSaveMode();
  updateSaveMode();
  updateStatusMessage('Loading image...');
  setOverlay(true, 'Loading image...');
  const image = new Image();
  image.decoding = 'async';
  const ready = new Promise((resolve, reject) => {
    image.onload = () => {
      if (generation !== state.generation) {
        resolve(false);
        return;
      }
      state.image = image;
      state.imageSize = {
        width: image.naturalWidth || image.width || 1,
        height: image.naturalHeight || image.height || 1,
      };
      initializeStage();
      installDocument(options.saved.document);
      state.savedDocumentSnapshot = JSON.stringify(annotationDocument());
      setOverlay(false);
      resolve(true);
    };
    image.onerror = () => {
      if (generation !== state.generation) {
        resolve(false);
        return;
      }
      setOverlay(true, 'Unable to load this image for annotation.');
      reject(new Error('Unable to load this image for annotation.'));
    };
  });
  image.src = options.url;
  bindModalEvents();
  showModal();
  return ready;
}

function showModal() {
  if (!state.modalInstance) {
    const bootstrapModal = window.bootstrap?.Modal;
    if (!bootstrapModal) {
      throw new Error('Unable to initialize modal: Bootstrap is unavailable.');
    }
    state.modalInstance = new bootstrapModal(elements.modal, { focus: true });
  }
  state.modalInstance.show();
}

function resetState() {
  elements.modal.querySelector('.annotate-header-toolbar').inert = false;
  state.generation += 1;
  state.pdf?.destroy();
  state.pdf = null;
  state.allowClose = false;
  state.closePending = false;
  teardownStage();
  state.zoom = 1;
  state.baseScale = 1;
  state.nextCounterOverride = null;
  state.history = [];
  state.future = [];
  state.commandSerial = 0;
  state.historyManager = createHistoryManager();
  state.isRestoring = false;
  state.selectedNodes = [];
  state.selectionStart = null;
  state.selectionInitial = [];
  state.actionBefore = null;
  state.drawingShape = null;
  state.drawingStart = null;
  state.panStart = null;
  state.panOrigin = null;
  state.panAlt = false;
  state.spacePanning = false;
  state.saving = false;
  state.savedDocumentSnapshot = '';
  state.toolColors = loadStoredToolColors(DEFAULT_TOOL_COLORS);
  updateToolButtons('select');
  elements.actionUndo?.setAttribute('disabled', 'true');
  elements.actionRedo?.setAttribute('disabled', 'true');
  elements.actionDelete?.setAttribute('disabled', 'true');
  elements.actionSave?.removeAttribute('aria-busy');
  if (elements.statusDisplay) {
    elements.statusDisplay.textContent = '';
  }
  if (elements.zoomSlider) {
    elements.zoomSlider.value = '1';
  }
}

function bindModalEvents() {
  if (elements.modal.dataset.annotateBound === 'true') return;

  elements.modal.addEventListener('hidden.bs.modal', () => {
    state.generation += 1;
    state.pdf?.destroy();
    state.pdf = null;
    teardownStage();
    detachKeyboard();
    if (panels) {
      panels.destroy();
      panels = null;
      Object.assign(elements, singlePanelElements);
      document.getElementById('annotate-action-save-all').classList.add('d-none');
    }
    state.finishClosing?.();
    state.closing = null;
    state.finishClosing = null;
  });
  elements.modal.addEventListener('hide.bs.modal', (event) => {
    const markClosing = () => {
      if (!event.defaultPrevented)
        state.closing = new Promise((resolve) => {
          state.finishClosing = resolve;
        });
    };
    if (state.allowClose) {
      markClosing();
      return;
    }
    if (state.saving || state.navigationBusy || panels?.busy) {
      event.preventDefault();
      return;
    }
    const dirty = panels
      ? (storeActivePanel(false), [...panels.panels.values()].some((panel) => panel.dirty))
      : state.stage && hasUnsavedChanges();
    if (panels && state.stage) state.stage.listening(true);
    if (!dirty) {
      markClosing();
      return;
    }
    event.preventDefault();
    if (state.closePending) return;
    state.closePending = true;
    void chooseNavigationAction().then(async (action) => {
      try {
        if (action === 'cancel') return;
        if (
          action === 'save' &&
          !(panels ? await saveAllPanels() : await handleSave('overwrite', '', true))
        )
          return;
        state.allowClose = true;
        state.modalInstance?.hide();
      } finally {
        state.closePending = false;
      }
    });
  });

  document.getElementById('annotate-apply-reference')?.addEventListener('click', async () => {
    if (state.saving || state.navigationBusy) return;
    const generation = state.generation;
    try {
      const reference = await chooseAnnotationReference({ includePdf: Boolean(state.pdf) });
      if (!reference || generation !== state.generation || state.saving || state.navigationBusy)
        return;
      if (
        reference.document.width !== state.imageSize.width ||
        reference.document.height !== state.imageSize.height
      ) {
        throw new Error('Exact annotation duplication requires matching dimensions.');
      }
      const previous = annotationDocument();
      let next = reference.document;
      if (reference.preserveExisting) {
        const usedIds = new Set(previous.nodes.map((node) => node.attrs?.annotationId));
        const additions = reference.document.nodes.map((saved) => {
          const node = structuredClone(saved);
          let id;
          do {
            id = `annotation-${++state.commandSerial}`;
          } while (usedIds.has(id));
          node.attrs = { ...node.attrs, annotationId: id };
          usedIds.add(id);
          return node;
        });
        next = { ...previous, nodes: [...previous.nodes, ...additions] };
      }
      state.historyManager.execute({
        do: () => installDocument(next),
        undo: () => installDocument(previous),
      });
      updateStatusMessage(
        reference.preserveExisting
          ? 'Reference annotations added. Review and save.'
          : 'Reference annotations applied. Review and save.'
      );
    } catch (error) {
      handleError(error);
    }
  });
  elements.saveDialogCopy?.addEventListener('change', updateSaveMode);
  elements.saveDialogOverwrite?.addEventListener('change', updateSaveMode);

  elements.actionSave?.addEventListener('click', () => openSaveDialog());
  document
    .getElementById('annotate-action-save-all')
    ?.addEventListener('click', () => void saveAllPanels());
  elements.actionPrevious?.addEventListener('click', () => void navigateImage(-1));
  elements.actionNext?.addEventListener('click', () => void navigateImage(1));
  elements.pageNumber?.addEventListener('change', () => {
    const page = Number(elements.pageNumber.value);
    if (state.pdf && Number.isInteger(page) && page >= 1 && page <= state.pdf.count) {
      void navigatePdfPage(page - 1);
    } else {
      updateDocumentControls(Boolean(state.pdf));
    }
  });

  elements.saveDialogConfirm?.addEventListener('click', () => {
    const mode = elements.saveDialogCopy?.checked ? 'copy' : 'overwrite';
    const provided = elements.saveDialogName?.value.trim() || '';
    state.saveModalInstance?.hide();
    void handleSave(mode, provided, Boolean(panels));
  });

  elements.saveDialog?.addEventListener('hidden.bs.modal', () => {
    if (elements.saveDialogName) {
      elements.saveDialogName.value = '';
    }
  });

  elements.actionUndo?.addEventListener('click', () => undo());
  elements.actionRedo?.addEventListener('click', () => redo());
  elements.actionDelete?.addEventListener('click', () => removeSelection());
  elements.actionReset?.addEventListener('click', () => resetView());
  elements.counterNext?.addEventListener('input', () => {
    const number = Number(elements.counterNext.value);
    const valid = Number.isSafeInteger(number) && number > 0 && number < Number.MAX_SAFE_INTEGER;
    elements.counterNext.setCustomValidity(valid ? '' : 'Enter a positive whole number.');
    state.nextCounterOverride = valid ? number : null;
  });
  elements.counterNext?.addEventListener('blur', () => {
    elements.counterNext.setCustomValidity('');
    updateCounterControls();
  });
  elements.counterRestart?.addEventListener('click', () => {
    state.nextCounterOverride = 1;
    updateCounterControls();
    focusToolButton('counter');
  });

  elements.strokeColor?.addEventListener('change', () => {
    state.toolColors = syncToolPalette(state.tool, elements, state.toolColors, DEFAULT_TOOL_COLORS);
    updateStatusMessage();
  });

  elements.strokeWidth?.addEventListener('change', () => {
    updateStatusMessage();
  });

  elements.highlightColor?.addEventListener('change', () => {
    state.toolColors = syncToolPalette(state.tool, elements, state.toolColors, DEFAULT_TOOL_COLORS);
    updateStatusMessage();
  });

  elements.highlightOpacity?.addEventListener('input', () => {
    updateStatusMessage();
  });

  elements.zoomSlider?.addEventListener('input', (event) => {
    const targetZoom = Number(event.target.value);
    applyZoom(targetZoom);
  });

  elements.zoomIn?.addEventListener('click', () => applyZoom(state.zoom + 0.15));
  elements.zoomOut?.addEventListener('click', () => applyZoom(state.zoom - 0.15));
  elements.zoomReset?.addEventListener('click', () => applyZoom(1));

  elements.toolButtons.forEach((button) => {
    button.addEventListener('click', () => {
      updateToolButtons(button.dataset.annotateTool);
    });
  });

  elements.modal.dataset.annotateBound = 'true';
}

async function handleSave(
  mode = 'overwrite',
  providedName = '',
  keepOpen = false,
  navigationSave = false
) {
  if (
    state.saving ||
    (state.navigationBusy && !navigationSave) ||
    !state.stage ||
    !state.annotationsGroup
  )
    return false;
  const effectiveMode = mode === 'copy' ? 'copy' : 'overwrite';
  let filename = '';
  if (effectiveMode === 'copy') {
    filename = providedName || state.copyNameSuggestion;
  }
  try {
    state.saving = true;
    updateEditingBusy();
    if (elements.actionSave) {
      elements.actionSave.disabled = true;
      elements.actionSave.setAttribute('aria-busy', 'true');
    }
    setStatus('Saving annotations...');
    let result;
    if (state.pdf) {
      state.pdf.update(annotationDocument());
      result = await state.pdf.save(effectiveMode, filename);
      state.expectedHash = state.pdf.hash;
    } else {
      const dataUrl = await exportComposite();
      result = await saveAnnotation({
        path: state.filePath,
        mode: effectiveMode,
        filename,
        dataUrl,
        document: annotationDocument(),
        overlay: await exportComposite(true),
        expectedHash: state.expectedHash,
      });
    }
    const overwritten = (result?.mode || effectiveMode) === 'overwrite';
    if (overwritten && result?.hash) state.expectedHash = result.hash;
    showToast(effectiveMode === 'copy' ? 'Annotated copy saved.' : 'Annotations saved.');
    requestGlobalRefresh({ refreshList: true, refreshTree: false });
    if (overwritten) {
      document.dispatchEvent(
        new CustomEvent('qualifile:preview-refresh', {
          detail: { path: state.filePath },
        })
      );
    }
    setStatus('Saved/Idle');
    if (keepOpen) {
      if (overwritten) state.savedDocumentSnapshot = JSON.stringify(annotationDocument());
      if (panels) panels.status(state.filePath, hasUnsavedChanges());
    } else {
      state.allowClose = true;
      state.modalInstance?.hide();
    }
    return true;
  } catch (error) {
    handleError(error);
    return false;
  } finally {
    state.saving = false;
    updateEditingBusy();
    if (elements.actionSave) {
      elements.actionSave.disabled = false;
      elements.actionSave.removeAttribute('aria-busy');
    }
  }
}

function chooseNavigationAction() {
  if (!elements.navigateDialog) return Promise.resolve('cancel');
  const instance = window.bootstrap.Modal.getOrCreateInstance(elements.navigateDialog);
  elements.navigateDialog.querySelector('.modal-body').textContent = panels
    ? 'Save changes to all edited files before closing?'
    : 'Save your annotations before leaving? Save updates the current file.';
  elements.navigateSave.textContent = panels ? 'Save all' : 'Save';
  return new Promise((resolve) => {
    let choice = 'cancel';
    const finish = () => {
      elements.navigateSave.removeEventListener('click', save);
      elements.navigateDiscard.removeEventListener('click', discard);
      resolve(choice);
    };
    const save = () => {
      choice = 'save';
      instance.hide();
    };
    const discard = () => {
      choice = 'discard';
      instance.hide();
    };
    elements.navigateDialog.addEventListener('hidden.bs.modal', finish, { once: true });
    elements.navigateSave.addEventListener('click', save);
    elements.navigateDiscard.addEventListener('click', discard);
    instance.show();
  });
}

async function navigateImage(direction) {
  if (state.pdf) {
    await navigatePdfPage(state.pdf.pageIndex + direction);
    return;
  }
  if (state.navigationBusy || state.saving || !state.stage) return;
  state.navigationBusy = true;
  updateEditingBusy();
  try {
    const parts = state.filePath.replace(/\\/g, '/').split('/');
    const folder = parts.slice(0, -1).join('/') || '.';
    const listing = await fetchList(folder, false);
    const images = (listing.items || []).filter(
      (item) => !item.is_dir && supportedImage(item.path)
    );
    if (images.length < 2) {
      showToast('There are no other image files in the current folder.');
      return;
    }
    const index = images.findIndex(
      (item) => item.path.replace(/\\/g, '/') === state.filePath.replace(/\\/g, '/')
    );
    if (index < 0) throw new Error('The current image is no longer in this folder.');
    const target = images[(index + direction + images.length) % images.length];
    if (JSON.stringify(annotationDocument()) !== state.savedDocumentSnapshot) {
      const action = await chooseNavigationAction();
      if (action === 'cancel') return;
      if (action === 'save' && !(await handleSave('overwrite', '', true, true))) return;
    }
    const saved = await loadAnnotationDocument(target.path);
    const mime =
      target.mime ||
      (target.path.toLowerCase().endsWith('.png')
        ? 'image/png'
        : target.path.toLowerCase().endsWith('.webp')
          ? 'image/webp'
          : 'image/jpeg');
    prepareModal({
      path: target.path,
      name: target.name,
      mime,
      url: annotationBaseUrl(target.path),
      saved,
    });
  } catch (error) {
    handleError(error);
  } finally {
    state.navigationBusy = false;
    updateEditingBusy();
  }
}

function updateSaveMode() {
  const copyMode = Boolean(elements.saveDialogCopy?.checked);
  if (elements.saveDialogName) {
    elements.saveDialogName.disabled = !copyMode;
    if (!copyMode) {
      elements.saveDialogName.value = '';
    } else {
      elements.saveDialogName.focus();
    }
  }
}

function openSaveDialog(defaultMode = 'overwrite') {
  if (!elements.saveDialog) {
    void handleSave('overwrite', '', Boolean(panels));
    return;
  }
  const bootstrapModal = window.bootstrap?.Modal;
  if (!bootstrapModal) {
    void handleSave('overwrite', '', Boolean(panels));
    return;
  }
  if (!state.saveModalInstance) {
    state.saveModalInstance = new bootstrapModal(elements.saveDialog, { focus: true });
  }
  if (elements.saveDialogOverwrite && elements.saveDialogCopy) {
    if (defaultMode === 'copy') {
      elements.saveDialogOverwrite.checked = false;
      elements.saveDialogCopy.checked = true;
    } else {
      elements.saveDialogOverwrite.checked = true;
      elements.saveDialogCopy.checked = false;
    }
  }
  if (elements.saveDialogName) {
    elements.saveDialogName.disabled = defaultMode !== 'copy';
    elements.saveDialogName.value = '';
    elements.saveDialogName.placeholder = state.copyNameSuggestion || 'annotated.png';
    if (defaultMode === 'copy') {
      setTimeout(() => elements.saveDialogName?.focus(), 50);
    }
  }
  updateSaveMode();
  state.saveModalInstance.show();
}

function updateStatusMessage(message = '') {
  if (!elements.statusDisplay) return;
  const zoomPercent = Math.round(state.zoom * 100);
  const toolLabel = state.tool.charAt(0).toUpperCase() + state.tool.slice(1);
  const baseMessage = `${zoomPercent}% | ${toolLabel}`;
  elements.statusDisplay.textContent = message ? `${baseMessage} · ${message}` : baseMessage;
}

function setOverlay(visible, text) {
  if (!elements.stageOverlay) return;
  if (typeof text === 'string' && elements.stageMessage) {
    elements.stageMessage.textContent = text;
  }
  elements.stageOverlay.classList.toggle('hidden', !visible);
}

async function ensureKonvaLoaded() {
  if (window.Konva) {
    state.konva = window.Konva;
    return;
  }
  if (!state.konvaPromise) {
    state.konvaPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = KONVA_SRC;
      script.async = true;
      script.onload = () => {
        state.konva = window.Konva;
        resolve(window.Konva);
      };
      script.onerror = () => reject(new Error('Unable to load Konva.js'));
      document.head.appendChild(script);
    });
  }
  await state.konvaPromise;
}

function initializeStage() {
  const konva = state.konva;
  if (!konva || !elements.stageHost) return;
  const rect = elements.stageWrapper.getBoundingClientRect();
  state.stage = new konva.Stage({
    container: elements.stageHost,
    width: Math.max(rect.width, panels ? 1 : 300),
    height: Math.max(rect.height, panels ? 1 : 300),
  });
  state.workspaceLayer = new konva.Layer();
  state.transformerLayer = new konva.Layer();
  state.contentGroup = new konva.Group({ listening: true });
  state.annotationsGroup = new konva.Group({ name: 'annotations', listening: true });
  state.imageNode = new konva.Image({
    image: state.image,
    width: state.imageSize.width,
    height: state.imageSize.height,
    listening: false,
  });
  state.contentGroup.add(state.imageNode);
  state.contentGroup.add(state.annotationsGroup);
  state.workspaceLayer.add(state.contentGroup);
  state.stage.add(state.workspaceLayer);
  state.transformer = new konva.Transformer({
    rotateEnabled: true,
    anchorSize: 8,
    ignoreStroke: true,
    boundBoxFunc: (_, newBox) => newBox,
  });
  state.transformerLayer.add(state.transformer);
  state.selectionBox = new konva.Rect({
    fill: 'rgba(13, 110, 253, 0.12)',
    stroke: '#0d6efd',
    strokeWidth: 1,
    dash: [4, 3],
    listening: false,
    visible: false,
  });
  state.transformerLayer.add(state.selectionBox);
  state.stage.add(state.transformerLayer);
  state.transformer.on('transformstart', beginSelectionAction);
  state.transformer.on('transformend', finishSelectionAction);
  if (elements.stageWrapper && !elements.stageWrapper.dataset.annotateContextBound) {
    elements.stageWrapper.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });
    elements.stageWrapper.dataset.annotateContextBound = 'true';
  }
  const initializedStage = state.stage;
  const applyInitialView = () => {
    if (state.stage !== initializedStage) return;
    resetView(true);
  };
  applyInitialView();
  if (typeof window !== 'undefined') {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(applyInitialView);
    }
    window.setTimeout(applyInitialView, 160);
  }
  initializeHistory();
  attachStageEvents();
  attachKeyboard();
  observeStageResize();
  updateStatusMessage();
}

function teardownStage() {
  if (state.resizeObserver) {
    state.resizeObserver.disconnect();
    state.resizeObserver = null;
  }
  if (state.stage) {
    state.stage.destroy();
  }
  state.stage = null;
  state.workspaceLayer = null;
  state.transformerLayer = null;
  state.contentGroup = null;
  state.annotationsGroup = null;
  state.transformer = null;
  state.selectionBox = null;
  state.selectedNodes = [];
  state.actionBefore = null;
  state.imageNode = null;
  state.image = null;
}

function observeStageResize() {
  if (!window.ResizeObserver || !elements.stageWrapper) return;
  const observedStage = state.stage;
  state.resizeObserver = new ResizeObserver(() => {
    if (!state.stage || state.stage !== observedStage) return;
    const rect = elements.stageWrapper.getBoundingClientRect();
    state.stage.size({
      width: Math.max(rect.width, panels ? 1 : 300),
      height: Math.max(rect.height, panels ? 1 : 300),
    });
    fitContentToStage(false);
  });
  state.resizeObserver.observe(elements.stageWrapper);
}

function attachStageEvents() {
  if (!state.stage) return;
  const eventStage = state.stage;
  const canInteract = () =>
    state.stage === eventStage && !state.saving && !state.navigationBusy && !panels?.busy;
  state.stage.on('mousedown touchstart', (evt) => {
    if (!canInteract()) return;
    if (!state.stage || !state.contentGroup) return;
    const pointer = getContentPointerPosition(evt);
    const targetNode = evt.target;
    const parentNode = typeof targetNode?.getParent === 'function' ? targetNode.getParent() : null;
    const interactingWithTransformer = parentNode?.className === 'Transformer';
    if (interactingWithTransformer) {
      return;
    }
    const existingNode = findSelectableNode(targetNode);
    const isAltPan = evt.evt?.button === 2;
    if (isAltPan || state.tool === 'pan' || state.spacePanning) {
      state.panStart = state.stage.getPointerPosition();
      state.panOrigin = state.contentGroup.position();
      state.panAlt = Boolean(isAltPan);
      state.stage.container().classList.add('annotate-panning');
      return;
    }
    if (existingNode) {
      selectAnnotation(existingNode, evt.evt);
      return;
    }
    if (state.tool === 'select') {
      handleSelection(evt);
      return;
    }
    if (state.tool === 'counter') {
      if (pointer) {
        createCounter(pointer);
        const snap = captureNodeSnapshot(state.annotationsGroup.getChildren().slice(-1)[0]);
        if (snap) {
          state.historyManager.execute(createCreateCommand(snap), true);
        }
      }
      return;
    }
    if (!pointer) return;
    state.drawingStart = pointer;
    state.drawingShape = beginShape(pointer);
    if (!state.drawingShape) return;
  });
  state.stage.on('mousemove touchmove', () => {
    if (!canInteract()) return;
    if (state.selectionStart) {
      const pointer = state.stage.getPointerPosition();
      if (pointer) {
        state.selectionBox.setAttrs(selectionRectangle(state.selectionStart, pointer));
        state.selectionBox.visible(true);
        state.transformerLayer.batchDraw();
      }
      return;
    }
    if (
      (state.tool === 'pan' || state.spacePanning || state.panAlt) &&
      state.panStart &&
      state.contentGroup &&
      state.stage
    ) {
      const pointer = state.stage.getPointerPosition();
      if (!pointer || !state.panOrigin) return;
      const dx = pointer.x - state.panStart.x;
      const dy = pointer.y - state.panStart.y;
      state.contentGroup.position({
        x: state.panOrigin.x + dx,
        y: state.panOrigin.y + dy,
      });
      state.workspaceLayer?.batchDraw();
      return;
    }
    if (!state.drawingShape || !state.drawingStart) return;
    const pointer = getContentPointerPosition();
    updateShape(pointer);
  });
  state.stage.on('mouseup touchend', () => {
    if (!canInteract()) return;
    if (state.selectionStart) {
      finishMarqueeSelection();
      return;
    }
    if ((state.tool === 'pan' || state.spacePanning || state.panAlt) && state.panStart) {
      state.panStart = null;
      state.panOrigin = null;
      state.panAlt = false;
      state.stage?.container().classList.remove('annotate-panning');
      return;
    }
    finalizeShape();
  });
  state.stage.on('wheel', (evt) => {
    if (!canInteract()) return;
    evt.evt.preventDefault();
    const direction = evt.evt.deltaY > 0 ? -0.15 : 0.15;
    applyZoom(state.zoom + direction, evt);
  });
}

function handleSelection(evt) {
  const additive = evt.evt?.shiftKey || evt.evt?.ctrlKey || evt.evt?.metaKey;
  state.selectionInitial = additive ? [...state.selectedNodes] : [];
  if (!additive) clearSelection();
  state.selectionStart = state.stage.getPointerPosition();
  state.selectionBox.visible(false);
}

function clearSelection() {
  setSelection([]);
}

function finishMarqueeSelection() {
  const end = state.stage.getPointerPosition() || state.selectionStart;
  const box = selectionRectangle(state.selectionStart, end);
  if (box.width > 3 || box.height > 3) {
    const matches = state.annotationsGroup
      .getChildren()
      .filter((node) => rectanglesIntersect(box, node.getClientRect()));
    setSelection([...state.selectionInitial, ...matches]);
  }
  state.selectionStart = null;
  state.selectionInitial = [];
  state.selectionBox.visible(false);
  state.transformerLayer.batchDraw();
}

function findSelectableNode(node) {
  if (!node) return null;
  if (node === state.annotationsGroup) return null;
  if (node.name && node.name() === 'annotation-item') {
    return node;
  }
  return findSelectableNode(node.getParent && node.getParent());
}

function beginShape(pointer) {
  if (!pointer || !state.konva || !state.annotationsGroup) return null;
  const color = elements.strokeColor?.value || '#ff4f5e';
  const width = Number(elements.strokeWidth?.value) || 3;
  const highlightColor = elements.highlightColor?.value || '#ffee79';
  const highlightOpacity = Number(elements.highlightOpacity?.value) || 0.35;
  switch (state.tool) {
    case 'rectangle':
    case 'highlight': {
      const rect = new state.konva.Rect({
        x: pointer.x,
        y: pointer.y,
        width: 1,
        height: 1,
        stroke: state.tool === 'highlight' ? colorWithOpacity(highlightColor, 0.95) : color,
        strokeWidth: state.tool === 'highlight' ? width * 0.5 : width,
        dash: state.tool === 'highlight' ? [] : [],
        fill:
          state.tool === 'highlight'
            ? colorWithOpacity(highlightColor, highlightOpacity)
            : undefined,
        listening: false,
      });
      ensureAnnotationId(rect);
      attachShapeListeners(rect);
      state.annotationsGroup.add(rect);
      return rect;
    }
    case 'circle': {
      const ellipse = new state.konva.Ellipse({
        x: pointer.x,
        y: pointer.y,
        radiusX: 1,
        radiusY: 1,
        stroke: color,
        strokeWidth: width,
        listening: false,
      });
      ensureAnnotationId(ellipse);
      attachShapeListeners(ellipse);
      state.annotationsGroup.add(ellipse);
      return ellipse;
    }
    case 'line': {
      const line = new state.konva.Line({
        points: [pointer.x, pointer.y, pointer.x, pointer.y],
        stroke: color,
        strokeWidth: width,
        lineCap: 'round',
        lineJoin: 'round',
        hitStrokeWidth: Math.max(width * 2, 10),
        listening: false,
      });
      ensureAnnotationId(line);
      attachShapeListeners(line);
      state.annotationsGroup.add(line);
      return line;
    }
    default:
      return null;
  }
}

function updateShape(pointer) {
  if (!state.drawingShape || !state.drawingStart || !pointer) return;
  if (state.drawingShape.className === 'Rect') {
    const x = Math.min(pointer.x, state.drawingStart.x);
    const y = Math.min(pointer.y, state.drawingStart.y);
    const width = Math.abs(pointer.x - state.drawingStart.x);
    const height = Math.abs(pointer.y - state.drawingStart.y);
    state.drawingShape.position({ x, y });
    state.drawingShape.size({ width, height });
  } else if (state.drawingShape.className === 'Ellipse') {
    state.drawingShape.radiusX(Math.abs(pointer.x - state.drawingStart.x));
    state.drawingShape.radiusY(Math.abs(pointer.y - state.drawingStart.y));
  } else if (state.drawingShape.className === 'Line') {
    const points = state.drawingShape.points();
    points[2] = pointer.x;
    points[3] = pointer.y;
    state.drawingShape.points(points);
  }
  state.workspaceLayer?.batchDraw();
}

function finalizeShape() {
  if (!state.drawingShape) return;
  const shrinkThreshold = 4;
  if (state.drawingShape.className === 'Rect') {
    const { width, height } = state.drawingShape.size();
    if (width < shrinkThreshold || height < shrinkThreshold) {
      state.drawingShape.destroy();
      state.drawingShape = null;
      state.workspaceLayer?.batchDraw();
      return;
    }
  }
  state.drawingShape.listening(true);
  const created = state.drawingShape;
  selectAnnotation(created);
  const snapshot = created ? captureNodeSnapshot(created) : null;
  state.drawingShape = null;
  state.drawingStart = null;
  if (snapshot) {
    state.historyManager.execute(createCreateCommand(snapshot), true);
  }
}

function createCounter(pointer) {
  if (!state.konva || !state.annotationsGroup) return;
  const number = state.nextCounterOverride ?? nextAnnotationNumber(annotationDocument().nodes);
  state.nextCounterOverride = null;
  const size = 18 + Number(elements.strokeWidth?.value || 3) * 2;
  const background = elements.highlightColor?.value || '#007bff';
  const stroke = elements.strokeColor?.value || '#0d0d0d';
  const group = new state.konva.Group({
    x: pointer.x,
    y: pointer.y,
    draggable: true,
    name: 'annotation-item',
  });
  ensureAnnotationId(group);
  const circle = new state.konva.Circle({
    radius: size / 2,
    fill: colorWithOpacity(background, 0.85),
    stroke,
    strokeWidth: 1.5,
    listening: true,
  });
  const text = new state.konva.Text({
    text: String(number),
    fontSize: Math.min(size * 0.55, (size * 1.4) / String(number).length),
    fontStyle: '700',
    fill: '#0f0f0f',
    align: 'center',
    listening: true,
  });
  text.offset({
    x: text.width() / 2,
    y: text.height() / 2,
  });
  group.add(circle);
  group.add(text);
  attachShapeListeners(group);
  state.annotationsGroup.add(group);
  state.workspaceLayer?.batchDraw();
  selectAnnotation(group);
}

function attachShapeListeners(node) {
  node.draggable(true);
  node.name('annotation-item');
  node.listening(true);
  node.on('dragstart', beginSelectionAction);
  node.on('dragend', () => queueMicrotask(finishSelectionAction));
  node.on('mousedown touchstart', (event) => {
    if (state.tool === 'pan' || state.spacePanning || event.evt?.button === 2) return;
    selectAnnotation(node, event.evt);
    event.cancelBubble = true;
  });
}

function beginSelectionAction(event) {
  if (state.actionBefore) return;
  const dragged = findSelectableNode(event?.target);
  if (dragged && !state.selectedNodes.includes(dragged)) setSelection([dragged]);
  state.actionBefore = state.selectedNodes.map(captureNodeSnapshot).filter(Boolean);
}

function finishSelectionAction() {
  const before = state.actionBefore;
  state.actionBefore = null;
  if (!before?.length || !state.annotationsGroup) return;
  const nodes = state.annotationsGroup.getChildren();
  const after = before.map((snapshot) =>
    captureNodeSnapshot(nodes.find((node) => node.getAttr('annotationId') === snapshot.id))
  );
  if (after.some((snapshot) => !snapshot)) return;
  if (before.every((snapshot, index) => isSnapshotEqual(snapshot, after[index]))) return;
  state.historyManager.execute(createTransformCommand(before, after), true);
}

function createHistoryManager() {
  const undoStack = [];
  const redoStack = [];
  return {
    undoStack,
    redoStack,
    execute(command, alreadyApplied = false) {
      if (!alreadyApplied) {
        command.do();
      }
      undoStack.push(command);
      redoStack.length = 0;
      updateHistoryButtons();
    },
    undo() {
      if (!undoStack.length) return;
      state.nextCounterOverride = null;
      const cmd = undoStack.pop();
      cmd.undo();
      redoStack.push(cmd);
      updateHistoryButtons();
    },
    redo() {
      if (!redoStack.length) return;
      state.nextCounterOverride = null;
      const cmd = redoStack.pop();
      cmd.do();
      undoStack.push(cmd);
      updateHistoryButtons();
    },
  };
}

function ensureAnnotationId(node) {
  let id = node.getAttr('annotationId');
  if (!id) {
    state.commandSerial += 1;
    id = `annotation-${state.commandSerial}`;
    node.setAttr('annotationId', id);
  }
  return id;
}

function captureNodeSnapshot(node) {
  if (!node) return null;
  ensureAnnotationId(node);
  const json = node.toJSON();
  const parsed = safeParseKonvaJSON(json);
  if (!parsed) return null;
  return {
    id: node.getAttr('annotationId'),
    json,
    index: node.index,
    norm: normalizeParsedNode(parsed, node.index),
  };
}

function buildNodeFromSnapshot(snapshot) {
  if (!snapshot?.json || !state.konva) return null;
  const node = state.konva.Node.create(snapshot.json);
  ensureAnnotationId(node);
  attachShapeListeners(node);
  return node;
}

function insertNode(node, index = null) {
  if (!node || !state.annotationsGroup) return;
  state.annotationsGroup.add(node);
  if (Number.isInteger(index) && index >= 0) {
    node.zIndex(Math.min(index, state.annotationsGroup.getChildren().length - 1));
  }
  state.workspaceLayer?.batchDraw();
}

function removeNodeById(id) {
  if (!state.annotationsGroup || !id) return null;
  const node = state.annotationsGroup
    .getChildren()
    .find((child) => child.getAttr('annotationId') === id);
  if (!node) return null;
  const snapshot = captureNodeSnapshot(node);
  setSelection(state.selectedNodes.filter((selected) => selected !== node));
  node.destroy();
  state.workspaceLayer?.batchDraw();
  return snapshot;
}

function createCreateCommand(snapshot) {
  return {
    do() {
      const node = buildNodeFromSnapshot(snapshot);
      insertNode(node, snapshot.index);
    },
    undo() {
      removeNodeById(snapshot.id);
    },
  };
}

function createDeleteCommand(snapshots) {
  const ordered = [...snapshots].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return {
    do() {
      ordered.forEach((snap) => {
        removeNodeById(snap.id);
      });
    },
    undo() {
      const restored = [];
      ordered.forEach((snap) => {
        const node = buildNodeFromSnapshot(snap);
        insertNode(node, snap.index);
        restored.push(node);
      });
      setSelection(restored);
    },
  };
}

function createTransformCommand(before, after) {
  const apply = (snapshots) => {
    clearSelection();
    snapshots.forEach(replaceNode);
    const ids = new Set(snapshots.map((snapshot) => snapshot.id));
    setSelection(
      state.annotationsGroup.getChildren().filter((node) => ids.has(node.getAttr('annotationId')))
    );
  };
  return {
    do() {
      apply(after);
    },
    undo() {
      apply(before);
    },
  };
}

function replaceNode(snapshot) {
  if (!snapshot) return;
  const existing = removeNodeById(snapshot.id);
  const node = buildNodeFromSnapshot(snapshot);
  const index = snapshot.index ?? existing?.index;
  insertNode(node, index);
}

function safeParseKonvaJSON(json) {
  try {
    return JSON.parse(json);
  } catch (error) {
    warnDiagnostic('AnnotationStateParseFailure', error);
    return null;
  }
}

function normalizeParsedNode(obj, order = 0) {
  if (!obj || typeof obj !== 'object') return null;
  const attrs = obj.attrs || {};
  const base = {
    type: obj.className || attrs.name || '',
    x: attrs.x || 0,
    y: attrs.y || 0,
    rotation: attrs.rotation || 0,
    scaleX: attrs.scaleX || 1,
    scaleY: attrs.scaleY || 1,
    stroke: attrs.stroke || '',
    strokeWidth: attrs.strokeWidth || 0,
    fill: attrs.fill || '',
    opacity: attrs.opacity ?? 1,
    order,
    id: attrs.annotationId || '',
  };
  if (obj.className === 'Rect') {
    base.width = attrs.width || 0;
    base.height = attrs.height || 0;
  } else if (obj.className === 'Ellipse') {
    base.radiusX = attrs.radiusX || 0;
    base.radiusY = attrs.radiusY || 0;
  } else if (obj.className === 'Line') {
    base.points = Array.isArray(attrs.points) ? [...attrs.points] : [];
  } else if (obj.className === 'Group') {
    const children = Array.isArray(obj.children) ? obj.children : [];
    base.children = children.map((child, idx) => normalizeParsedNode(child, idx));
  } else if (obj.className === 'Text') {
    base.text = attrs.text || '';
    base.fontSize = attrs.fontSize || 0;
    base.fontStyle = attrs.fontStyle || '';
    base.fill = attrs.fill || base.fill;
  }
  return base;
}

function isSnapshotEqual(a, b) {
  if (!a || !b) return false;
  const normA = a.norm || normalizeParsedNode(safeParseKonvaJSON(a.json), a.index);
  const normB = b.norm || normalizeParsedNode(safeParseKonvaJSON(b.json), b.index);
  return JSON.stringify(normA) === JSON.stringify(normB);
}

function initializeHistory() {
  state.history = [];
  state.future = [];
  state.historyManager = createHistoryManager();
  updateHistoryButtons();
}

function undo() {
  state.historyManager?.undo();
}

function redo() {
  state.historyManager?.redo();
}

function updateHistoryButtons() {
  updateCounterControls();
  const undoSize = state.historyManager?.undoStack.length || 0;
  const redoSize = state.historyManager?.redoStack.length || 0;
  if (undoSize <= 0) {
    elements.actionUndo?.setAttribute('disabled', 'true');
  } else {
    elements.actionUndo?.removeAttribute('disabled');
  }
  if (redoSize <= 0) {
    elements.actionRedo?.setAttribute('disabled', 'true');
  } else {
    elements.actionRedo?.removeAttribute('disabled');
  }
  if (panels && !panels.busy && !state.navigationBusy && state.annotationsGroup)
    panels.status(state.filePath, hasUnsavedChanges());
}

function removeSelection() {
  const snapshots = state.selectedNodes.map(captureNodeSnapshot).filter(Boolean);
  if (!snapshots.length) return;
  state.nextCounterOverride = null;
  clearSelection();
  state.historyManager.execute(createDeleteCommand(snapshots));
}

function resetView(silent = false) {
  if (!state.contentGroup || !state.stage) return;
  fitContentToStage(true);
  updateStatusMessage(silent ? '' : 'View reset');
}

function applyZoom(targetZoom, evt) {
  if (!state.contentGroup || !state.workspaceLayer || !state.stage) return;
  const clamped = clamp(targetZoom, state.minZoom, state.maxZoom);
  const pointer = evt?.evt
    ? { x: evt.evt.offsetX, y: evt.evt.offsetY }
    : evt?.target?.getStage
      ? evt.target.getStage().getPointerPosition()
      : null;
  const focus = pointer || {
    x: state.stage.width() / 2,
    y: state.stage.height() / 2,
  };
  const before = getContentPointFromStagePoint(focus);
  state.zoom = clamped;
  const newScale = state.baseScale * state.zoom;
  state.contentGroup.scale({ x: newScale, y: newScale });
  const afterStagePoint = state.contentGroup.getAbsoluteTransform().point(before);
  const shift = {
    x: focus.x - afterStagePoint.x,
    y: focus.y - afterStagePoint.y,
  };
  state.contentGroup.position({
    x: state.contentGroup.x() + shift.x,
    y: state.contentGroup.y() + shift.y,
  });
  state.workspaceLayer.batchDraw();
  if (elements.zoomSlider) {
    elements.zoomSlider.value = clamped.toFixed(2);
  }
  updateStatusMessage();
}

function fitContentToStage(resetPosition) {
  if (!state.stage || !state.contentGroup || !state.imageSize.width || !state.imageSize.height)
    return;
  const { width, height } = state.imageSize;
  const fitWidth = state.stage.width() / width;
  const fitHeight = state.stage.height() / height;
  state.baseScale = Math.min(fitWidth, fitHeight);
  state.baseScale = Math.max(state.baseScale, 0.01);
  if (resetPosition) {
    state.contentGroup.position({
      x: (state.stage.width() - width * state.baseScale) / 2,
      y: (state.stage.height() - height * state.baseScale) / 2,
    });
    state.zoom = 1;
    if (elements.zoomSlider) {
      elements.zoomSlider.value = '1';
    }
  }
  state.contentGroup.scale({ x: state.baseScale * state.zoom, y: state.baseScale * state.zoom });
  state.workspaceLayer?.batchDraw();
}

function getContentPointerPosition(evt) {
  if (!state.stage || !state.contentGroup) return null;
  const pointer = evt?.target?.getStage
    ? state.stage.getPointerPosition()
    : state.stage.getPointerPosition();
  if (!pointer) return null;
  const transform = state.contentGroup.getAbsoluteTransform().copy();
  transform.invert();
  return transform.point(pointer);
}

function getContentPointFromStagePoint(stagePoint) {
  if (!state.contentGroup) return { x: 0, y: 0 };
  const transform = state.contentGroup.getAbsoluteTransform().copy();
  transform.invert();
  return transform.point(stagePoint);
}

function attachKeyboard() {
  if (state.keyHandler) return;
  state.keyHandler = (event) => {
    if (!elements.modal.classList.contains('show')) return;
    if (state.saving || state.navigationBusy || panels?.busy) return;
    // Nested dialogs and typing fields own their normal browser shortcuts.
    if (
      event.target.closest?.('.modal') !== elements.modal ||
      isAnnotationTypingTarget(event.target)
    )
      return;
    if (event.type === 'keyup') {
      if (event.key === ' ' && state.spacePanning) {
        state.spacePanning = false;
        updateToolButtons(state.tool);
      }
      return;
    }
    const isCtrl = event.ctrlKey || event.metaKey;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      removeSelection();
      event.preventDefault();
    } else if (isCtrl && event.key.toLowerCase() === 'a' && state.tool === 'select') {
      setSelection(state.annotationsGroup?.getChildren() || []);
      event.preventDefault();
    } else if (isCtrl && event.key.toLowerCase() === 'z') {
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
      event.preventDefault();
    } else if (isCtrl && event.key.toLowerCase() === 'y') {
      redo();
      event.preventDefault();
    } else if (isCtrl && event.key.toLowerCase() === 's') {
      if (event.shiftKey) {
        event.preventDefault();
        openSaveDialog('copy');
      } else {
        event.preventDefault();
        void handleSave('overwrite', '', Boolean(panels));
      }
    } else if (!event.ctrlKey && !event.metaKey && event.type === 'keydown') {
      const key = event.key.toLowerCase();
      if (key === 'j') {
        updateToolButtons('counter');
        elements.counterNext?.focus();
        elements.counterNext?.select();
        event.preventDefault();
        return;
      }
      const toolMap = {
        v: 'select',
        h: 'highlight',
        i: 'counter',
        l: 'line',
        c: 'circle',
        r: 'rectangle',
      };
      if (toolMap[key]) {
        updateToolButtons(toolMap[key]);
        focusToolButton(toolMap[key]);
        event.preventDefault();
        return;
      }
    }
    if (event.key === ' ' && event.type === 'keydown') {
      if (!state.spacePanning) {
        state.spacePanning = true;
        if (state.stage) {
          state.stage.container().style.cursor = 'grab';
        }
      }
      event.preventDefault();
    }
  };
  document.addEventListener('keydown', state.keyHandler);
  document.addEventListener('keyup', state.keyHandler);
}

function detachKeyboard() {
  if (!state.keyHandler) return;
  document.removeEventListener('keydown', state.keyHandler);
  document.removeEventListener('keyup', state.keyHandler);
  state.keyHandler = null;
}

function updateToolButtons(tool) {
  if (!tool) return;
  if (COLOR_TOOLS.includes(state.tool)) {
    state.toolColors = syncToolPalette(state.tool, elements, state.toolColors, DEFAULT_TOOL_COLORS);
  }
  state.tool = tool;
  updateCounterControls();
  applyToolPalette(tool, elements, state.toolColors, DEFAULT_TOOL_COLORS);
  elements.toolButtons.forEach((button) => {
    const active = button.dataset.annotateTool === tool;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  if (state.stage) {
    let cursor = 'crosshair';
    if (state.spacePanning) {
      cursor = 'grab';
    } else if (tool === 'select') {
      cursor = 'default';
    } else if (tool === 'pan') {
      cursor = 'grab';
    }
    state.stage.container().style.cursor = cursor;
  }
  if (tool !== 'select') {
    clearSelection();
  }
  updateStatusMessage();
}

function setSelection(nodes) {
  state.selectedNodes = [...new Set(nodes)].filter(
    (node) => node?.getParent() === state.annotationsGroup
  );
  state.transformer?.nodes(state.selectedNodes);
  state.transformerLayer?.batchDraw();
  if (elements.actionDelete) elements.actionDelete.disabled = !state.selectedNodes.length;
}

function selectAnnotation(node, event) {
  if (!node || !state.transformer) return;
  const additive = state.tool === 'select' && (event?.shiftKey || event?.ctrlKey || event?.metaKey);
  if (additive) {
    setSelection(
      state.selectedNodes.includes(node)
        ? state.selectedNodes.filter((selected) => selected !== node)
        : [...state.selectedNodes, node]
    );
  } else if (!state.selectedNodes.includes(node)) {
    setSelection([node]);
  }
}

function updateCounterControls() {
  elements.counterControls?.classList.toggle('d-none', state.tool !== 'counter');
  if (!elements.counterNext || document.activeElement === elements.counterNext) return;
  const nodes = state.annotationsGroup?.getChildren().map((node) => node.toObject()) || [];
  elements.counterNext.value = String(state.nextCounterOverride ?? nextAnnotationNumber(nodes));
}

function focusToolButton(tool) {
  if (!tool || !Array.isArray(elements.toolButtons)) return;
  const button = elements.toolButtons.find((btn) => btn.dataset.annotateTool === tool);
  if (button) {
    button.focus();
  }
}

function annotationDocument() {
  return {
    version: 1,
    width: state.imageSize.width,
    height: state.imageSize.height,
    nodes: state.annotationsGroup.getChildren().map((node) => node.toObject()),
  };
}

function installDocument(document) {
  clearSelection();
  state.nextCounterOverride = null;
  state.annotationsGroup.destroyChildren();
  for (const saved of document.nodes) {
    const node = state.konva.Node.create(saved);
    const serial = Number(
      String(node.getAttr('annotationId') || '')
        .split('-')
        .pop()
    );
    if (Number.isFinite(serial)) state.commandSerial = Math.max(state.commandSerial, serial);
    attachShapeListeners(node);
    state.annotationsGroup.add(node);
  }
  updateCounterControls();
  state.workspaceLayer?.batchDraw();
}

async function exportComposite(overlayOnly = false) {
  if (!state.konva || !state.image || !state.annotationsGroup) {
    throw new Error('Annotation workspace is not ready.');
  }
  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-9999px';
  container.style.top = '0';
  container.style.width = `${state.imageSize.width}px`;
  container.style.height = `${state.imageSize.height}px`;
  document.body.appendChild(container);
  const stage = new state.konva.Stage({
    container,
    width: state.imageSize.width,
    height: state.imageSize.height,
  });
  const layer = new state.konva.Layer();
  const bg = new state.konva.Image({ image: state.image });
  if (!overlayOnly) layer.add(bg);
  state.annotationsGroup.getChildren().forEach((child) => {
    const clone = child.clone({ draggable: false, listening: false });
    layer.add(clone);
  });
  stage.add(layer);
  layer.draw();
  const mime = overlayOnly ? 'image/png' : state.mime || 'image/png';
  const quality = mime === 'image/jpeg' ? 0.92 : undefined;
  const dataUrl = stage.toDataURL({ mimeType: mime, quality });
  stage.destroy();
  container.remove();
  return dataUrl;
}
