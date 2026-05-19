import { state, selectionArray, persistPreferences, recordNavigation, canNavigateBack, canNavigateForward, stepBackInHistory, stepForwardInHistory, updateCurrentPath, clearSelection, setSelection } from '../shared/state.js';
import { initTheme } from '../shared/theme.js';
import { initToast, showToast, setStatus, updateFolderTitle } from '../shared/ui.js';
import { initTree, refreshTree, highlightTree, syncTreeSelection } from '../features/explorer/tree.js';
import { initList, loadList, getSelection, triggerRename, findItem, syncSelectionState } from '../shared/list.js';
import { initModals, openMergeModal, openConflictDialog, openImportModal, openSettingsModal, openDeleteModal, openPdfExtractModal, openNoteCreateModal } from '../features/modals/modals.js';
import { initHeaderAddNoteWorkspace } from '../features/notes/header_add_note_workspace.js';
import { initNoteFormattingToolbars } from '../features/notes/note_formatting_toolbar.js';
import { handleError, captureScreenshot, moveItems, copyItems, fetchFileUrl, launchGreenshot, assignTagsToPath } from '../shared/api.js';
import { clearPreview, showPreview } from '../features/preview/preview.js';
import { initContextMenu } from '../features/explorer/context_menu.js';
import { isInvalidDestination, normalizePath } from '../shared/paths.js';
import { GLOBAL_REFRESH_EVENT, requestGlobalRefresh } from '../shared/refresh.js';
import { openFolderPicker } from '../features/filesystem/folder_picker.js';
import { initLoadingModal } from '../features/modals/loading_modal.js';
import { initModalStacking } from '../shared/modal_stack.js';
import { initModalBackdropGuard } from '../shared/modal_backdrop_guard.js';
import { initProfilePreferencesBridge } from '../features/user_profile/profile_bridge.js';
import { initProfileHeaderAvatar } from '../features/user_profile/header_avatar.js';
import { initProfileModal } from '../features/user_profile/profile_modal.js';
import { initProfileController } from '../features/user_profile/profile_controller.js';
import { consumeRevealIntent } from '../features/workspace/reveal_intent.js';
import { initWorkspaceRootSwitcher } from '../features/workspace/root_switcher.js';
import { initTaskAlertsHeader } from '../features/task_alerts/header_alert_icon.js';

const MIN_PANE_WIDTH = 220;
const WORKSPACE_DESKTOP_MIN_WIDTH = 992;
const WORKSPACE_LAYOUT_QUERY = `(min-width: ${WORKSPACE_DESKTOP_MIN_WIDTH}px)`;
const WORKSPACE_PANE_SIZES_KEY = 'qualifile.workspace.paneSizes.v1';
const REVEAL_PULSE_CLASS = 'workspace-reveal-pulse';
const REVEAL_PULSE_DURATION_MS = 1400;
const REVEAL_PULSE_RETRY_DELAY_MS = 90;
const REVEAL_PULSE_MAX_ATTEMPTS = 8;
const MERGE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);
const revealPulseTimers = new WeakMap();
let suppressHistoryRecording = false;
let refreshQueue = Promise.resolve();
let captureDetailsModalInstance = null;
let captureDetailsForm = null;
let captureDetailsNameInput = null;
let captureDetailsFolderInput = null;
let captureDetailsTagList = null;
let captureDetailsTagEmpty = null;
let captureDetailsSubmitButton = null;
let captureDetailsResolver = null;
let captureDetailsSaved = false;
let captureDetailsDefaultName = '';
let captureDetailsSelectedPath = '.';
let pendingCaptureBlob = null;
const captureSelectedTags = new Set();

function pathExtension(path) {
    const raw = typeof path === 'string' ? path.trim().toLowerCase() : '';
    if (!raw) return '';
    const match = raw.match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
}

function isPdfPath(path) {
    return pathExtension(path) === 'pdf';
}

function isSupportedMergeImagePath(path) {
    return MERGE_IMAGE_EXTENSIONS.has(pathExtension(path));
}

function isPdfMergeSelection(selection) {
    return selection.length >= 2 && selection.every((path) => isPdfPath(path));
}

function isImageMergeSelection(selection) {
    return selection.length >= 2 && selection.every((path) => isSupportedMergeImagePath(path));
}

function setActionEnabled(selector, enabled) {
    document.querySelectorAll(selector).forEach((button) => {
        button.disabled = !enabled;
        button.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    });
}

function refreshPdfActionState() {
    const selection = getSelection();
    const canMergePdf = isPdfMergeSelection(selection);
    const canMergeImages = isImageMergeSelection(selection);
    const canExtract = selection.length === 1 && isPdfPath(selection[0]);
    setActionEnabled('[data-pdf-action="merge"]', canMergePdf);
    setActionEnabled('[data-toolbar-action="merge"]', canMergePdf);
    setActionEnabled('[data-pdf-action="merge-images"]', canMergeImages);
    setActionEnabled('[data-toolbar-action="merge-images"]', canMergeImages);
    setActionEnabled('[data-pdf-action="extract"]', canExtract);
    setActionEnabled('[data-toolbar-action="pdf-extract"]', canExtract);
}

function isGreenshotIntegrationEnabled() {
    const config = state.settings?.greenshot || {};
    if (typeof config.enabled === 'boolean') {
        return config.enabled;
    }
    return Boolean((config.path || '').trim());
}

function setGreenshotActionVisibility(enabled = isGreenshotIntegrationEnabled()) {
    const expandedButton = document.getElementById('action-greenshot');
    if (expandedButton) {
        expandedButton.classList.toggle('d-none', !enabled);
        expandedButton.setAttribute('aria-hidden', enabled ? 'false' : 'true');
    }
    document.querySelectorAll('[data-toolbar-action="greenshot"]').forEach((button) => {
        const target = button.closest('li') || button;
        target.classList.toggle('d-none', !enabled);
        target.setAttribute('aria-hidden', enabled ? 'false' : 'true');
    });
}

document.addEventListener('qualifile:design-mode', (event) => {
    const mode = event.detail?.mode === 'compact' ? 'compact' : 'expanded';
    state.designMode = mode;
    persistPreferences();
    applyDesignMode(mode);
});

