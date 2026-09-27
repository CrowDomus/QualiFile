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
  COLOR_TOOLS,
  buildDefaultToolColors,
  loadStoredToolColors,
  syncToolPalette,
  applyToolPalette,
  mimeToExtension,
  colorWithOpacity,
  clamp,
} from './annotator_helpers.js';

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
  counter: 0,
  history: [],
  future: [],
  commandSerial: 0,
  historyManager: null,
  isRestoring: false,
  selectedNode: null,
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
  toolColors: loadStoredToolColors(DEFAULT_TOOL_COLORS),
};

export async function openAnnotationModal(options = {}) {
  if (!elements.modal || !elements.stageHost || !elements.stageWrapper) {
    errorDiagnostic('AnnotationModalMarkupMissing');
    return;
  }
  try {
    await ensureKonvaLoaded();
    const saved = await loadAnnotationDocument(options.path);
    prepareModal({ ...options, url: annotationBaseUrl(options.path), saved });
  } catch (error) {
    handleError(error);
  }
}

function prepareModal(options) {
  resetState();
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
  image.onload = () => {
    state.image = image;
    state.imageSize = {
      width: image.naturalWidth || image.width || 1,
      height: image.naturalHeight || image.height || 1,
    };
    initializeStage();
    installDocument(options.saved.document);
    state.savedDocumentSnapshot = JSON.stringify(annotationDocument());
    setOverlay(false);
  };
  image.onerror = () => {
    setOverlay(true, 'Unable to load this image for annotation.');
  };
  image.src = options.url;
  bindModalEvents();
  showModal();
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
  teardownStage();
  state.zoom = 1;
  state.baseScale = 1;
  state.counter = 0;
  state.history = [];
  state.future = [];
  state.commandSerial = 0;
  state.historyManager = createHistoryManager();
  state.isRestoring = false;
  state.selectedNode = null;
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
    teardownStage();
    detachKeyboard();
  });

  document.getElementById('annotate-apply-reference')?.addEventListener('click', async () => {
    try {
      const reference = await chooseAnnotationReference();
      if (!reference) return;
      if (
        reference.document.width !== state.imageSize.width ||
        reference.document.height !== state.imageSize.height
      ) {
        throw new Error('Exact annotation duplication requires matching image dimensions.');
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
          ? 'Reference annotations added above existing annotations. Review and save the image.'
          : 'Reference annotations applied. Review and save the image.'
      );
    } catch (error) {
      handleError(error);
    }
  });
  elements.saveDialogCopy?.addEventListener('change', updateSaveMode);
  elements.saveDialogOverwrite?.addEventListener('change', updateSaveMode);

  elements.actionSave?.addEventListener('click', () => openSaveDialog());
  elements.actionPrevious?.addEventListener('click', () => void navigateImage(-1));
  elements.actionNext?.addEventListener('click', () => void navigateImage(1));

  elements.saveDialogConfirm?.addEventListener('click', () => {
    const mode = elements.saveDialogCopy?.checked ? 'copy' : 'overwrite';
    const provided = elements.saveDialogName?.value.trim() || '';
    state.saveModalInstance?.hide();
    void handleSave(mode, provided);
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

async function handleSave(mode = 'overwrite', providedName = '', keepOpen = false) {
  if (state.saving || !state.stage || !state.annotationsGroup) return false;
  const effectiveMode = mode === 'copy' ? 'copy' : 'overwrite';
  let filename = '';
  if (effectiveMode === 'copy') {
    filename = providedName || state.copyNameSuggestion;
  }
  try {
    state.saving = true;
    if (elements.actionSave) {
      elements.actionSave.disabled = true;
      elements.actionSave.setAttribute('aria-busy', 'true');
    }
    setStatus('Saving annotations...');
    const dataUrl = await exportComposite();
    const result = await saveAnnotation({
      path: state.filePath,
      mode: effectiveMode,
      filename,
      dataUrl,
      document: annotationDocument(),
      overlay: await exportComposite(true),
      expectedHash: state.expectedHash,
    });
    const overwritten = (result?.mode || effectiveMode) === 'overwrite';
    showToast(
      effectiveMode === 'copy' ? 'Annotated copy saved.' : 'Image updated with annotations.'
    );
    requestGlobalRefresh({ refreshList: true, refreshTree: false });
    if (overwritten) {
      document.dispatchEvent(
        new CustomEvent('qualifile:preview-refresh', {
          detail: { path: state.filePath },
        })
      );
    }
    setStatus('Saved/Idle');
    if (keepOpen) state.savedDocumentSnapshot = JSON.stringify(annotationDocument());
    else state.modalInstance?.hide();
    return true;
  } catch (error) {
    handleError(error);
    return false;
  } finally {
    state.saving = false;
    if (elements.actionSave) {
      elements.actionSave.disabled = false;
      elements.actionSave.removeAttribute('aria-busy');
    }
  }
}

function chooseNavigationAction() {
  if (!elements.navigateDialog) return Promise.resolve('cancel');
  const instance = window.bootstrap.Modal.getOrCreateInstance(elements.navigateDialog);
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
  if (state.navigationBusy || state.saving || !state.stage) return;
  state.navigationBusy = true;
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
      if (action === 'save' && !(await handleSave('overwrite', '', true))) return;
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
    void handleSave('overwrite', '');
    return;
  }
  const bootstrapModal = window.bootstrap?.Modal;
  if (!bootstrapModal) {
    void handleSave('overwrite', '');
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
    width: Math.max(rect.width, 300),
    height: Math.max(rect.height, 300),
  });
  state.workspaceLayer = new konva.Layer();
  state.transformerLayer = new konva.Layer();
  state.contentGroup = new konva.Group({ listening: true });
  state.annotationsGroup = new konva.Group({ name: 'annotations', listening: true });
  state.imageNode = new konva.Image({ image: state.image, listening: false });
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
  state.stage.add(state.transformerLayer);
  state.transformer.on('transformstart', () => {
    const node = state.transformer.nodes()?.[0];
    if (!node) return;
    node._beforeAction = captureNodeSnapshot(node);
  });
  state.transformer.on('transformend', () => {
    const node = state.transformer.nodes()?.[0];
    if (!node) return;
    const before = node._beforeAction;
    node._beforeAction = null;
    const after = captureNodeSnapshot(node);
    if (!before || !after) return;
    if (isSnapshotEqual(before, after)) return;
    const cmd = createTransformCommand(before, after);
    state.historyManager.execute(cmd, true);
  });
  if (elements.stageWrapper && !elements.stageWrapper.dataset.annotateContextBound) {
    elements.stageWrapper.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });
    elements.stageWrapper.dataset.annotateContextBound = 'true';
  }
  const applyInitialView = () => {
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
  state.imageNode = null;
  state.image = null;
}