document.addEventListener('qualifile:greenshot-enabled-changed', (event) => {
    const enabled = event.detail?.enabled === true;
    setGreenshotActionVisibility(enabled);
});

document.addEventListener('qualifile:selection-changed', () => {
    refreshPdfActionState();
});

window.addEventListener('DOMContentLoaded', async () => {
    initToast();
    initLoadingModal();
    initModalStacking();
    initModalBackdropGuard();
    await initProfilePreferencesBridge();
    void initProfileHeaderAvatar();
    initProfileModal();
    initProfileController();
    initTaskAlertsHeader();
    initTheme();
    initModals();
    initNoteFormattingToolbars();
    initHeaderAddNoteWorkspace();
    document.addEventListener('qualifile:workspace-add-note', (event) => {
        const detail = event.detail || {};
        const path = typeof detail.path === 'string' ? detail.path : '.';
        const label = typeof detail.label === 'string' ? detail.label : '';
        openNoteCreateModal(path, label);
    });
    initList(handleFolderChange);
    await initTree(handleFolderChange, state.currentPath);
    await loadList(false);
    updateFolderTitle(state.currentPath);
    consumeRevealIntent({
        navigateToPath,
        selectItem: selectRevealItem,
        highlightItem: (path) => syncTreeSelection(path, { scrollIntoView: true }),
        openPreviewIfRequested: (item) => {
            if (!item || item.is_dir) return;
            void showPreview(item);
        },
        highlightSelection: (item) => pulseRevealSelection(item),
    });
    bindActions();
    bindKeyboardShortcuts();
    bindDragAndDrop();
    setupResizeHandles();
    initLayoutControls();
    initToolbarMode();
    setGreenshotActionVisibility();
    initWorkspaceRootSwitcher();
    initCaptureModal();
    initCaptureDetailsModal();
    initContextMenu(handleFolderChange);
    bindNavigationButtons();
    updateNavigationButtons();
    refreshPdfActionState();
    document.addEventListener('qualifile:reset-layout', handleLayoutReset);
});

document.addEventListener(GLOBAL_REFRESH_EVENT, (event) => {
    const detail = event.detail || {};
    refreshQueue = refreshQueue
        .then(() => performGlobalRefresh(detail))
        .catch((error) => {
            handleError(error);
        });
});

async function performGlobalRefresh(detail = {}) {
    const { refreshList = true, refreshTree: refreshTreeFlag = true } = detail;
    if (refreshList) {
        await loadList(state.includeSubfolders);
    }
    if (refreshTreeFlag) {
        await refreshTree(state.currentPath);
    } else if (!refreshList) {
        highlightTree(state.currentPath);
    }
    updateNavigationButtons();
    refreshPdfActionState();
}

/** Update list pane when the current folder changes. */
async function handleFolderChange(path, includeSubfolders, options = {}) {
    const targetPath = path || state.currentPath;
    if (!suppressHistoryRecording) {
        recordNavigation(targetPath);
    } else {
        suppressHistoryRecording = false;
    }
    await loadList(includeSubfolders);
    updateFolderTitle(targetPath);
    if (options?.source === 'tree') {
        highlightTree(targetPath);
    } else {
        await syncTreeSelection(targetPath);
    }
    updateNavigationButtons();
}

/** Wire up toolbar and context actions. */
function bindActions() {
    document.getElementById('action-rename')?.addEventListener('click', () => triggerRename());
    document.getElementById('action-capture')?.addEventListener('click', () => openCaptureOptions());
    document.getElementById('action-greenshot')?.addEventListener('click', () => triggerGreenshot());
    document.getElementById('action-import')?.addEventListener('click', () => openImportModal());
    document.getElementById('action-delete')?.addEventListener('click', () => confirmDelete());
    document.querySelectorAll('[data-pdf-action="merge"]').forEach((button) => {
        button.addEventListener('click', () => mergeSelected());
    });
    document.querySelectorAll('[data-pdf-action="merge-images"]').forEach((button) => {
        button.addEventListener('click', () => mergeImagesSelected());
    });
    document.querySelectorAll('[data-pdf-action="extract"]').forEach((button) => {
        button.addEventListener('click', () => extractPagesFromSelection());
    });

    document.getElementById('file-table')?.addEventListener('click', () => {
        if (!selectionArray().length) {
            clearPreview();
        }
    });
    refreshPdfActionState();
}

function bindKeyboardShortcuts() {
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Delete') {
            return;
        }
        if (document.querySelector('.modal.show')) {
            return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }
        if (isEditableTarget(event.target)) {
            return;
        }
        if (!selectionArray().length) {
            return;
        }
        event.preventDefault();
        confirmDelete();
    });
}

function isEditableTarget(target) {
    if (!(target instanceof Element)) {
        return false;
    }
    return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function bindNavigationButtons() {
    document.getElementById('action-refresh-all')?.addEventListener('click', () => {
        requestGlobalRefresh({ refreshList: true, refreshTree: true });
    });
    document.getElementById('action-go-up')?.addEventListener('click', () => {
        const parent = getParentPath(state.currentPath);
        if (parent === null) return;
        navigateToPath(parent);
    });
    document.getElementById('action-go-back')?.addEventListener('click', () => {
        const target = stepBackInHistory();
        if (!target) return;
        suppressHistoryRecording = true;
        navigateToPath(target);
    });
    document.getElementById('action-go-forward')?.addEventListener('click', () => {
        const target = stepForwardInHistory();
        if (!target) return;
        suppressHistoryRecording = true;
        navigateToPath(target);
    });
}

function updateNavigationButtons() {
    const backButton = document.getElementById('action-go-back');
    if (backButton) {
        const enabled = canNavigateBack();
        backButton.disabled = !enabled;
        backButton.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    }
    const forwardButton = document.getElementById('action-go-forward');
    if (forwardButton) {
        const enabled = canNavigateForward();
        forwardButton.disabled = !enabled;
        forwardButton.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    }
    const upButton = document.getElementById('action-go-up');
    if (upButton) {
        const hasParent = getParentPath(state.currentPath) !== null;
        upButton.disabled = !hasParent;
        upButton.setAttribute('aria-disabled', hasParent ? 'false' : 'true');
    }
}

function navigateToPath(path) {
    updateCurrentPath(path, false);
    clearSelection();
    void handleFolderChange(path, false, { source: 'nav' });
}

function selectRevealItem(path) {
    if (!path) return null;
    const normalized = normalizePath(path) || '.';
    const current = normalizePath(state.currentPath) || '.';
    if (normalized === current) {
        return { path: state.currentPath || '.', is_dir: true };
    }
    const item = findItem(normalized);
    if (!item) return null;
    setSelection([item.path]);
    syncSelectionState();
    return item;
}

function pulseRevealSelection(item, attempt = 0) {
    const targetPath = typeof item === 'string' ? item : item?.path;
    if (!targetPath) return;
    const normalized = normalizePath(targetPath) || '.';
    const escapeSelector =
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape
            : (value) => String(value).replace(/"/g, '\\"');
    const escaped = escapeSelector(normalized);
    const element = state.viewMode === 'grid'
        ? document.querySelector(`.file-card[data-path="${escaped}"]`)
        : document.querySelector(`#file-table tbody tr[data-path="${escaped}"]`);
    if (!element) {
        if (attempt >= REVEAL_PULSE_MAX_ATTEMPTS) return;
        window.setTimeout(
            () => pulseRevealSelection(normalized, attempt + 1),
            REVEAL_PULSE_RETRY_DELAY_MS,
        );
        return;
    }
    const existingTimer = revealPulseTimers.get(element);
    if (existingTimer) {
        window.clearTimeout(existingTimer);
        revealPulseTimers.delete(element);
    }
    element.classList.remove(REVEAL_PULSE_CLASS);
    void element.offsetWidth;
    element.classList.add(REVEAL_PULSE_CLASS);
    const timer = window.setTimeout(() => {
        element.classList.remove(REVEAL_PULSE_CLASS);
        revealPulseTimers.delete(element);
    }, REVEAL_PULSE_DURATION_MS);
    revealPulseTimers.set(element, timer);
}

function getParentPath(path) {
    if (!path || path === '.') {
        return null;
    }
    const parts = path.split('/');
    parts.pop();
    if (!parts.length) {
        return '.';
    }
    return parts.join('/');
}

/** Open the merge dialog when multiple files are selected. */
async function mergeSelected() {
    const selection = getSelection();
    if (!isPdfMergeSelection(selection)) {
        showToast('Select at least two PDF files to use Merge PDFs.', true);
        return;
    }
    openMergeModal(selection, { preferredMode: 'pdf' });
}

/** Open the merge dialog preconfigured for image-only PDF merging. */
async function mergeImagesSelected() {
    const selection = getSelection();
    if (!isImageMergeSelection(selection)) {
        showToast('Select at least two PNG/JPG image files to merge into a PDF.', true);
        return;
    }
    openMergeModal(selection, { preferredMode: 'images' });
}

/** Open the extract pages dialog when a single PDF is selected. */
function extractPagesFromSelection() {
    const selection = getSelection();
    if (selection.length !== 1) {
        showToast('Select a single PDF to extract pages.', true);
        return;
    }
    const [path] = selection;
    if (!isPdfPath(path)) {
        showToast('Extraction only works for PDF files.', true);
        return;
    }
    openPdfExtractModal(path);
}

/** Open the delete confirmation modal for selected items. */
function confirmDelete() {
    const selection = getSelection();
    if (!selection.length) {
        showToast('Select at least one item to delete.', true);
        return;
    }
    openDeleteModal(selection);
}

/** Launch Greenshot using the configured settings. */
async function triggerGreenshot() {
    const config = state.settings.greenshot || {};
    if (!isGreenshotIntegrationEnabled()) {
        showToast('Enable Greenshot integration in Settings to use this.', true);
        return;
    }
    if (!config.path) {
        showToast('Set the Greenshot executable in Settings before launching.', true);
        return;
    }
    try {
        setStatus('Launching Greenshot…');
        const result = await launchGreenshot({
            executable: config.path,
            hotkey: config.hotkey,
            delay: config.delay,
        });
        if (result?.hotkey_sent) {
            showToast('Greenshot capture triggered');
        } else if (result?.already_running) {
            showToast('Greenshot is already running. Configure a hotkey to trigger captures automatically.');
        } else {
            showToast('Greenshot launched');
        }
    } catch (error) {
        handleError(error);
    } finally {
        setStatus('Saved/Idle');
    }
}

/** Register drag-and-drop handlers for moves and copies. */
function bindDragAndDrop() {
    const listPane = document.getElementById('list-pane');
    const indicator = document.getElementById('list-drop-indicator');
    if (listPane && indicator) {
        listPane.addEventListener('dragover', (event) => {
            event.preventDefault();
            indicator.classList.add('active');
            event.dataTransfer.dropEffect = 'move';
        });
        listPane.addEventListener('dragleave', (event) => {
            if (!listPane.contains(event.relatedTarget)) {
                indicator.classList.remove('active');
            }
        });
        listPane.addEventListener('drop', async (event) => {
            event.preventDefault();
            indicator.classList.remove('active');
            const payload = parseDragData(event.dataTransfer);
            if (!payload?.items?.length) return;
            await executeDrop(payload.items, state.currentPath);
        });
        document.addEventListener('qualifile:drag-end', () => {
            indicator.classList.remove('active');
        });
    }

    document.addEventListener('qualifile:tree-drop', async (event) => {
        const { items, destination } = event.detail;
        await executeDrop(items, destination);
    });

    document.addEventListener('qualifile:folder-drop', async (event) => {
        const { items, destination } = event.detail;
        await executeDrop(items, destination);
    });
}

/** Restore and wire up the layout visibility toggles. */
function initLayoutControls() {
    const toggles = document.querySelectorAll('.layout-toggle');
    toggles.forEach((toggle) => {
        const pane = toggle.dataset.pane;
        if (!pane) return;
        toggle.checked = state.layout[pane] ?? true;
        toggle.addEventListener('change', () => {
            state.layout[pane] = toggle.checked;
            persistPreferences();
            applyLayout();
        });
    });
    applyLayout();
}

/** Apply saved layout preferences to the panes. */
function applyLayout() {
    const panes = {
        tree: document.getElementById('tree-pane'),
        list: document.getElementById('list-pane'),
        preview: document.getElementById('preview-pane'),
    };
    const visible = [];
    Object.entries(panes).forEach(([key, element]) => {
        if (!element) return;
        const isVisible = state.layout[key] !== false;
        element.style.display = isVisible ? '' : 'none';
        if (isVisible) {
            visible.push(key);
        }
    });
    if (visible.length === 3) {
        resetLayoutStyles();
        restoreWorkspacePaneSizes();
        return;
    }
    if (visible.length === 0) {
        Object.values(panes).forEach((element) => {
            if (element) element.style.display = 'none';
        });
        return;
    }
    if (visible.length === 1) {
        const [only] = visible;
        const pane = panes[only];
        if (pane) {
            resetLayoutStyles();
            pane.style.flex = '1 1 auto';
            pane.style.maxWidth = '100%';
            pane.style.width = '100%';
            pane.style.display = '';
        }
        return;
    }
    resetLayoutStyles();
    const key = visible.sort().join('-');
    const presets = {
        'list-preview': { list: '0 0 55%', preview: '0 0 45%' },
        'list-tree': { tree: '0 0 30%', list: '0 0 70%' },
        'preview-tree': { tree: '0 0 30%', preview: '0 0 70%' }
    };
    const preset = presets[key] || {};
    visible.forEach((paneKey) => {
        const pane = panes[paneKey];
        if (!pane) return;
        const sizing = preset[paneKey] || '0 0 50%';
        pane.style.flex = sizing;
        pane.style.maxWidth = sizing.split(' ')[2] || '50%';
        pane.style.width = pane.style.maxWidth;
    });
    restoreWorkspacePaneSizes();
}

/** Initialise the toolbar according to the preferred design mode. */
function initToolbarMode() {
    applyDesignMode();
    initCompactToolbar();
}

/** Set up event delegation for compact toolbar actions. */
function initCompactToolbar() {
    const compact = document.getElementById('toolbar-compact');
    if (!compact) return;
    compact.addEventListener('click', (event) => {
        const trigger = event.target.closest('[data-toolbar-action]');
        if (!trigger) return;
        const action = trigger.dataset.toolbarAction;
        if (!action) return;
        event.preventDefault();
        handleToolbarAction(action);
    });
}

/** Execute a specific toolbar action. */
function handleToolbarAction(action) {
    switch (action) {
        case 'new-folder': {
            const modal = document.getElementById('modal-folder');
            if (modal) bootstrap.Modal.getOrCreateInstance(modal).show();
            break;
        }
        case 'new-file': {
            const modal = document.getElementById('modal-file');
            if (modal) bootstrap.Modal.getOrCreateInstance(modal).show();
            break;
        }
        case 'import':
            openImportModal();
            break;
        case 'merge':
            mergeSelected();
            break;
        case 'merge-images':
            mergeImagesSelected();
            break;
        case 'pdf-extract':
            extractPagesFromSelection();
            break;
        case 'capture':
            openCaptureOptions();
            break;
        case 'greenshot':
            triggerGreenshot();
            break;
        case 'rename':
            triggerRename();
            break;
        case 'delete':
            confirmDelete();
            break;
        case 'settings':
            openSettingsModal();
            break;
        default:
            break;
    }
}

/** Apply the stored design mode to the header toolbar. */
function applyDesignMode(mode = state.designMode) {
    const normalized = mode === 'compact' ? 'compact' : 'expanded';
    state.designMode = normalized;
    const toolbarContainer = document.getElementById('toolbar-container');
    const expanded = document.getElementById('toolbar-expanded');
    const compact = document.getElementById('toolbar-compact');
    const nav = document.querySelector('nav.navbar');
    if (toolbarContainer) {
        toolbarContainer.dataset.designMode = normalized;
        toolbarContainer.classList.toggle('is-compact', normalized === 'compact');
    }
    if (expanded) {
        expanded.classList.toggle('d-none', normalized === 'compact');
    }
    if (compact) {
        compact.classList.toggle('d-none', normalized !== 'compact');
    }
    if (nav) {
        nav.setAttribute('data-design-mode', normalized);
    }
}

/** Initialise the screenshot capture options modal. */
function initCaptureModal() {
    const form = document.getElementById('form-capture');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const modeInput = form.querySelector('input[name="capture-mode"]:checked');
        const mode = modeInput?.value || state.settings.screenshot.mode || 'rectangle';
        state.settings.screenshot.mode = mode;
        persistPreferences();
        const modalEl = form.closest('.modal');
        if (modalEl) {
            bootstrap.Modal.getInstance(modalEl)?.hide();
        }
        await startCapture(mode);
    });
}