function observeStageResize() {
  if (!window.ResizeObserver || !elements.stageWrapper) return;
  state.resizeObserver = new ResizeObserver(() => {
    if (!state.stage) return;
    const rect = elements.stageWrapper.getBoundingClientRect();
    state.stage.size({ width: Math.max(rect.width, 300), height: Math.max(rect.height, 300) });
    fitContentToStage(false);
  });
  state.resizeObserver.observe(elements.stageWrapper);
}

function attachStageEvents() {
  if (!state.stage) return;
  state.stage.on('mousedown touchstart', (evt) => {
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
      selectAnnotation(existingNode);
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
    evt.evt.preventDefault();
    const direction = evt.evt.deltaY > 0 ? -0.15 : 0.15;
    applyZoom(state.zoom + direction, evt);
  });
}

function handleSelection(evt) {
  const target = evt.target;
  if (
    !target ||
    target === state.imageNode ||
    target === state.stage ||
    target === state.contentGroup
  ) {
    clearSelection();
    return;
  }
  const candidate = findSelectableNode(target);
  if (!candidate) {
    clearSelection();
    return;
  }
  selectAnnotation(candidate);
}

function clearSelection() {
  state.selectedNode = null;
  state.transformer?.nodes([]);
  state.transformerLayer?.batchDraw();
  elements.actionDelete?.setAttribute('disabled', 'true');
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
  state.counter += 1;
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
    text: String(state.counter),
    fontSize: size * 0.55,
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
  node.on('dragstart', () => {
    node._beforeAction = captureNodeSnapshot(node);
  });
  node.on('dragend', () => {
    const before = node._beforeAction;
    node._beforeAction = null;
    const after = captureNodeSnapshot(node);
    if (!before || !after) return;
    if (isSnapshotEqual(before, after)) return;
    const cmd = createTransformCommand(before, after);
    state.historyManager.execute(cmd, true);
  });
  node.on('mousedown touchstart', (event) => {
    selectAnnotation(node);
    event.cancelBubble = true;
  });
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
      const cmd = undoStack.pop();
      cmd.undo();
      redoStack.push(cmd);
      updateHistoryButtons();
    },
    redo() {
      if (!redoStack.length) return;
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
  if (
    index === null ||
    index === undefined ||
    index < 0 ||
    index > state.annotationsGroup.getChildren().length
  ) {
    state.annotationsGroup.add(node);
  } else {
    node.remove();
    state.annotationsGroup.insert(node, index);
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
      ordered.forEach((snap) => {
        const node = buildNodeFromSnapshot(snap);
        insertNode(node, snap.index);
      });
    },
  };
}

function createTransformCommand(before, after) {
  return {
    do() {
      replaceNode(after);
    },
    undo() {
      replaceNode(before);
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
}

function removeSelection() {
  if (!state.selectedNode) return;
  const target = state.selectedNode;
  const snap = captureNodeSnapshot(target);
  if (!snap) return;
  const cmd = createDeleteCommand([snap]);
  cmd.do();
  state.historyManager.execute(cmd, true);
  state.selectedNode = null;
  state.transformer?.nodes([]);
  elements.actionDelete?.setAttribute('disabled', 'true');
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
    const isCtrl = event.ctrlKey || event.metaKey;
    if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      !event.target.closest('input, textarea')
    ) {
      removeSelection();
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
        void handleSave('overwrite', '');
      }
    } else if (!event.ctrlKey && !event.metaKey && event.type === 'keydown') {
      const activeElement = document.activeElement;
      if (activeElement && ['INPUT', 'TEXTAREA'].includes(activeElement.tagName)) {
        return;
      }
      const key = event.key.toLowerCase();
      const toolMap = {
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
    } else if (event.key === ' ' && event.type === 'keyup') {
      state.spacePanning = false;
      updateToolButtons(state.tool);
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

function selectAnnotation(node) {
  if (!node || !state.transformer) return;
  state.selectedNode = node;
  state.transformer.nodes([node]);
  state.transformerLayer?.batchDraw();
  elements.actionDelete?.removeAttribute('disabled');
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
    for (const text of node.find ? node.find('Text') : []) {
      const value = Number(text.text());
      if (Number.isFinite(value)) state.counter = Math.max(state.counter, value);
    }
  }
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