function initCaptureDetailsModal() {
    const modalEl = document.getElementById('modal-capture-details');
    captureDetailsForm = document.getElementById('form-capture-details');
    if (!modalEl || !captureDetailsForm) {
        return;
    }
    captureDetailsModalInstance = bootstrap.Modal.getOrCreateInstance(modalEl);
    captureDetailsNameInput = document.getElementById('capture-name');
    captureDetailsFolderInput = document.getElementById('capture-destination');
    captureDetailsTagList = document.getElementById('capture-tag-list');
    captureDetailsTagEmpty = document.getElementById('capture-tag-empty');
    captureDetailsSubmitButton = document.getElementById('capture-details-submit');
    captureDetailsForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!pendingCaptureBlob) {
            captureDetailsModalInstance?.hide();
            return;
        }
        const submitButton = captureDetailsSubmitButton;
        const originalLabel = submitButton?.textContent;
        if (submitButton) {
            submitButton.disabled = true;
            submitButton.textContent = 'Saving…';
        }
        try {
            const nameValue = captureDetailsNameInput?.value?.trim();
            const tags = Array.from(captureSelectedTags);
            await persistCapturedScreenshot(pendingCaptureBlob, {
                name: nameValue || captureDetailsDefaultName,
                path: captureDetailsSelectedPath || state.currentPath,
                tags,
            });
            pendingCaptureBlob = null;
            captureDetailsSaved = true;
            captureDetailsModalInstance?.hide();
        } catch (error) {
            handleError(error);
        } finally {
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = originalLabel || 'Save screenshot';
            }
        }
    });
    captureDetailsForm.querySelector('[data-folder-picker="capture-destination"]')?.addEventListener('click', async () => {
        try {
            const initial = captureDetailsSelectedPath || state.currentPath;
            const selected = await openFolderPicker({ initialPath: initial, title: 'Select destination folder' });
            if (selected) {
                captureDetailsSelectedPath = selected;
                updateCaptureDestinationInput();
            }
        } catch (error) {
            handleError(error);
        }
    });
    modalEl.addEventListener('show.bs.modal', () => {
        window.setTimeout(() => {
            captureDetailsNameInput?.focus();
            captureDetailsNameInput?.select();
        }, 120);
    });
    modalEl.addEventListener('hidden.bs.modal', () => {
        if (!captureDetailsSaved && pendingCaptureBlob) {
            showToast('Screenshot discarded.', true);
        }
        pendingCaptureBlob = null;
        captureSelectedTags.clear();
        if (captureDetailsResolver) {
            captureDetailsResolver(captureDetailsSaved);
            captureDetailsResolver = null;
        }
        captureDetailsSaved = false;
    });
}

/** Show the capture modal or start capture immediately. */
function openCaptureOptions() {
    const modalEl = document.getElementById('modal-capture');
    if (!modalEl) {
        startCapture(state.settings.screenshot.mode || 'rectangle');
        return;
    }
    const current = state.settings.screenshot.mode || 'rectangle';
    modalEl.querySelectorAll('input[name="capture-mode"]').forEach((input) => {
        input.checked = input.value === current;
    });
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

function openCaptureDetailsPrompt(blob) {
    if (!captureDetailsForm || !captureDetailsModalInstance) {
        return persistCapturedScreenshot(blob, { path: state.currentPath });
    }
    pendingCaptureBlob = blob;
    captureDetailsSaved = false;
    captureDetailsDefaultName = generateScreenshotFilename();
    captureDetailsSelectedPath = state.currentPath || '.';
    captureSelectedTags.clear();
    if (captureDetailsNameInput) {
        captureDetailsNameInput.value = captureDetailsDefaultName;
    }
    updateCaptureDestinationInput();
    renderCaptureTagOptions();
    return new Promise((resolve) => {
        captureDetailsResolver = resolve;
        captureDetailsModalInstance.show();
    });
}

/** Kick off the capture workflow for a selected mode. */
async function startCapture(mode = 'rectangle') {
    try {
        const blob = await performCapture(mode);
        if (!blob) {
            showToast('Capture cancelled.', true);
            return;
        }
        if (state.settings.screenshot.promptDetails) {
            await openCaptureDetailsPrompt(blob);
        } else {
            await persistCapturedScreenshot(blob, { path: state.currentPath });
        }
    } catch (error) {
        if (error.name === 'NotAllowedError') {
            showToast('Screen capture permission denied.', true);
        } else if (error.message === 'capture-cancelled') {
            showToast('Capture cancelled.', true);
        } else {
            handleError(error);
        }
    }
}

function renderCaptureTagOptions() {
    if (!captureDetailsTagList) return;
    const tags = Array.isArray(state.tags) ? state.tags : [];
    captureDetailsTagList.innerHTML = '';
    if (!tags.length) {
        if (captureDetailsTagEmpty) {
            captureDetailsTagEmpty.classList.remove('d-none');
            captureDetailsTagList.appendChild(captureDetailsTagEmpty);
        }
        return;
    }
    if (captureDetailsTagEmpty) {
        captureDetailsTagEmpty.classList.add('d-none');
    }
    tags.forEach((tag) => {
        if (!tag?.id) return;
        const wrapper = document.createElement('div');
        wrapper.className = 'form-check capture-tag-option';
        const checkboxId = `capture-tag-${tag.id}`;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'form-check-input';
        checkbox.id = checkboxId;
        const tagId = String(tag.id);
        checkbox.value = tagId;
        checkbox.checked = captureSelectedTags.has(tagId);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                captureSelectedTags.add(tagId);
            } else {
                captureSelectedTags.delete(tagId);
            }
        });
        const label = document.createElement('label');
        label.className = 'form-check-label d-flex align-items-center gap-2 mb-0';
        label.setAttribute('for', checkboxId);
        const swatch = document.createElement('span');
        swatch.className = 'capture-tag-swatch';
        swatch.style.backgroundColor = tag.color || '#6c757d';
        const name = document.createElement('span');
        name.textContent = tag.name || `Tag ${tag.id}`;
        label.appendChild(swatch);
        label.appendChild(name);
        wrapper.appendChild(checkbox);
        wrapper.appendChild(label);
        captureDetailsTagList.appendChild(wrapper);
    });
}

function updateCaptureDestinationInput() {
    if (!captureDetailsFolderInput) return;
    const path = captureDetailsSelectedPath || '.';
    captureDetailsFolderInput.value = formatPathDisplay(path);
    captureDetailsFolderInput.dataset.path = path;
}

function generateScreenshotFilename() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    return `screenshot_${timestamp}.png`;
}

function formatPathDisplay(path) {
    if (!path || path === '.') {
        return '/';
    }
    return `/${path}`;
}

async function persistCapturedScreenshot(blob, options = {}) {
    let result = null;
    try {
        setStatus('Saving capture…');
        result = await captureScreenshot(blob, { name: options.name, path: options.path });
        if (Array.isArray(options.tags) && options.tags.length && result?.saved) {
            try {
                await assignTagsToPath(result.saved, options.tags);
            } catch (error) {
                handleError(error);
                showToast('Screenshot saved but tags could not be applied.', true);
            }
        }
        showToast('Screenshot saved');
        await loadList(state.includeSubfolders);
        requestGlobalRefresh({ refreshList: false });
        if (result?.saved) {
            showThumbnail(result.saved);
        }
    } finally {
        setStatus('Saved/Idle');
    }
    return result;
}

/** Use browser APIs to retrieve the requested capture. */
async function performCapture(mode = 'rectangle') {
    const normalized = mode || 'rectangle';
    if (typeof window.qualifileTestCapture === 'function') {
        const stubbed = await window.qualifileTestCapture(normalized);
        if (stubbed instanceof Blob) {
            return stubbed;
        }
    }
    try {
        if (!navigator.mediaDevices?.getDisplayMedia) {
            if (normalized === 'rectangle') {
                return await fallbackCapture();
            }
            throw new Error('Screen capture is not supported in this browser.');
        }
        if (normalized === 'rectangle') {
            return await captureRectangle();
        }
        const base = await captureDisplay(normalized === 'window' ? 'window' : 'monitor');
        return base?.blob || null;
    } catch (error) {
        if (normalized === 'rectangle' && (error.name === 'NotAllowedError' || error.name === 'NotFoundError' || error.name === 'AbortError')) {
            throw error;
        }
        if (normalized === 'rectangle') {
            return await fallbackCapture();
        }
        throw error;
    }
}

/** Crop a rectangle from a full-screen capture. */
async function captureRectangle() {
    const base = await captureDisplay('monitor');
    if (!base) return null;
    const selection = await beginRectangleSelection(base);
    if (!selection) return null;
    const { left, top, width, height } = selection;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(base.canvas, left, top, width, height, 0, 0, width, height);
    return await new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Unable to capture image.'))), 'image/png'));
}

/** Capture a monitor or window using getDisplayMedia. */
async function captureDisplay(surface) {
    const videoConstraints = {
        cursor: 'always',
        logicalSurface: true,
    };
    if (surface === 'window') {
        videoConstraints.displaySurface = 'window';
        videoConstraints.selfBrowserSurface = 'exclude';
    } else {
        videoConstraints.displaySurface = 'monitor';
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints, audio: false });
    try {
        const track = stream.getVideoTracks()[0];
        const settings = track.getSettings();
        const video = document.createElement('video');
        video.srcObject = stream;
        await video.play();
        if (video.readyState < 2) {
            await new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }));
        }
        const width = video.videoWidth || settings.width || 0;
        const height = video.videoHeight || settings.height || 0;
        if (!width || !height) {
            throw new Error('Unable to determine capture size.');
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, width, height);
        const blob = await new Promise((resolve, reject) => canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('Unable to capture image.'))), 'image/png'));
        return { blob, canvas, dataUrl: canvas.toDataURL('image/png'), width, height };
    } finally {
        stream.getTracks().forEach((track) => track.stop());
    }
}

/** Display an overlay that lets the user choose a region. */
function beginRectangleSelection(base) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'capture-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Select capture area');
        const container = document.createElement('div');
        container.className = 'capture-container';
        const image = document.createElement('img');
        image.src = base.dataUrl;
        image.alt = 'Captured screen preview';
        image.className = 'capture-image';
        const selection = document.createElement('div');
        selection.className = 'capture-selection';
        const instructions = document.createElement('div');
        instructions.className = 'capture-instructions';
        instructions.textContent = 'Drag to select an area. Press Esc to cancel.';
        container.appendChild(image);
        container.appendChild(selection);
        overlay.appendChild(container);
        overlay.appendChild(instructions);
        document.body.appendChild(overlay);
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        let start = null;
        let rect = null;
        let containerRect = null;
        let scaleX = 1;
        let scaleY = 1;

        const cleanup = () => {
            document.body.style.overflow = previousOverflow;
            overlay.remove();
            document.removeEventListener('keydown', onKeyDown);
        };

        const updateMetrics = () => {
            rect = image.getBoundingClientRect();
            containerRect = container.getBoundingClientRect();
            scaleX = base.width / rect.width;
            scaleY = base.height / rect.height;
        };

        const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

        const pointerDown = (event) => {
            updateMetrics();
            const x = clamp(event.clientX, rect.left, rect.right);
            const y = clamp(event.clientY, rect.top, rect.bottom);
            start = { x, y };
            selection.style.display = 'block';
            selection.style.left = `${x - containerRect.left}px`;
            selection.style.top = `${y - containerRect.top}px`;
            selection.style.width = '0px';
            selection.style.height = '0px';
            overlay.addEventListener('pointermove', pointerMove);
            overlay.addEventListener('pointerup', pointerUp);
        };

        const pointerMove = (event) => {
            if (!start) return;
            const x = clamp(event.clientX, rect.left, rect.right);
            const y = clamp(event.clientY, rect.top, rect.bottom);
            const left = Math.min(start.x, x) - containerRect.left;
            const top = Math.min(start.y, y) - containerRect.top;
            const width = Math.abs(start.x - x);
            const height = Math.abs(start.y - y);
            selection.style.left = `${left}px`;
            selection.style.top = `${top}px`;
            selection.style.width = `${width}px`;
            selection.style.height = `${height}px`;
        };

        const pointerUp = (event) => {
            overlay.removeEventListener('pointermove', pointerMove);
            overlay.removeEventListener('pointerup', pointerUp);
            if (!start) {
                cleanup();
                resolve(null);
                return;
            }
            const x = clamp(event.clientX, rect.left, rect.right);
            const y = clamp(event.clientY, rect.top, rect.bottom);
            const left = Math.min(start.x, x);
            const top = Math.min(start.y, y);
            const width = Math.abs(start.x - x);
            const height = Math.abs(start.y - y);
            cleanup();
            if (width < 5 || height < 5) {
                resolve(null);
                return;
            }
            resolve({
                left: Math.round((left - rect.left) * scaleX),
                top: Math.round((top - rect.top) * scaleY),
                width: Math.round(width * scaleX),
                height: Math.round(height * scaleY),
            });
        };

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                cleanup();
                resolve(null);
            }
        };

        image.addEventListener('load', updateMetrics, { once: true });
        overlay.addEventListener('pointerdown', pointerDown);
        document.addEventListener('keydown', onKeyDown);
        overlay.tabIndex = 0;
        overlay.focus();
    });
}

/** Fallback capture using html2canvas when screen APIs fail. */
async function fallbackCapture() {
    const legacyArea = await beginLegacyRectangleCapture();
    if (!legacyArea) return null;
    const html2canvas = await loadHtml2Canvas();
    const canvas = await html2canvas(document.body, { useCORS: true, logging: false, ignoreElements: (element) => element.classList?.contains('capture-overlay') });
    const cropped = document.createElement('canvas');
    cropped.width = legacyArea.width;
    cropped.height = legacyArea.height;
    const ctx = cropped.getContext('2d');
    ctx.drawImage(canvas, legacyArea.left, legacyArea.top, legacyArea.width, legacyArea.height, 0, 0, legacyArea.width, legacyArea.height);
    return await new Promise((resolve, reject) => cropped.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Unable to capture image.'))), 'image/png'));
}

/** Legacy rectangle capture for environments without pointer support. */
async function beginLegacyRectangleCapture() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'capture-overlay';
        overlay.style.background = 'rgba(0,0,0,0.1)';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Select capture area');
        document.body.appendChild(overlay);
        const selection = document.createElement('div');
        selection.className = 'capture-selection';
        overlay.appendChild(selection);

        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        let startX = 0;
        let startY = 0;
        let isSelecting = false;

        const pointerDown = (event) => {
            isSelecting = true;
            startX = event.clientX;
            startY = event.clientY;
            updateSelection(startX, startY, startX, startY);
        };

        const pointerMove = (event) => {
            if (!isSelecting) return;
            updateSelection(startX, startY, event.clientX, event.clientY);
        };

        const pointerUp = () => {
            if (!isSelecting) return;
            isSelecting = false;
            overlay.removeEventListener('pointerdown', pointerDown);
            overlay.removeEventListener('pointermove', pointerMove);
            overlay.removeEventListener('pointerup', pointerUp);
            overlay.removeEventListener('keydown', onKeyDown);
            document.body.style.overflow = previousOverflow;
            const rect = selection.getBoundingClientRect();
            overlay.remove();
            if (rect.width < 5 || rect.height < 5) {
                resolve(null);
            } else {
                resolve({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
            }
        };

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                overlay.removeEventListener('pointerdown', pointerDown);
                overlay.removeEventListener('pointermove', pointerMove);
                overlay.removeEventListener('pointerup', pointerUp);
                overlay.removeEventListener('keydown', onKeyDown);
                document.body.style.overflow = previousOverflow;
                overlay.remove();
                resolve(null);
            }
        };

        overlay.addEventListener('pointerdown', pointerDown);
        overlay.addEventListener('pointermove', pointerMove);
        overlay.addEventListener('pointerup', pointerUp);
        overlay.addEventListener('keydown', onKeyDown);
        overlay.tabIndex = 0;
        overlay.focus();

        function updateSelection(x1, y1, x2, y2) {
            const left = Math.min(x1, x2);
            const top = Math.min(y1, y2);
            const width = Math.abs(x1 - x2);
            const height = Math.abs(y1 - y2);
            Object.assign(selection.style, {
                left: `${left}px`,
                top: `${top}px`,
                width: `${width}px`,
                height: `${height}px`,
            });
        }
    });
}

/** Decode drag payloads produced by the list/tree views. */
function parseDragData(dataTransfer) {
    try {
        const raw = dataTransfer.getData('application/json');
        return JSON.parse(raw);
    } catch (error) {
        return null;
    }
}

/** Handle conflict resolution and perform move/copy operations. */
async function executeDrop(items, destination) {
    const targetDestination = destination && destination !== '' ? destination : '.';
    if (isInvalidDestination(items, targetDestination)) {
        showToast('Cannot move an item into itself or its subfolder.', true);
        return;
    }
    const response = await openConflictDialog(targetDestination);
    if (!response) return;
    try {
        setStatus(response.operation === 'copy' ? 'Copying…' : 'Moving…');
        if (response.operation === 'copy') {
            await copyItems(items, targetDestination, response.conflict);
        } else {
            await moveItems(items, targetDestination, response.conflict);
        }
        showToast('Operation completed');
        requestGlobalRefresh();
    } catch (error) {
        handleError(error);
    } finally {
        setStatus('Saved/Idle');
    }
}

/** Lazy-load the html2canvas library for fallback captures. */
async function loadHtml2Canvas() {
    try {
        // html2canvas is loaded on-demand to keep the default bundle lean while providing
        // a no-install fallback when secure screen capture APIs are unavailable.
        const offlineAssets = window.__QUALIFILE__?.offlineAssets === true;
        const source = offlineAssets
            ? '/static/dist/vendor/html2canvas/html2canvas.esm.js'
            : 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/+esm';
        const module = await import(source);
        return module.default || module;
    } catch (error) {
        throw new Error('Unable to load capture tooling.');
    }
}

/** Render a thumbnail of the most recent capture in the preview pane. */
function showThumbnail(path) {
    const previewContent = document.getElementById('preview-content');
    if (!previewContent) return;
    const container = document.createElement('div');
    container.className = 'thumbnail-preview mt-3';
    const img = document.createElement('img');
    img.src = fetchFileUrl(path);
    img.alt = 'Captured screenshot';
    container.appendChild(img);
    previewContent.innerHTML = '';
    previewContent.appendChild(container);
}

/** Enable draggable handles for resizing panes. */
function setupResizeHandles() {
    document.querySelectorAll('.pane-resize-handle').forEach((handle) => {
        handle.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            const pane = handle.closest('.pane');
            if (!pane) return;
            const neighborRight = findAdjacentPane(pane, 1);
            const neighborLeft = findAdjacentPane(pane, -1);
            const neighbor = neighborRight || neighborLeft;
            const direction = neighborRight ? 1 : -1;
            if (!neighbor) return;
            const startX = event.clientX;
            const paneRect = pane.getBoundingClientRect();
            const neighborRect = neighbor.getBoundingClientRect();
            const totalWidth = paneRect.width + neighborRect.width;
            if (handle.setPointerCapture) {
                handle.setPointerCapture(event.pointerId);
            }
            const onMove = (moveEvent) => {
                const delta = moveEvent.clientX - startX;
                let newPaneWidth = direction === 1 ? paneRect.width + delta : paneRect.width - delta;
                newPaneWidth = Math.max(MIN_PANE_WIDTH, Math.min(totalWidth - MIN_PANE_WIDTH, newPaneWidth));
                const newNeighborWidth = totalWidth - newPaneWidth;
                setPaneWidth(pane, newPaneWidth);
                setPaneWidth(neighbor, newNeighborWidth);
            };
            const onUp = () => {
                if (handle.releasePointerCapture && handle.hasPointerCapture?.(event.pointerId)) {
                    handle.releasePointerCapture(event.pointerId);
                }
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                persistWorkspacePaneSizes();
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
        });
    });
}

/** Reset manual layout sizing and clear session pane sizes. */
function handleLayoutReset() {
    resetLayoutStyles();
    clearWorkspacePaneSizes();
}

/** Clear inline sizing applied by manual resizing. */
function resetLayoutStyles() {
    document.querySelectorAll('.pane').forEach((pane) => {
        pane.style.flex = '';
        pane.style.width = '';
        pane.style.maxWidth = '';
        pane.style.minWidth = '';
    });
}

function isWorkspaceDesktopLayout() {
    if (window.matchMedia) {
        return window.matchMedia(WORKSPACE_LAYOUT_QUERY).matches;
    }
    return window.innerWidth >= WORKSPACE_DESKTOP_MIN_WIDTH;
}

function isWorkspacePaneVisible(pane) {
    if (!pane) return false;
    return window.getComputedStyle(pane).display !== 'none';
}

function getWorkspacePaneEntries(container = null) {
    const entries = [
        { key: 'tree', element: document.getElementById('tree-pane') },
        { key: 'list', element: document.getElementById('list-pane') },
        { key: 'preview', element: document.getElementById('preview-pane') },
    ];
    if (!container) return entries;
    return entries.filter(({ element }) => element && container.contains(element));
}

function readWorkspacePaneSizes() {
    try {
        const raw = sessionStorage.getItem(WORKSPACE_PANE_SIZES_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch (error) {
        console.warn('Unable to load workspace pane sizes', error);
        return null;
    }
}

function writeWorkspacePaneSizes(paneSizes) {
    try {
        sessionStorage.setItem(WORKSPACE_PANE_SIZES_KEY, JSON.stringify(paneSizes));
    } catch (error) {
        console.warn('Unable to persist workspace pane sizes', error);
    }
}

function clearWorkspacePaneSizes() {
    try {
        sessionStorage.removeItem(WORKSPACE_PANE_SIZES_KEY);
    } catch (error) {
        console.warn('Unable to clear workspace pane sizes', error);
    }
}

function persistWorkspacePaneSizes() {
    if (!isWorkspaceDesktopLayout()) return;
    const container = document.querySelector('.app-panels');
    const entries = getWorkspacePaneEntries(container);
    const updates = {};
    let hasUpdates = false;
    entries.forEach(({ key, element }) => {
        if (!element || !isWorkspacePaneVisible(element)) return;
        const width = Math.round(element.getBoundingClientRect().width);
        if (width <= 0) return;
        updates[key] = width;
        hasUpdates = true;
    });
    if (!hasUpdates) return;
    const existing = readWorkspacePaneSizes() || {};
    writeWorkspacePaneSizes({ ...existing, ...updates });
}

function restoreWorkspacePaneSizes() {
    if (!isWorkspaceDesktopLayout()) return;
    const savedSizes = readWorkspacePaneSizes();
    if (!savedSizes) return;
    const container = document.querySelector('.app-panels');
    if (!container) return;
    const entries = getWorkspacePaneEntries(container);
    const visibleEntries = entries.filter(({ element }) => element && isWorkspacePaneVisible(element));
    if (visibleEntries.length < 2) return;
    const hasSaved = visibleEntries.some(({ key }) => Number.isFinite(savedSizes[key]) && savedSizes[key] > 0);
    if (!hasSaved) return;
    const availableWidth = Math.round(container.getBoundingClientRect().width || 0);
    if (!availableWidth) return;
    const desiredWidths = visibleEntries.map(({ key, element }) => {
        const storedWidth = Number(savedSizes[key]);
        if (Number.isFinite(storedWidth) && storedWidth > 0) {
            return storedWidth;
        }
        const fallbackWidth = element.getBoundingClientRect().width;
        return Number.isFinite(fallbackWidth) && fallbackWidth > 0 ? fallbackWidth : MIN_PANE_WIDTH;
    });
    const clampedWidths = clampWorkspacePaneWidths(desiredWidths, availableWidth);
    if (!clampedWidths) return;
    visibleEntries.forEach(({ element }, index) => {
        setPaneWidth(element, clampedWidths[index]);
    });
}

function clampWorkspacePaneWidths(desiredWidths, availableWidth) {
    if (!Array.isArray(desiredWidths) || desiredWidths.length === 0) return null;
    if (!Number.isFinite(availableWidth) || availableWidth <= 0) return null;
    const minTotal = MIN_PANE_WIDTH * desiredWidths.length;
    if (availableWidth < minTotal) return null;
    const sanitized = desiredWidths.map((value) => (Number.isFinite(value) && value > 0 ? value : MIN_PANE_WIDTH));
    const totalDesired = sanitized.reduce((sum, value) => sum + value, 0) || 1;
    const scaled = sanitized.map((value) => (value / totalDesired) * availableWidth);
    const clamped = scaled.map((value) => Math.max(MIN_PANE_WIDTH, Math.round(value)));
    let total = clamped.reduce((sum, value) => sum + value, 0);
    if (total > availableWidth) {
        let overflow = total - availableWidth;
        const indices = clamped
            .map((width, index) => ({ width, index }))
            .sort((a, b) => b.width - a.width);
        for (const { index } of indices) {
            if (overflow <= 0) break;
            const reducible = clamped[index] - MIN_PANE_WIDTH;
            if (reducible <= 0) continue;
            const reduction = Math.min(reducible, overflow);
            clamped[index] -= reduction;
            overflow -= reduction;
        }
        if (overflow > 0) return null;
        total = clamped.reduce((sum, value) => sum + value, 0);
    }
    if (total < availableWidth) {
        const maxIndex = clamped.indexOf(Math.max(...clamped));
        clamped[maxIndex] += availableWidth - total;
    }
    return clamped;
}

/** Locate the next visible pane when resizing. */
function findAdjacentPane(pane, direction = 1) {
    let sibling = direction > 0 ? pane.nextElementSibling : pane.previousElementSibling;
    while (sibling) {
        if (sibling.classList?.contains('pane') && sibling.style.display !== 'none') {
            return sibling;
        }
        sibling = direction > 0 ? sibling.nextElementSibling : sibling.previousElementSibling;
    }
    return null;
}

/** Apply width constraints to a pane during resizing. */
function setPaneWidth(pane, width) {
    pane.style.flex = `0 0 ${width}px`;
    pane.style.maxWidth = `${width}px`;
    pane.style.width = `${width}px`;
    pane.style.minWidth = `${MIN_PANE_WIDTH}px`;
}
