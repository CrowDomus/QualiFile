import {
    createFile,
    createFolder,
    handleError,
    mergeItems,
    importStructure,
    updateRoot,
    clearRoot,
    shutdownServer,
    deleteItems,
    extractPdfPages,
    assignTagsToPath,
    createTagDefinition,
    updateTagDefinition,
    deleteTagDefinition,
    fetchTagsState,
    fetchNotes,
    createNote,
    updateNote,
    deleteNote,
    requestJson,
    setGreenshotIntegrationEnabled,
    setOfficePreviewQuality,
} from '../../shared/api.js';
import { showToast, setStatus } from '../../shared/ui.js';
import { state, persistPreferences, clearSelection, updateCurrentPath } from '../../shared/state.js';
import { applyTheme } from '../../shared/theme.js';
import { openFolderPicker } from '../filesystem/folder_picker.js';
import { releasePreviewForPaths, clearPreview } from '../preview/preview.js';
import { requestGlobalRefresh } from '../../shared/refresh.js';
import { normalizePath } from '../../shared/paths.js';
import { applyTagUpdates } from '../../shared/list.js';

let conflictResolver = null;
let currentMergeItems = [];
let mergePhraseMap = new Map();
let mergeModalPreferredMode = null;
let deleteSelection = [];
let tocExtractorScript = null;
let currentPdfExtractSource = null;
let confirmResolver = null;
let tagEditorPaths = [];
let tagEditorLabel = '';
let tagEditorList = null;
let tagEditorTarget = null;
let tagEditorModal = null;
let tagRelationsCache = null;
let draggingTagId = null;

const MERGE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);
const DEFAULT_MERGE_PHRASE_FONT_SIZE_PT = 14;
const MIN_MERGE_PHRASE_FONT_SIZE_PT = 6;
const MAX_MERGE_PHRASE_FONT_SIZE_PT = 48;
const DEFAULT_OFFICE_PREVIEW_QUALITY = 'fast';

function mergePathExtension(path) {
    const raw = typeof path === 'string' ? path.trim().toLowerCase() : '';
    if (!raw) return '';
    const match = raw.match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
}

function isPdfMergePath(path) {
    return mergePathExtension(path) === 'pdf';
}

function isImageMergePath(path) {
    return MERGE_IMAGE_EXTENSIONS.has(mergePathExtension(path));
}

function resolveMergeSelectionType(items) {
    const list = Array.isArray(items) ? items.filter((value) => typeof value === 'string' && value) : [];
    if (list.length < 2) return 'insufficient';
    if (list.every((path) => isPdfMergePath(path))) return 'pdf';
    if (list.every((path) => isImageMergePath(path))) return 'images';
    return 'mixed';
}

function normalizeMergePhraseFontSizePt(value, fallback = DEFAULT_MERGE_PHRASE_FONT_SIZE_PT) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(MIN_MERGE_PHRASE_FONT_SIZE_PT, Math.min(MAX_MERGE_PHRASE_FONT_SIZE_PT, Math.round(parsed)));
}

function mergePathBasename(path) {
    if (!path) return '';
    const normalized = String(path).replace(/\\/g, '/');
    const segments = normalized.split('/');
    return segments.pop() || normalized;
}

function clearDragHighlights() {
    document.querySelectorAll('.tag-drop-target-valid, .tag-drop-target-invalid').forEach((el) => {
        el.classList.remove('tag-drop-target-valid', 'tag-drop-target-invalid');
    });
}

function buildTagRelations(tags = []) {
    const parent = new Map();
    const children = new Map();
    const depth = new Map();
    const descendants = new Map();
    tags.forEach((tag) => {
        if (!tag?.id) return;
        const pid = tag.parent_id || null;
        parent.set(tag.id, pid);
        if (!children.has(pid)) children.set(pid, []);
        children.get(pid).push(tag.id);
    });
    const computeDepth = (id, stack = new Set()) => {
        if (depth.has(id)) return depth.get(id);
        const pid = parent.get(id);
        if (!pid) {
            depth.set(id, 0);
            return 0;
        }
        if (stack.has(pid)) {
            depth.set(id, 0);
            return 0;
        }
        stack.add(pid);
        const d = computeDepth(pid, stack) + 1;
        depth.set(id, d);
        return d;
    };
    const computeDescendants = (id, stack = new Set()) => {
        if (descendants.has(id)) return descendants.get(id);
        const set = new Set();
        const kids = children.get(id) || [];
        kids.forEach((kid) => {
            if (stack.has(kid)) return;
            set.add(kid);
            stack.add(kid);
            computeDescendants(kid, stack).forEach((d) => set.add(d));
            stack.delete(kid);
        });
        descendants.set(id, set);
        return set;
    };
    tags.forEach((tag) => tag?.id && computeDepth(tag.id));
    tags.forEach((tag) => tag?.id && computeDescendants(tag.id));
    const roots = (children.get(null) || []).slice();
    return { parent, children, depth, descendants, roots };
}
    let tagDeleteModal = null;
    let tagDeleteNameLabel = null;
    let tagDeleteConfirmButton = null;
    let tagDeleteChildrenLabel = null;
    let pendingTagDelete = null;
    let pendingSettingsSectionId = null;
let expandedNoteId = null;
let notesModalElement = null;
let notesTargetPath = '.';
let notesTargetLabel = '';
let notesOpenList = null;
let notesClosedList = null;
let notesClosedToggle = null;
let notesPriorityBadge = null;
let notesDeadlineBadge = null;
let notesTargetName = null;
let notesTargetCrumb = null;
let notesEmptyState = null;
let notesClosedSummary = null;
let noteCreateModal = null;
let noteCreateForm = null;
let noteCreatePathLabel = null;
let noteCreateText = null;
let noteCreateDeadline = null;
let noteCreatePriority = null;
let noteCreateStatus = null;
let noteCreateColorToggle = null;
let noteCreateColor = null;
let noteEditModal = null;
let noteEditForm = null;
let noteEditPathLabel = null;
let noteEditText = null;
let noteEditDeadline = null;
let noteEditPriority = null;
let noteEditStatus = null;
let noteEditColorToggle = null;
let noteEditColor = null;
let editingNoteId = null;
let cachedNotes = [];
let modalsInitialized = false;

const TAG_COLOR_PALETTE = [
    '#e57373',
    '#f06292',
    '#ba68c8',
    '#9575cd',
    '#7986cb',
    '#64b5f6',
    '#4fc3f7',
    '#4dd0e1',
    '#4db6ac',
    '#81c784',
    '#aed581',
    '#dce775',
    '#fff176',
    '#ffd54f',
    '#ffb74d',
    '#ff8a65',
    '#a1887f',
    '#90a4ae',
    '#8d6e63',
    '#ce93d8',
];

function canonicalTagPath(path) {
    const normalized = normalizePath(path);
    return normalized || '.';
}

function resolveTagColors(color) {
    const normalized = normalizeHex(color || '#6c757d');
    return {
        background: normalized,
        text: computeTagTextShade(normalized),
    };
}

function normalizeHex(value) {
    if (!value) return '#6c757d';
    const text = value.trim();
    if (!text) return '#6c757d';
    const hex = text.startsWith('#') ? text.slice(1) : text;
    if (hex.length === 3) {
        const expanded = hex.split('').map((ch) => ch + ch).join('');
        return `#${expanded}`.toLowerCase();
    }
    if (hex.length !== 6) {
        return '#6c757d';
    }
    return `#${hex.toLowerCase()}`;
}

function computeTagTextShade(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const luminance = 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
    return luminance > 0.6 ? '#0f1115' : '#ffffff';
}

function linearize(channel) {
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}


export function initModals() {
    if (modalsInitialized) return;
    modalsInitialized = true;
    setupFolderModal();
    setupFileModal();
    setupMergeModal();
    setupPdfExtractModal();
    setupConflictModal();
    setupImportModal();
    setupSettingsModal();
    setupDeleteModal();
    setupConfirmModal();
    setupNotesViewModal();
    setupNoteCreateModal();
    setupNoteEditModal();
    setupFileTagsModal();
}

/** Configure the "create folder" modal interactions. */
function setupFolderModal() {
    const form = document.getElementById('form-folder');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = form.querySelector('#folder-name');
        const feedback = form.querySelector('#folder-feedback');
        const name = input.value.trim();
        if (!validateName(name, feedback)) return;
        try {
            setStatus('Creating folderâ€¦');
            await createFolder(name);
            bootstrap.Modal.getOrCreateInstance(document.getElementById('modal-folder')).hide();
            form.reset();
            showToast('Folder created');
            requestGlobalRefresh();
        } catch (error) {
            feedback.textContent = error.message;
            input.classList.add('is-invalid');
            handleError(error);
        } finally {
            setStatus('Saved/Idle');
        }
    });
    document.getElementById('modal-folder')?.addEventListener('hidden.bs.modal', () => {
        const input = form.querySelector('#folder-name');
        input.classList.remove('is-invalid');
        form.reset();
    });
}

/** Configure the "create file" modal interactions. */
function setupFileModal() {
    const form = document.getElementById('form-file');
    if (!form) return;
    const tagContainer = document.getElementById('create-file-tag-container');
    const tagOptions = document.getElementById('create-file-tag-options');
    const tagRefresh = document.getElementById('create-file-tag-refresh');
    const tagPanel = document.getElementById('create-file-tag-panel');
    const tagToggle = document.getElementById('create-file-tag-toggle');
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = form.querySelector('#file-name');
        const feedback = form.querySelector('#file-feedback');
        const name = input.value.trim();
        if (!validateName(name, feedback)) return;
        if (!name.includes('.')) {
            feedback.textContent = 'Include a file extension (e.g. .txt).';
            input.classList.add('is-invalid');
            return;
        }
        try {
            setStatus('Creating fileâ€¦');
            const created = await createFile(name);
            const selectedTags = collectSelectedTags(tagOptions);
            if (selectedTags.length && created?.created) {
                await assignTagsToPath(created.created, selectedTags);
                state.tagAssignments[canonicalTagPath(created.created)] = selectedTags;
            }
            bootstrap.Modal.getOrCreateInstance(document.getElementById('modal-file')).hide();
            form.reset();
            showToast('File created');
            requestGlobalRefresh();
        } catch (error) {
            feedback.textContent = error.message;
            input.classList.add('is-invalid');
            handleError(error);
        } finally {
            setStatus('Saved/Idle');
        }
    });
    document.getElementById('modal-file')?.addEventListener('hidden.bs.modal', () => {
        const input = form.querySelector('#file-name');
        input.classList.remove('is-invalid');
        form.reset();
        if (tagOptions) {
            tagOptions.innerHTML = '';
        }
        if (tagPanel) {
            tagPanel.classList.add('d-none');
        }
        if (tagToggle) {
            tagToggle.textContent = 'Show tags';
            tagToggle.setAttribute('aria-expanded', 'false');
        }
    });
    document.getElementById('modal-file')?.addEventListener('show.bs.modal', () => {
        if (!tagContainer || !tagOptions) return;
        renderTagSelector(tagOptions, { idPrefix: 'create-file-tag' });
        tagContainer.classList.remove('d-none');
        if (tagPanel && tagToggle) {
            tagPanel.classList.add('d-none');
            tagToggle.textContent = 'Show tags';
            tagToggle.setAttribute('aria-expanded', 'false');
        }
    });
    tagRefresh?.addEventListener('click', async () => {
        try {
            await refreshTagState();
            renderTagSelector(tagOptions, { idPrefix: 'create-file-tag' });
        } catch (error) {
            handleError(error);
        }
    });
    tagToggle?.addEventListener('click', () => {
        if (!tagPanel) return;
        const expanded = !tagPanel.classList.toggle('d-none');
        tagToggle.textContent = expanded ? 'Hide tags' : 'Show tags';
        tagToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
}

/** Build and handle the merge configuration modal. */
function setupMergeModal() {
    const modalElement = document.getElementById('modal-merge');
    if (!modalElement) return;
    const form = document.getElementById('form-merge');
    const list = document.getElementById('merge-selected-list');
    const warning = document.getElementById('merge-warning');
    const destinationInput = form.querySelector('#merge-destination');
    const mergeModeInput = form.querySelector('#merge-mode');
    const phraseFontSizeInput = form.querySelector('#merge-phrase-font-size');
    const phraseToggle = form.querySelector('#merge-phrases-toggle');
    const phraseContainer = form.querySelector('#merge-phrases-container');
    const phrasesList = form.querySelector('#merge-phrases-list');
    const useFilenamesButton = form.querySelector('#merge-phrases-use-filenames');
    const clearPhrasesButton = form.querySelector('#merge-phrases-clear');
    const imageOnlySections = Array.from(form.querySelectorAll('[data-merge-images-only="true"]'));
    const submitButton = form.querySelector('button[type="submit"]');
    const tagSection = document.getElementById('merge-tag-section');
    const tagPanel = document.getElementById('merge-tag-panel');
    const tagToggle = document.getElementById('merge-tags-toggle');
    const tagOptions = document.getElementById('merge-tag-options');
    const setWarning = (message = '') => {
        if (!warning) return;
        const hasMessage = Boolean(message);
        warning.classList.toggle('d-none', !hasMessage);
        warning.textContent = hasMessage ? message : '';
    };
    const setSubmitEnabled = (enabled) => {
        if (!submitButton) return;
        submitButton.disabled = !enabled;
    };
    const toggleImageOnlyControls = (visible) => {
        imageOnlySections.forEach((section) => {
            section.classList.toggle('d-none', !visible);
            section.querySelectorAll('input, select, textarea, button').forEach((control) => {
                control.disabled = !visible;
            });
        });
    };
    const syncMergeModeUi = () => {
        const mode = mergeModeInput?.value === 'images' ? 'images' : 'pdf';
        const isImagesMode = mode === 'images';
        toggleImageOnlyControls(isImagesMode);
        const showPhrases = isImagesMode && !!phraseToggle?.checked;
        phraseContainer?.classList.toggle('d-none', !showPhrases);
        if (showPhrases) {
            renderMergePhrases();
        }
    };
    const applySelectionModeConstraints = () => {
        const selectionType = resolveMergeSelectionType(currentMergeItems);
        const pdfOption = mergeModeInput?.querySelector('option[value="pdf"]');
        const imagesOption = mergeModeInput?.querySelector('option[value="images"]');
        if (pdfOption) pdfOption.disabled = false;
        if (imagesOption) imagesOption.disabled = false;
        if (selectionType === 'pdf') {
            if (imagesOption) imagesOption.disabled = true;
            if (mergeModeInput) mergeModeInput.value = 'pdf';
            setWarning('');
            setSubmitEnabled(true);
        } else if (selectionType === 'images') {
            if (pdfOption) pdfOption.disabled = true;
            if (mergeModeInput) mergeModeInput.value = 'images';
            setWarning('');
            setSubmitEnabled(true);
        } else if (selectionType === 'mixed') {
            setWarning('Select only PDFs or only PNG/JPG images to merge.');
            setSubmitEnabled(false);
        } else {
            setWarning('Select at least two files to merge.');
            setSubmitEnabled(false);
        }
        syncMergeModeUi();
        return selectionType;
    };
    const applyFilenamePhrases = () => {
        if (mergeModeInput?.value !== 'images') return;
        if (phraseToggle && !phraseToggle.checked) {
            phraseToggle.checked = true;
        }
        Array.from(list.querySelectorAll('li')).forEach((item) => {
            const path = item.dataset.path || '';
            mergePhraseMap.set(path, mergePathBasename(path));
        });
        renderMergePhrases();
    };
    const clearAllPhrases = () => {
        Array.from(list.querySelectorAll('li')).forEach((item) => {
            const path = item.dataset.path || '';
            mergePhraseMap.delete(path);
        });
        renderMergePhrases();
    };
    form.querySelector('[data-folder-picker="merge-destination"]')?.addEventListener('click', async () => {
        try {
            const initial = destinationInput.value.trim() || state.currentPath;
            const selected = await openFolderPicker({ initialPath: initial, title: 'Select destination' });
            if (selected) {
                destinationInput.value = selected;
            }
        } catch (error) {
            handleError(error);
        }
    });
    phraseToggle?.addEventListener('change', () => {
        syncMergeModeUi();
    });
    mergeModeInput?.addEventListener('change', () => {
        const selectionType = resolveMergeSelectionType(currentMergeItems);
        if (selectionType === 'mixed') {
            setWarning('Select only PDFs or only PNG/JPG images to merge.');
            setSubmitEnabled(false);
        } else if (selectionType === 'insufficient') {
            setWarning('Select at least two files to merge.');
            setSubmitEnabled(false);
        } else {
            setWarning('');
            setSubmitEnabled(true);
        }
        syncMergeModeUi();
    });
    useFilenamesButton?.addEventListener('click', applyFilenamePhrases);
    clearPhrasesButton?.addEventListener('click', clearAllPhrases);
    if (tagToggle && tagPanel) {
        tagToggle.addEventListener('click', () => {
            const expanded = tagPanel.classList.toggle('d-none');
            tagToggle.textContent = expanded ? 'Hide tags' : 'Show tags';
            tagToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        });
    }
    modalElement.addEventListener('show.bs.modal', () => {
        const hasTags = !!(state.tags && state.tags.length);
        if (tagSection) {
            tagSection.classList.toggle('d-none', !hasTags);
        }
        if (tagOptions) {
            renderTagSelector(tagOptions, { idPrefix: 'merge-tag' });
            if (tagPanel && tagToggle) {
                tagPanel.classList.add('d-none');
                tagToggle.textContent = 'Show tags';
                tagToggle.setAttribute('aria-expanded', 'false');
            }
        }
    });
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (currentMergeItems.length < 2) {
            setWarning('Select at least two files to merge.');
            return;
        }
        const mode = mergeModeInput?.value === 'images' ? 'images' : 'pdf';
        const outputName = form.querySelector('#merge-output-name').value.trim();
        const destination = form.querySelector('#merge-destination').value.trim() || '.';
        const order = Array.from(list.querySelectorAll('li')).map((item) => item.dataset.path);
        const selectionType = resolveMergeSelectionType(order);
        if (selectionType === 'mixed') {
            setWarning('Select only PDFs or only PNG/JPG images to merge.');
            return;
        }
        if (selectionType === 'insufficient') {
            setWarning('Select at least two files to merge.');
            return;
        }
        if (mode === 'pdf' && selectionType !== 'pdf') {
            setWarning('Select at least two PDF files to use Merge PDFs.');
            return;
        }
        if (mode === 'images' && selectionType !== 'images') {
            setWarning('Select at least two PNG/JPG image files to merge into a PDF.');
            return;
        }
        setWarning('');
        const options = {
            items: currentMergeItems,
            order,
            mode,
            outputName,
            path: destination,
            paperSize: form.querySelector('#merge-paper').value,
            orientation: form.querySelector('#merge-orientation').value,
            margin: Number(form.querySelector('#merge-margin').value || state.settings.mergeDefaults.margin || 10),
            fit: form.querySelector('#merge-fit').value,
            phraseAlignment: form.querySelector('#merge-phrase-alignment').value,
            phraseFontSizePt: normalizeMergePhraseFontSizePt(
                phraseFontSizeInput?.value,
                state.settings.mergeDefaults.captionFontSizePt ?? DEFAULT_MERGE_PHRASE_FONT_SIZE_PT,
            ),
            pageNumbers: form.querySelector('#merge-page-numbers').checked,
        };
        if (mode === 'images' && phraseToggle?.checked) {
            const phrases = {};
            Array.from(list.querySelectorAll('li')).forEach((item, index) => {
                const value = (mergePhraseMap.get(item.dataset.path) || '').trim();
                if (value) {
                    phrases[index] = value;
                }
            });
            options.phrases = phrases;
        }
        try {
            setStatus('Mergingâ€¦');
            const result = await mergeItems(options);
            bootstrap.Modal.getOrCreateInstance(modalElement).hide();
            showToast('Merge completed');
            requestGlobalRefresh();
            const selectedTags = collectSelectedTags(tagOptions);
            if (selectedTags.length && result?.output) {
                await assignTagsToPath(result.output, selectedTags);
                state.tagAssignments[canonicalTagPath(result.output)] = selectedTags;
            }
            if (form.querySelector('#merge-remember').checked) {
                state.settings.mergeDefaults = {
                    paperSize: options.paperSize,
                    orientation: options.orientation,
                    margin: options.margin,
                    fit: options.fit,
                    phraseAlignment: options.phraseAlignment,
                    pageNumbers: options.pageNumbers,
                    captionFontSizePt: options.phraseFontSizePt,
                };
                persistPreferences();
            }
            if (result.output) {
                window.setTimeout(() => {
                    requestGlobalRefresh();
                }, 250);
            }
        } catch (error) {
            warning.classList.remove('d-none');
            warning.textContent = error.message;
            handleError(error);
        } finally {
            setStatus('Saved/Idle');
        }
    });

    modalElement.addEventListener('show.bs.modal', () => {
        form.querySelector('#merge-paper').value = state.settings.mergeDefaults.paperSize;
        form.querySelector('#merge-orientation').value = state.settings.mergeDefaults.orientation;
        form.querySelector('#merge-margin').value = state.settings.mergeDefaults.margin;
        form.querySelector('#merge-fit').value = state.settings.mergeDefaults.fit;
        form.querySelector('#merge-phrase-alignment').value = state.settings.mergeDefaults.phraseAlignment;
        form.querySelector('#merge-page-numbers').checked = Boolean(state.settings.mergeDefaults.pageNumbers);
        if (phraseFontSizeInput) {
            phraseFontSizeInput.value = String(
                normalizeMergePhraseFontSizePt(
                    state.settings.mergeDefaults.captionFontSizePt,
                    DEFAULT_MERGE_PHRASE_FONT_SIZE_PT,
                ),
            );
        }
        form.querySelector('#merge-destination').value = state.currentPath;
        const selectionType = resolveMergeSelectionType(currentMergeItems);
        form.querySelector('#merge-output-name').value = selectionType === 'images' ? 'Images.pdf' : 'Merged.pdf';
        if (mergeModeInput && (mergeModalPreferredMode === 'pdf' || mergeModalPreferredMode === 'images')) {
            mergeModeInput.value = mergeModalPreferredMode;
        } else if (mergeModeInput) {
            mergeModeInput.value = selectionType === 'images' ? 'images' : 'pdf';
        }
        mergeModalPreferredMode = null;
        populateMergeList(list);
        setWarning('');
        mergePhraseMap = new Map();
        if (phraseToggle) {
            phraseToggle.checked = false;
        }
        if (phrasesList) {
            phrasesList.innerHTML = '';
        }
        applySelectionModeConstraints();
    });

    list.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const item = button.closest('li');
        if (!item) return;
        const action = button.dataset.action;
        if (action === 'remove') {
            currentMergeItems = currentMergeItems.filter((path) => path !== item.dataset.path);
            item.remove();
            mergePhraseMap.delete(item.dataset.path);
            renderMergePhrases();
            applySelectionModeConstraints();
        } else if (action === 'up' || action === 'down') {
            const sibling = action === 'up' ? item.previousElementSibling : item.nextElementSibling;
            if (!sibling) return;
            if (action === 'up') {
                item.parentElement.insertBefore(item, sibling);
            } else {
                item.parentElement.insertBefore(sibling, item);
            }
            renderMergePhrases();
            applySelectionModeConstraints();
        }
    });
}

function setupPdfExtractModal() {
    const modalElement = document.getElementById('modal-pdf-extract');
    if (!modalElement) return;
    const form = document.getElementById('form-pdf-extract');
    const sourceInput = form.querySelector('#pdf-extract-source');
    const pagesInput = form.querySelector('#pdf-extract-pages');
    const pagesFeedback = form.querySelector('#pdf-extract-pages-feedback');
    const destinationInput = form.querySelector('#pdf-extract-destination');
    const outputInput = form.querySelector('#pdf-extract-output');
    const warning = form.querySelector('#pdf-extract-warning');
    const tagSection = document.getElementById('pdf-extract-tag-section');
    const tagPanel = document.getElementById('pdf-extract-tag-panel');
    const tagToggle = document.getElementById('pdf-extract-tags-toggle');
    const tagOptions = document.getElementById('pdf-extract-tag-options');

    form.querySelector('[data-folder-picker="pdf-extract-destination"]')?.addEventListener('click', async () => {
        try {
            const initial = destinationInput.value.trim() || state.currentPath;
            const selected = await openFolderPicker({ initialPath: initial, title: 'Select destination' });
            if (selected) {
                destinationInput.value = selected;
            }
        } catch (error) {
            handleError(error);
        }
    });

    modalElement.addEventListener('show.bs.modal', () => {
        warning.classList.add('d-none');
        warning.textContent = '';
        pagesInput.classList.remove('is-invalid');
        pagesFeedback.textContent = '';
        const source = currentPdfExtractSource;
        if (source) {
            sourceInput.value = source;
            const segments = source.split('/');
            const fileName = segments.pop() || source;
            const parent = segments.join('/') || '.';
            destinationInput.value = parent || '.';
            const stem = fileName.replace(/\.pdf$/i, '');
            outputInput.value = `${stem || 'extracted'}-pages.pdf`;
        } else {
            sourceInput.value = '';
            destinationInput.value = state.currentPath || '.';
            outputInput.value = 'extracted-pages.pdf';
        }
        const hasTags = !!(state.tags && state.tags.length);
        if (tagSection) {
            tagSection.classList.toggle('d-none', !hasTags);
        }
        if (tagOptions) {
            renderTagSelector(tagOptions, { idPrefix: 'pdf-extract-tag' });
            if (tagPanel && tagToggle) {
                tagPanel.classList.add('d-none');
                tagToggle.textContent = 'Show tags';
                tagToggle.setAttribute('aria-expanded', 'false');
            }
        }
        pagesInput.value = '';
    });

    modalElement.addEventListener('hidden.bs.modal', () => {
        pagesInput.value = '';
        warning.classList.add('d-none');
        warning.textContent = '';
        currentPdfExtractSource = null;
    });

    if (tagToggle && tagPanel) {
        tagToggle.addEventListener('click', () => {
            const expanded = !tagPanel.classList.toggle('d-none');
            tagToggle.textContent = expanded ? 'Hide tags' : 'Show tags';
            tagToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        });
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!currentPdfExtractSource) {
            showToast('Select a PDF to extract first.', true);
            return;
        }
        const pages = pagesInput.value.trim();
        if (!pages) {
            pagesFeedback.textContent = 'Enter one or more page numbers.';
            pagesInput.classList.add('is-invalid');
            return;
        }
        pagesInput.classList.remove('is-invalid');
        pagesFeedback.textContent = '';
        const destination = destinationInput.value.trim() || '.';
        const output = outputInput.value.trim() || 'extracted-pages.pdf';
        try {
            setStatus('Extracting pages?');
            const result = await extractPdfPages({
                path: currentPdfExtractSource,
                pages,
                destination,
                output_name: output,
            });
            const selectedTags = collectSelectedTags(tagOptions);
            if (selectedTags.length && result?.output) {
                await assignTagsToPath(result.output, selectedTags);
                state.tagAssignments[canonicalTagPath(result.output)] = selectedTags;
            }
            bootstrap.Modal.getOrCreateInstance(modalElement).hide();
            showToast('Pages extracted');
            requestGlobalRefresh();
        } catch (error) {
            warning.classList.remove('d-none');
            warning.textContent = error.message;
            handleError(error);
        } finally {
            setStatus('Saved/Idle');
        }
    });
}



/** Populate the merge list with selected items. */
function populateMergeList(list) {
    list.innerHTML = '';
    for (const path of currentMergeItems) {
        const li = document.createElement('li');
        li.className = 'list-group-item d-flex justify-content-between align-items-center gap-2';
        li.dataset.path = path;
        const name = path.split('/').pop();
        const nameSpan = document.createElement('span');
        nameSpan.className = 'text-truncate';
        nameSpan.textContent = name;
        const buttonGroup = document.createElement('div');
        buttonGroup.className = 'btn-group btn-group-sm';
        buttonGroup.setAttribute('role', 'group');
        const upButton = document.createElement('button');
        upButton.type = 'button';
        upButton.className = 'btn btn-outline-secondary';
        upButton.dataset.action = 'up';
        upButton.setAttribute('aria-label', 'Move up');
        upButton.textContent = 'Up';
        const downButton = document.createElement('button');
        downButton.type = 'button';
        downButton.className = 'btn btn-outline-secondary';
        downButton.dataset.action = 'down';
        downButton.setAttribute('aria-label', 'Move down');
        downButton.textContent = 'Down';
        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'btn btn-outline-danger';
        removeButton.dataset.action = 'remove';
        removeButton.setAttribute('aria-label', 'Remove');
        removeButton.textContent = 'Remove';
        buttonGroup.append(upButton, downButton, removeButton);
        li.append(nameSpan, buttonGroup);
        list.appendChild(li);
    }
    renderMergePhrases();
}

/** Render optional phrase inputs per merged page. */
function renderMergePhrases() {
    const toggle = document.getElementById('merge-phrases-toggle');
    const modeInput = document.getElementById('merge-mode');
    const container = document.getElementById('merge-phrases-container');
    const phrasesList = document.getElementById('merge-phrases-list');
    const list = document.getElementById('merge-selected-list');
    const isImagesMode = modeInput?.value === 'images';
    if (!toggle || !container || !phrasesList || !list) {
        return;
    }
    if (!toggle.checked || !isImagesMode) {
        container.classList.add('d-none');
        return;
    }
    phrasesList.innerHTML = '';
    const items = Array.from(list.querySelectorAll('li'));
    if (!items.length) {
        container.classList.add('d-none');
        return;
    }
    container.classList.remove('d-none');
    items.forEach((item, index) => {
        const path = item.dataset.path;
        const name = item.querySelector('.text-truncate')?.textContent || path;
        const wrapper = document.createElement('div');
        wrapper.className = 'phrase-field';
        const label = document.createElement('label');
        label.className = 'form-label';
        label.textContent = `Page ${index + 1}: ${name}`;
        label.setAttribute('for', `merge-phrase-${index}`);
        const textarea = document.createElement('textarea');
        textarea.className = 'form-control';
        textarea.rows = 2;
        textarea.id = `merge-phrase-${index}`;
        textarea.dataset.path = path;
        textarea.placeholder = 'Optional phrase for this page';
        textarea.value = mergePhraseMap.get(path) || '';
        textarea.addEventListener('input', () => {
            if (textarea.value.trim()) {
                mergePhraseMap.set(path, textarea.value);
            } else {
                mergePhraseMap.delete(path);
            }
        });
        wrapper.appendChild(label);
        wrapper.appendChild(textarea);
        phrasesList.appendChild(wrapper);
    });
}

/** Configure the move/copy conflict resolution modal. */
function setupConflictModal() {
    const form = document.getElementById('form-conflict');
    if (!form) return;
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const conflict = form.querySelector('input[name="conflict"]:checked').value;
        const operation = form.querySelector('#conflict-operation').value;
        bootstrap.Modal.getInstance(document.getElementById('modal-conflict')).hide();
        if (conflictResolver) {
            conflictResolver({ conflict, operation });
            conflictResolver = null;
        }
    });
    document.getElementById('modal-conflict')?.addEventListener('hidden.bs.modal', () => {
        if (conflictResolver) {
            conflictResolver(null);
            conflictResolver = null;
        }
    });
}

/** Prepare the delete confirmation modal. */
function setupDeleteModal() {
    const modal = document.getElementById('modal-delete');
    if (!modal) return;
    const form = document.getElementById('form-delete');
    const list = document.getElementById('delete-list');
    const warning = document.getElementById('delete-warning');
    const permanentToggle = document.getElementById('delete-permanent');

    modal.addEventListener('show.bs.modal', () => {
        if (list) {
            list.innerHTML = '';
            if (!deleteSelection.length) {
                const empty = document.createElement('li');
                empty.className = 'list-group-item text-muted';
                empty.textContent = 'No items selected.';
                list.appendChild(empty);
            } else {
                deleteSelection.forEach((path) => {
                    const entry = state.items.find((item) => item.path === path);
                    const name = entry?.displayName || entry?.name || path.split('/').pop() || path;
                    const itemElement = document.createElement('li');
                    itemElement.className = 'list-group-item d-flex justify-content-between align-items-center';
                    itemElement.textContent = name;
                    const badge = document.createElement('span');
                    badge.className = 'badge bg-secondary';
                    badge.textContent = entry?.is_dir ? 'Folder' : 'File';
                    itemElement.appendChild(badge);
                    list.appendChild(itemElement);
                });
            }
        }
        if (warning) {
            warning.classList.add('d-none');
            warning.textContent = '';
        }
        if (permanentToggle) {
            permanentToggle.checked = !state.settings.softDelete;
        }
    });

    modal.addEventListener('hidden.bs.modal', () => {
        deleteSelection = [];
        if (warning) {
            warning.classList.add('d-none');
            warning.textContent = '';
        }
    });

    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!deleteSelection.length) {
            if (warning) {
                warning.classList.remove('d-none');
                warning.textContent = 'Select at least one item to delete.';
            }
            return;
        }
        try {
            setStatus('Deletingâ€¦');
            const permanent = Boolean(permanentToggle?.checked || !state.settings.softDelete);
            releasePreviewForPaths(deleteSelection);
            await deleteItems(deleteSelection, permanent);
            bootstrap.Modal.getInstance(modal)?.hide();
            showToast('Items deleted');
            clearSelection();
            requestGlobalRefresh();
        } catch (error) {
            if (warning) {
                warning.classList.remove('d-none');
                warning.textContent = error.message;
            }
            handleError(error);
        } finally {
            setStatus('Saved/Idle');
        }
    });
}

/** Configure the structure import workflow. */
function setupImportModal() {
    const modal = document.getElementById('modal-import');
    if (!modal) return;
    const form = document.getElementById('form-import');
    const preview = document.getElementById('import-preview');
    const warning = document.getElementById('import-warning');
    const fileInput = document.getElementById('import-file');
    const refreshButton = document.getElementById('import-refresh');
    const applyButton = document.getElementById('import-apply');
    const destinationInput = document.getElementById('import-destination');
    form.querySelector('[data-folder-picker="import-destination"]')?.addEventListener('click', async () => {
        try {
            const initial = destinationInput.value.trim() || state.currentPath;
            const selected = await openFolderPicker({ initialPath: initial, title: 'Select destination' });
            if (selected) {
                destinationInput.value = selected;
            }
        } catch (error) {
            handleError(error);
        }
    });

    async function runImport(mode) {
        if (!fileInput.files.length) {
            warning.textContent = 'Choose a template file first.';
            warning.classList.remove('d-none');
            return;
        }
        warning.classList.add('d-none');
        const formData = new FormData();
        formData.append('template', fileInput.files[0]);
        formData.append('destination', destinationInput.value.trim() || '.');
        formData.append('collision', form.querySelector('input[name="import-collision"]:checked').value);
        formData.append('label_mode', form.querySelector('input[name="import-label-mode"]:checked').value);
        formData.append('mode', mode === 'apply' ? 'apply' : 'preview');
        try {
            setStatus(mode === 'apply' ? 'Creating structureâ€¦' : 'Generating previewâ€¦');
            const result = await importStructure(formData);
            if (mode === 'apply') {
                bootstrap.Modal.getOrCreateInstance(modal).hide();
                showToast('Structure created');
                requestGlobalRefresh();
            } else {
                renderImportPreview(preview, result);
            }
        } catch (error) {
            warning.textContent = error.message;
            warning.classList.remove('d-none');
            handleError(error);
        } finally {
            setStatus('Saved/Idle');
        }
    }

    refreshButton?.addEventListener('click', () => runImport('preview'));
    applyButton?.addEventListener('click', () => runImport('apply'));
}

/** Render the preview list for structure import. */
function renderImportPreview(container, payload) {
    container.innerHTML = '';
    const list = document.createElement('ul');
    list.className = 'list-unstyled mb-0';
    const planned = payload.preview || payload.planned || [];
    const collisions = new Set(payload.collisions || []);
    if (!planned.length) {
        container.innerHTML = '<p class="text-muted mb-0">No new items would be created.</p>';
        return;
    }
    for (const item of planned) {
        const li = document.createElement('li');
        li.className = collisions.has(item.path) ? 'text-danger' : '';
        const prefix = item.is_dir ? 'ðŸ“' : 'ðŸ“„';
        li.textContent = `${prefix} ${item.path}`;
        list.appendChild(li);
    }
    container.appendChild(list);
    if (collisions.size) {
        const note = document.createElement('p');
        note.className = 'text-warning-emphasis mt-2 mb-0';
        note.textContent = `${collisions.size} item(s) already exist.`;
        container.appendChild(note);
    }
}

/** Wire up controls within the settings modal. */
function setupSettingsModal() {
    const modal = document.getElementById('modal-settings');
    if (!modal) return;
    const rootInput = document.getElementById('settings-root');
    const applyButton = document.getElementById('settings-root-apply');
    const clearButton = document.getElementById('settings-root-clear');
    const softToggle = document.getElementById('settings-soft-delete');
    const themeLight = document.getElementById('theme-light');
    const themeLightPlus = document.getElementById('theme-light-plus');
    const themeDark = document.getElementById('theme-dark');
    const themeDarkPlus = document.getElementById('theme-dark-plus');
    const themeButtons = [
        { el: themeLight, value: 'light' },
        { el: themeLightPlus, value: 'light+' },
        { el: themeDark, value: 'dark' },
        { el: themeDarkPlus, value: 'dark+' },
    ].filter((entry) => entry.el);
    const resetLayout = document.getElementById('settings-reset-layout');
    const saveButton = document.getElementById('settings-save');
    const copyButton = document.getElementById('settings-copy-toc');
    const copyFeedback = document.getElementById('settings-copy-toc-feedback');
    const copyVersionButton = document.getElementById('settings-copy-version');
    const copyVersionFeedback = document.getElementById('settings-copy-version-feedback');
    const appVersionLabel = document.getElementById('settings-app-version');
    const openUserGuideButton = document.getElementById('settings-open-user-guide');
    const exitButton = document.getElementById('settings-exit-app');
    const clearCacheButton = document.getElementById('settings-clear-preview-cache');
    const clearCacheSpinner = document.getElementById('settings-clear-preview-cache-spinner');
    const openDataDirButton = document.getElementById('settings-open-data-dir');
    const dataDirStatus = document.getElementById('settings-data-dir-status');
    const navItems = modal.querySelectorAll('[data-settings-nav]');
    const panes = modal.querySelectorAll('[data-settings-pane]');
    const designModeInputs = modal.querySelectorAll('input[name="design-mode"]');
    const sidebarCompactLockToggle = document.getElementById('settings-sidebar-compact-lock');
    const tagCreateForm = document.getElementById('settings-tag-create-form');
    const tagCreateButton = document.getElementById('settings-tag-create-submit');
    const tagNameInput = document.getElementById('settings-tag-name');
    const tagNameFeedback = document.getElementById('settings-tag-feedback');
    const tagListElement = document.getElementById('settings-tag-list');
    const tagLimitIndicator = document.getElementById('settings-tag-limit');
    const tagSearchInput = document.getElementById('settings-tag-search');
    const tagRootDropZone = document.getElementById('settings-tag-root-drop');
    const tagsHierarchyToggle = document.getElementById('settings-tags-hierarchy');
    const screenshotPromptToggle = document.getElementById('settings-screenshot-details');
    const nestedProjectsToggle = document.getElementById('settings-projects-nested');
    const includeProjectChildrenToggle = document.getElementById('settings-projects-include-children');
    const timelineOpenOnClickToggle = document.getElementById('settings-projects-timeline-open-on-click');
    const compactTaskPreviewToggle = document.getElementById('settings-projects-compact-task-preview');
    const projectColorStyleSelect = document.getElementById('settings-projects-project-color-style');
    const timelineHierarchyLinksSelect = document.getElementById('settings-projects-timeline-hierarchy-links');
    const projectsNoteLinesInput = document.getElementById('settings-projects-note-lines');
    const syncAutoRefreshToggle = document.getElementById('settings-sync-auto-refresh-toggle');
    const syncAutoRefreshInterval = document.getElementById('settings-sync-auto-refresh-interval');
    const syncProjectColorStyle = document.getElementById('settings-sync-project-color-style');
    const syncAdvancedRowActionsToggle = document.getElementById('settings-sync-advanced-row-actions-toggle');
    const syncActivityPanelVisibleToggle = document.getElementById('settings-sync-activity-panel-visible-toggle');
    const timelineSettingBarLabels = document.getElementById('timeline-setting-bar-labels');
    const timelineSettingHighlightRows = document.getElementById('timeline-setting-highlight-rows');
    const timelineHierarchyEnabled = document.getElementById('timeline-hierarchy-enabled');
    const mergePaperInput = document.getElementById('settings-merge-paper');
    const mergeOrientationInput = document.getElementById('settings-merge-orientation');
    const mergeMarginInput = document.getElementById('settings-merge-margin');
    const mergeFitInput = document.getElementById('settings-merge-fit');
    const mergeAlignmentInput = document.getElementById('settings-merge-alignment');
    const mergePageNumbersToggle = document.getElementById('settings-merge-page-numbers');
    const officePreviewQualityInput = document.getElementById('settings-preview-office-quality');
    const greenshotPathInput = document.getElementById('settings-greenshot-path');
    const greenshotHotkeyInput = document.getElementById('settings-greenshot-hotkey');
    const greenshotDelayInput = document.getElementById('settings-greenshot-delay');
    const greenshotEnabledToggle = document.getElementById('settings-greenshot-enabled');
    const greenshotConfigContainer = document.getElementById('settings-greenshot-config');
    tagDeleteModal = document.getElementById('modal-tag-delete');
    tagDeleteNameLabel = document.getElementById('modal-tag-delete-name');
    tagDeleteChildrenLabel = document.getElementById('modal-tag-delete-children');
    tagDeleteConfirmButton = document.getElementById('modal-tag-delete-confirm');

    if (!state.settingsPanel) {
        state.settingsPanel = { activeSection: 'general' };
    }
    if (!state.settingsPanel.activeSection) {
        state.settingsPanel.activeSection = 'general';
    }
    let settingsBaseline = '';
    let draftTheme = state.theme;

    const normalizeNotePreviewLines = (value) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return 1;
        return Math.min(10, Math.max(1, Math.round(parsed)));
    };

    const normalizeMergeMargin = (value, fallback = 10) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return parsed;
    };

    const normalizeMergeCaptionSize = (value, fallback = DEFAULT_MERGE_PHRASE_FONT_SIZE_PT) =>
        normalizeMergePhraseFontSizePt(value, fallback);

    const normalizeSyncRefreshInterval = (value, fallback = 7000) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        const normalized = Math.round(parsed);
        const options = [7000, 10000, 15000, 30000];
        if (options.includes(normalized)) return normalized;
        if (normalized < options[0]) return options[0];
        return options[options.length - 1];
    };

    const normalizeSyncProjectColorStyle = (value) => {
        const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if (candidate === 'pill' || candidate === 'row') {
            return candidate;
        }
        return 'pill';
    };

    const normalizeGreenshotDelay = (value) => {
        const raw = (value ?? '').toString().trim();
        if (!raw) return 350;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return 350;
        return Math.max(0, Math.round(parsed));
    };

    const normalizeGreenshotEnabled = (value, path = '') => {
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
                return true;
            }
            if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
                return false;
            }
        }
        return Boolean((path ?? '').toString().trim());
    };

    const normalizeOfficePreviewQuality = (value, fallback = DEFAULT_OFFICE_PREVIEW_QUALITY) => {
        const text = (value ?? '').toString().trim().toLowerCase();
        if (text === 'fast' || text === 'standard') {
            return text;
        }
        return fallback === 'fast' ? 'fast' : 'standard';
    };

    const updateGreenshotConfigVisibility = (enabled) => {
        if (!greenshotConfigContainer) return;
        const visible = !!enabled;
        greenshotConfigContainer.classList.toggle('d-none', !visible);
        greenshotConfigContainer.setAttribute('aria-hidden', visible ? 'false' : 'true');
    };

    const getDesignModeSelection = () => {
        let selected = state.designMode === 'compact' ? 'compact' : 'expanded';
        designModeInputs.forEach((input) => {
            if (input.checked) {
                selected = input.value === 'compact' ? 'compact' : 'expanded';
            }
        });
        return selected;
    };

    const collectSettingsSnapshot = () => {
        const settings = state.settings || {};
        const projects = settings.projects || {};
        const mergeDefaults = settings.mergeDefaults || {};
        const greenshot = settings.greenshot || {};
        const screenshot = settings.screenshot || {};
        const tags = settings.tags || {};
        const notePreviewLines = normalizeNotePreviewLines(
            projectsNoteLinesInput ? projectsNoteLinesInput.value : projects.notePreviewLines,
        );
        return {
            theme: draftTheme || state.theme,
            designMode: getDesignModeSelection(),
            softDelete: softToggle ? !!softToggle.checked : !!settings.softDelete,
            sidebarCompactLocked: sidebarCompactLockToggle
                ? !!sidebarCompactLockToggle.checked
                : state.sidebarCompactLocked === true,
            screenshotPromptDetails: screenshotPromptToggle
                ? !!screenshotPromptToggle.checked
                : !!screenshot.promptDetails,
            tagsHierarchyView: tagsHierarchyToggle ? !!tagsHierarchyToggle.checked : !!tags.hierarchyView,
            officePreviewQuality: normalizeOfficePreviewQuality(
                officePreviewQualityInput?.value,
                settings.preview?.officeQuality || DEFAULT_OFFICE_PREVIEW_QUALITY,
            ),
            mergeDefaults: {
                paperSize: mergePaperInput?.value || mergeDefaults.paperSize,
                orientation: mergeOrientationInput?.value || mergeDefaults.orientation,
                margin: normalizeMergeMargin(mergeMarginInput?.value, mergeDefaults.margin ?? 10),
                fit: mergeFitInput?.value || mergeDefaults.fit,
                phraseAlignment: mergeAlignmentInput?.value || mergeDefaults.phraseAlignment,
                pageNumbers: mergePageNumbersToggle ? !!mergePageNumbersToggle.checked : !!mergeDefaults.pageNumbers,
                captionFontSizePt: normalizeMergeCaptionSize(
                    mergeDefaults.captionFontSizePt,
                    DEFAULT_MERGE_PHRASE_FONT_SIZE_PT,
                ),
            },
            greenshot: {
                path: (greenshotPathInput?.value ?? greenshot.path ?? '').trim(),
                hotkey: (greenshotHotkeyInput?.value ?? greenshot.hotkey ?? '').trim(),
                delay: normalizeGreenshotDelay(greenshotDelayInput?.value ?? greenshot.delay),
                enabled: greenshotEnabledToggle
                    ? !!greenshotEnabledToggle.checked
                    : normalizeGreenshotEnabled(greenshot.enabled, greenshot.path),
            },
            projects: {
                nestedView: nestedProjectsToggle ? !!nestedProjectsToggle.checked : !!projects.nestedView,
                includeChildEntries: includeProjectChildrenToggle
                    ? !!includeProjectChildrenToggle.checked
                    : !!projects.includeChildEntries,
                timelineOpenTaskOnClick: timelineOpenOnClickToggle
                    ? !!timelineOpenOnClickToggle.checked
                    : !!projects.timelineOpenTaskOnClick,
                compactTaskPreview: compactTaskPreviewToggle
                    ? !!compactTaskPreviewToggle.checked
                    : projects.compactTaskPreview !== false,
                projectColorStyle: projectColorStyleSelect?.value || projects.projectColorStyle || 'pill',
                timelineHierarchyLinkStyle:
                    timelineHierarchyLinksSelect?.value || projects.timelineHierarchyLinkStyle || 'hover',
                notePreviewLines,
                timelineShowBarLabels: timelineSettingBarLabels
                    ? !!timelineSettingBarLabels.checked
                    : !!projects.timelineShowBarLabels,
                timelineHighlightRows: timelineSettingHighlightRows
                    ? !!timelineSettingHighlightRows.checked
                    : !!projects.timelineHighlightRows,
                taskHierarchyView: timelineHierarchyEnabled
                    ? !!timelineHierarchyEnabled.checked
                    : !!projects.taskHierarchyView,
            },
            syncManager: {
                autoRefreshEnabled: syncAutoRefreshToggle
                    ? !!syncAutoRefreshToggle.checked
                    : state.settings?.syncManager?.autoRefreshEnabled !== false,
                autoRefreshIntervalMs: normalizeSyncRefreshInterval(
                    syncAutoRefreshInterval?.value ?? state.settings?.syncManager?.autoRefreshIntervalMs ?? 7000,
                    state.settings?.syncManager?.autoRefreshIntervalMs ?? 7000,
                ),
                showAdvancedRowActions: syncAdvancedRowActionsToggle
                    ? !!syncAdvancedRowActionsToggle.checked
                    : !!state.settings?.syncManager?.showAdvancedRowActions,
                projectColorStyle: normalizeSyncProjectColorStyle(
                    syncProjectColorStyle?.value ?? state.settings?.syncManager?.projectColorStyle ?? 'pill',
                ),
                activityPanelVisibleByDefault: syncActivityPanelVisibleToggle
                    ? !!syncActivityPanelVisibleToggle.checked
                    : state.settings?.syncManager?.activityPanelVisibleByDefault !== false,
            },
        };
    };

    const updateSaveButtonState = () => {
        if (!saveButton) return;
        if (!settingsBaseline) {
            saveButton.disabled = true;
            return;
        }
        const next = JSON.stringify(collectSettingsSnapshot());
        saveButton.disabled = next === settingsBaseline;
    };

    const openPortableDataDir = async () => {
        if (!openDataDirButton) return;
        openDataDirButton.disabled = true;
        if (dataDirStatus) {
            dataDirStatus.textContent = 'Opening data folder...';
        }
        try {
            await requestJson('/api/portable/open_data_dir', { method: 'POST' });
            if (dataDirStatus) {
                dataDirStatus.textContent = 'Opened in the system file explorer.';
            }
            showToast('Opened data folder.');
        } catch (error) {
            const message = error?.message || 'Unable to open the data folder.';
            if (dataDirStatus) {
                dataDirStatus.textContent = message;
            }
            showToast(message);
        } finally {
            openDataDirButton.disabled = false;
        }
    };

    const applySettingsSnapshot = (snapshot) => {
        if (!snapshot) return;
        const prev = {
            theme: state.theme,
            designMode: state.designMode,
            sidebarCompactLocked: state.sidebarCompactLocked === true,
            screenshotPromptDetails: !!state.settings?.screenshot?.promptDetails,
            tagsHierarchyView: !!state.settings?.tags?.hierarchyView,
            officePreviewQuality: normalizeOfficePreviewQuality(
                state.settings?.preview?.officeQuality,
                DEFAULT_OFFICE_PREVIEW_QUALITY,
            ),
            greenshotEnabled: normalizeGreenshotEnabled(
                state.settings?.greenshot?.enabled,
                state.settings?.greenshot?.path || '',
            ),
            projects: {
                nestedView: !!state.settings?.projects?.nestedView,
                includeChildEntries: !!state.settings?.projects?.includeChildEntries,
                compactTaskPreview: state.settings?.projects?.compactTaskPreview !== false,
                projectColorStyle: state.settings?.projects?.projectColorStyle || 'pill',
                timelineHierarchyLinkStyle: state.settings?.projects?.timelineHierarchyLinkStyle || 'hover',
                notePreviewLines: state.settings?.projects?.notePreviewLines ?? 1,
                timelineShowBarLabels: !!state.settings?.projects?.timelineShowBarLabels,
                timelineHighlightRows: !!state.settings?.projects?.timelineHighlightRows,
                taskHierarchyView: !!state.settings?.projects?.taskHierarchyView,
            },
            syncManager: {
                autoRefreshEnabled: state.settings?.syncManager?.autoRefreshEnabled !== false,
                autoRefreshIntervalMs: normalizeSyncRefreshInterval(
                    state.settings?.syncManager?.autoRefreshIntervalMs,
                    7000,
                ),
                showAdvancedRowActions: !!state.settings?.syncManager?.showAdvancedRowActions,
                projectColorStyle: normalizeSyncProjectColorStyle(state.settings?.syncManager?.projectColorStyle),
                activityPanelVisibleByDefault: state.settings?.syncManager?.activityPanelVisibleByDefault !== false,
            },
        };

        const settings = state.settings || {};
        state.settings = settings;
        settings.mergeDefaults = {
            paperSize: snapshot.mergeDefaults.paperSize,
            orientation: snapshot.mergeDefaults.orientation,
            margin: snapshot.mergeDefaults.margin,
            fit: snapshot.mergeDefaults.fit,
            phraseAlignment: snapshot.mergeDefaults.phraseAlignment,
            pageNumbers: snapshot.mergeDefaults.pageNumbers,
            captionFontSizePt: normalizeMergeCaptionSize(
                snapshot.mergeDefaults.captionFontSizePt,
                DEFAULT_MERGE_PHRASE_FONT_SIZE_PT,
            ),
        };
        settings.softDelete = snapshot.softDelete;
        settings.greenshot = {
            path: (snapshot.greenshot.path || '').trim(),
            hotkey: snapshot.greenshot.hotkey,
            delay: snapshot.greenshot.delay,
            enabled: normalizeGreenshotEnabled(snapshot.greenshot.enabled, snapshot.greenshot.path),
        };
        settings.preview = settings.preview || {};
        settings.preview.officeQuality = normalizeOfficePreviewQuality(
            snapshot.officePreviewQuality,
            settings.preview.officeQuality || DEFAULT_OFFICE_PREVIEW_QUALITY,
        );
        settings.screenshot = settings.screenshot || {};
        settings.screenshot.promptDetails = snapshot.screenshotPromptDetails;
        settings.tags = settings.tags || {};
        settings.tags.hierarchyView = snapshot.tagsHierarchyView;
        settings.projects = settings.projects || {};
        settings.projects.nestedView = snapshot.projects.nestedView;
        settings.projects.includeChildEntries = snapshot.projects.includeChildEntries;
        settings.projects.timelineOpenTaskOnClick = snapshot.projects.timelineOpenTaskOnClick;
        settings.projects.compactTaskPreview = snapshot.projects.compactTaskPreview;
        settings.projects.projectColorStyle = snapshot.projects.projectColorStyle;
        settings.projects.timelineHierarchyLinkStyle = snapshot.projects.timelineHierarchyLinkStyle;
        settings.projects.notePreviewLines = snapshot.projects.notePreviewLines;
        settings.projects.timelineShowBarLabels = snapshot.projects.timelineShowBarLabels;
        settings.projects.timelineHighlightRows = snapshot.projects.timelineHighlightRows;
        settings.projects.taskHierarchyView = snapshot.projects.taskHierarchyView;
        settings.syncManager = {
            autoRefreshEnabled: snapshot.syncManager.autoRefreshEnabled,
            autoRefreshIntervalMs: normalizeSyncRefreshInterval(snapshot.syncManager.autoRefreshIntervalMs, 7000),
            showAdvancedRowActions: snapshot.syncManager.showAdvancedRowActions,
            projectColorStyle: normalizeSyncProjectColorStyle(snapshot.syncManager.projectColorStyle),
            activityPanelVisibleByDefault: snapshot.syncManager.activityPanelVisibleByDefault,
        };

        if (projectsNoteLinesInput) {
            projectsNoteLinesInput.value = snapshot.projects.notePreviewLines;
        }
        if (greenshotDelayInput) {
            greenshotDelayInput.value = snapshot.greenshot.delay;
        }
        if (greenshotEnabledToggle) {
            greenshotEnabledToggle.checked = !!settings.greenshot.enabled;
        }
        if (officePreviewQualityInput) {
            officePreviewQualityInput.value = settings.preview.officeQuality;
        }
        updateGreenshotConfigVisibility(settings.greenshot.enabled);

        const nextTheme = snapshot.theme || state.theme;
        if (nextTheme !== state.theme) {
            applyTheme(nextTheme);
        }
        draftTheme = nextTheme;

        const nextDesignMode = snapshot.designMode || state.designMode;
        if (nextDesignMode !== state.designMode) {
            state.designMode = nextDesignMode;
            document.dispatchEvent(new CustomEvent('qualifile:design-mode', { detail: { mode: nextDesignMode } }));
        }

        const nextSidebarLocked = !!snapshot.sidebarCompactLocked;
        if (state.sidebarCompactLocked !== nextSidebarLocked) {
            state.sidebarCompactLocked = nextSidebarLocked;
            if (state.sidebarCompactLocked) {
                state.sidebarPinned = false;
            }
            document.dispatchEvent(
                new CustomEvent('qualifile:sidebar-compact-lock', {
                    detail: { locked: state.sidebarCompactLocked },
                }),
            );
        }

        if (prev.tagsHierarchyView !== snapshot.tagsHierarchyView) {
            document.dispatchEvent(
                new CustomEvent('qualifile:tags-hierarchy-view-changed', {
                    detail: { enabled: snapshot.tagsHierarchyView },
                }),
            );
        }

        if (prev.greenshotEnabled !== settings.greenshot.enabled) {
            document.dispatchEvent(
                new CustomEvent('qualifile:greenshot-enabled-changed', {
                    detail: { enabled: settings.greenshot.enabled },
                }),
            );
        }

        if (prev.projects.nestedView !== snapshot.projects.nestedView) {
            document.dispatchEvent(
                new CustomEvent('qualifile:projects-nested-view', {
                    detail: { enabled: snapshot.projects.nestedView },
                }),
            );
        }
        if (prev.projects.includeChildEntries !== snapshot.projects.includeChildEntries) {
            document.dispatchEvent(
                new CustomEvent('qualifile:projects-include-children', {
                    detail: { enabled: snapshot.projects.includeChildEntries },
                }),
            );
        }
        if (prev.projects.compactTaskPreview !== snapshot.projects.compactTaskPreview) {
            document.dispatchEvent(
                new CustomEvent('qualifile:projects-compact-task-preview', {
                    detail: { enabled: snapshot.projects.compactTaskPreview },
                }),
            );
        }
        if (prev.projects.projectColorStyle !== snapshot.projects.projectColorStyle) {
            document.dispatchEvent(
                new CustomEvent('qualifile:projects-color-style', {
                    detail: { style: snapshot.projects.projectColorStyle },
                }),
            );
        }
        if (
            prev.projects.timelineHierarchyLinkStyle !== snapshot.projects.timelineHierarchyLinkStyle
        ) {
            document.dispatchEvent(
                new CustomEvent('qualifile:timeline-hierarchy-links', {
                    detail: { style: snapshot.projects.timelineHierarchyLinkStyle },
                }),
            );
        }
        if (prev.projects.notePreviewLines !== snapshot.projects.notePreviewLines) {
            document.dispatchEvent(
                new CustomEvent('qualifile:projects-note-lines', {
                    detail: { lines: snapshot.projects.notePreviewLines },
                }),
            );
        }
        if (
            prev.projects.timelineShowBarLabels !== snapshot.projects.timelineShowBarLabels ||
            prev.projects.timelineHighlightRows !== snapshot.projects.timelineHighlightRows
        ) {
            document.dispatchEvent(
                new CustomEvent('qualifile:projects-timeline-ui', {
                    detail: {
                        showBarLabels: snapshot.projects.timelineShowBarLabels,
                        highlightRows: snapshot.projects.timelineHighlightRows,
                    },
                }),
            );
        }
        if (prev.projects.taskHierarchyView !== snapshot.projects.taskHierarchyView) {
            document.dispatchEvent(
                new CustomEvent('qualifile:projects-task-hierarchy', {
                    detail: { enabled: snapshot.projects.taskHierarchyView },
                }),
            );
        }

        if (
            prev.syncManager.autoRefreshEnabled !== settings.syncManager.autoRefreshEnabled
            || prev.syncManager.autoRefreshIntervalMs !== settings.syncManager.autoRefreshIntervalMs
            || prev.syncManager.showAdvancedRowActions !== settings.syncManager.showAdvancedRowActions
            || prev.syncManager.projectColorStyle !== settings.syncManager.projectColorStyle
            || prev.syncManager.activityPanelVisibleByDefault !== settings.syncManager.activityPanelVisibleByDefault
        ) {
            document.dispatchEvent(
                new CustomEvent('qualifile:sync-manager-settings', {
                    detail: { ...settings.syncManager },
                }),
            );
        }
    };

    const setDraftTheme = (nextTheme) => {
        draftTheme = nextTheme;
        updateThemeButtons(nextTheme);
        updateSaveButtonState();
    };

    const openUserGuide = () => {
        const url = `${window.location.origin}/user_tutorial/`;
        try {
            window.open(url, '_blank', 'noopener');
            showToast('Opened the user guide.');
        } catch (error) {
            showToast('Unable to open the user guide.', true);
        }
        requestJson('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'User opened tutorial from settings', source: 'settings' }),
        }).catch(() => {});
    };

    modal.addEventListener('input', updateSaveButtonState);
    modal.addEventListener('change', updateSaveButtonState);

    openUserGuideButton?.addEventListener('click', openUserGuide);

    modal.querySelector('[data-folder-picker="settings-root"]')?.addEventListener('click', async () => {
        try {
            const initial = rootInput.value.trim() || '.';
            const selected = await openFolderPicker({ initialPath: initial, title: 'Select root folder', absolute: true, mode: 'system' });
            if (selected) {
                rootInput.value = selected;
            }
        } catch (error) {
            handleError(error);
        }
    });

    function activateSettingsPane(paneId) {
        const target = Array.from(panes).find((pane) => pane.dataset.settingsPane === paneId) || panes[0];
        if (!target) return;
        panes.forEach((pane) => {
            const isActive = pane === target;
            pane.classList.toggle('is-active', isActive);
            pane.hidden = !isActive;
        });
        navItems.forEach((item) => {
            const isActive = item.dataset.settingsNav === target.dataset.settingsPane;
            item.classList.toggle('active', isActive);
            item.setAttribute('aria-current', isActive ? 'true' : 'false');
        });
        state.settingsPanel.activeSection = target.dataset.settingsPane;
        persistPreferences();
        const content = modal.querySelector('.settings-content');
        if (content) {
            content.scrollTop = 0;
        }
    }

    function renderTagManagement() {
        if (!tagListElement) return;
        const tags = Array.isArray(state.tags) ? state.tags : [];
        const searchTerm = (tagSearchInput?.value || '').trim().toLowerCase();
        if (tagLimitIndicator) {
            tagLimitIndicator.textContent = `${tags.length} / 50 tags used`;
        }
        if (tagCreateButton) {
            tagCreateButton.disabled = tags.length >= 50;
        }
        if (tagNameInput) {
            tagNameInput.disabled = tags.length >= 50;
        }
        tagListElement.innerHTML = '';
        if (!tags.length) {
            const empty = document.createElement('p');
            empty.className = 'text-muted mb-0';
            empty.textContent = 'No tags yet. Create one to get started.';
            tagListElement.appendChild(empty);
            return;
        }

        const relations = buildTagRelations(tags);
        tagRelationsCache = relations;
        const tagById = new Map(tags.map((t) => [t.id, t]));
        let renderedCount = 0;

        tags.forEach((tag) => {
            if (!tag?.id) return;
            const nameMatch = (tag.name || '').toLowerCase().includes(searchTerm);
            if (searchTerm && !nameMatch) return;
            renderedCount += 1;

            const row = document.createElement('div');
            row.className = 'tag-row border rounded p-3 position-relative';
            row.dataset.tagId = tag.id;
            const depth = relations.depth.get(tag.id) || 0;
            row.dataset.depth = depth;

            const header = document.createElement('div');
            header.className = 'tag-row-header';

            const dragHandle = document.createElement('button');
            dragHandle.type = 'button';
            dragHandle.className = 'btn btn-link p-0 tag-drag-handle';
            dragHandle.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <circle cx="8" cy="7" r="1.4"></circle>
                    <circle cx="8" cy="12" r="1.4"></circle>
                    <circle cx="8" cy="17" r="1.4"></circle>
                    <circle cx="14" cy="7" r="1.4"></circle>
                    <circle cx="14" cy="12" r="1.4"></circle>
                    <circle cx="14" cy="17" r="1.4"></circle>
                </svg>
            `;
            dragHandle.draggable = true;
            dragHandle.addEventListener('dragstart', (event) => {
                draggingTagId = tag.id;
                event.dataTransfer?.setData('text/plain', tag.id);
                if (event.dataTransfer) {
                    event.dataTransfer.effectAllowed = 'move';
                }
            });
            dragHandle.addEventListener('dragend', () => {
                draggingTagId = null;
                clearDragHighlights();
            });

            const parentSelect = document.createElement('select');
            parentSelect.className = 'form-select form-select-sm tag-parent-select flex-grow-1';
            parentSelect.dataset.tagId = tag.id;
            parentSelect.dataset.lastValue = tag.parent_id || '';
            const noneOption = new Option('No parent', '', !tag.parent_id, !tag.parent_id);
            parentSelect.appendChild(noneOption);
            const invalidParents = new Set(relations.descendants.get(tag.id) || []);
            invalidParents.add(tag.id);
            const sortedOptions = [...tags]
                .filter((candidate) => candidate.id !== tag.id)
                .sort((a, b) => a.name.localeCompare(b.name));
            sortedOptions.forEach((candidate) => {
                const option = new Option(candidate.name, candidate.id, false, candidate.id === tag.parent_id);
                if (invalidParents.has(candidate.id)) {
                    option.disabled = true;
                }
                parentSelect.appendChild(option);
            });
            const parentFeedback = document.createElement('div');
            parentFeedback.className = 'invalid-feedback d-block small text-danger d-none';
            parentSelect.addEventListener('change', () => {
                void handleTagParentChange(tag.id, parentSelect, parentFeedback);
            });

            const visibilityGroup = document.createElement('div');
            visibilityGroup.className = 'form-check form-switch mb-0';
            const visibilityInput = document.createElement('input');
            visibilityInput.type = 'checkbox';
            visibilityInput.className = 'form-check-input';
            visibilityInput.id = `tag-visibility-${tag.id}`;
            visibilityInput.checked = tag.show_header !== false;
            visibilityInput.addEventListener('change', () => {
                void handleTagVisibilityChange(tag.id, visibilityInput.checked);
            });
            const visibilityLabel = document.createElement('label');
            visibilityLabel.className = 'form-check-label small';
            visibilityLabel.setAttribute('for', visibilityInput.id);
            visibilityLabel.textContent = 'Header';
            visibilityGroup.append(visibilityInput, visibilityLabel);

            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'btn btn-outline-danger btn-sm tag-delete-btn';
            deleteButton.setAttribute('aria-label', `Delete tag ${tag.name}`);
            deleteButton.innerHTML = `
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                    <path d="M6 7h12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                    <path d="M10 7V5h4v2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                    <rect x="7" y="7" width="10" height="12" rx="1.25" ry="1.25" fill="none" stroke="currentColor" stroke-width="1.6"/>
                    <path d="M10 11v5M14 11v5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                </svg>
            `;
            deleteButton.addEventListener('click', () => {
                openTagDeleteModal(tag.id, tag.name);
            });

            const actions = document.createElement('div');
            actions.className = 'tag-row-actions';
            actions.append(visibilityGroup, deleteButton);

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'form-control form-control-sm tag-name-input flex-grow-1';
            nameInput.value = tag.name;
            nameInput.maxLength = 60;
            nameInput.dataset.initialValue = tag.name;
            nameInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    nameInput.blur();
                }
            });
            nameInput.addEventListener('blur', () => {
                void handleTagNameChange(tag.id, nameInput);
            });
            parentFeedback.classList.add('w-100', 'mb-0');

            header.append(dragHandle, nameInput, parentSelect, actions);
            row.appendChild(header);
            row.appendChild(parentFeedback);

            const divider = document.createElement('div');
            divider.className = 'tag-row-divider';
            row.appendChild(divider);

            const footer = document.createElement('div');
            footer.className = 'tag-row-footer d-flex flex-wrap align-items-center gap-2';
            const palette = document.createElement('div');
            palette.className = 'tag-color-palette';
            const currentColor = (tag.color || '').toLowerCase();
            TAG_COLOR_PALETTE.forEach((color) => {
                const swatch = document.createElement('button');
                swatch.type = 'button';
                swatch.className = 'tag-color-swatch';
                swatch.style.setProperty('--tag-color', color);
                if (color.toLowerCase() === currentColor) {
                    swatch.classList.add('is-active');
                }
                swatch.addEventListener('click', () => {
                    void handleTagColorChange(tag.id, color);
                });
                palette.appendChild(swatch);
            });
            const customWrapper = document.createElement('div');
            customWrapper.className = 'tag-color-custom d-flex align-items-center gap-2';
            const customLabel = document.createElement('span');
            customLabel.className = 'small text-muted';
            customLabel.textContent = 'Custom';
            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.className = 'form-control form-control-color form-control-sm flex-shrink-0';
            colorInput.value = tag.color || '#6c757d';
            colorInput.addEventListener('change', (event) => {
                void handleTagColorChange(tag.id, event.target.value);
            });
            customWrapper.append(customLabel, colorInput);

            const metaRow = document.createElement('div');
            metaRow.className = 'ms-auto small text-muted';
            const childCount = (relations.children.get(tag.id) || []).length;
            const childHint = document.createElement('span');
            childHint.textContent = `Children: ${childCount}`;
            metaRow.appendChild(childHint);

            footer.append(palette, customWrapper, metaRow);
            row.appendChild(footer);

            row.addEventListener('dragover', (event) => {
                if (!draggingTagId) return;
                const invalid = draggingTagId === tag.id || (tagRelationsCache?.descendants.get(draggingTagId) || new Set()).has(tag.id);
                event.preventDefault();
                row.classList.toggle('tag-drop-target-valid', !invalid);
                row.classList.toggle('tag-drop-target-invalid', invalid);
            });
            row.addEventListener('dragleave', () => {
                row.classList.remove('tag-drop-target-valid', 'tag-drop-target-invalid');
            });
            row.addEventListener('drop', (event) => {
                if (!draggingTagId) return;
                event.preventDefault();
                const invalid = draggingTagId === tag.id || (tagRelationsCache?.descendants.get(draggingTagId) || new Set()).has(tag.id);
                row.classList.remove('tag-drop-target-valid', 'tag-drop-target-invalid');
                if (invalid) {
                    showToast('Cannot set parent to itself or its descendant.', true);
                    return;
                }
                void applyTagParent(draggingTagId, tag.id);
            });

            tagListElement.appendChild(row);
        });

        if (!renderedCount) {
            const empty = document.createElement('p');
            empty.className = 'text-muted mb-0';
            empty.textContent = 'No matching tags.';
            tagListElement.appendChild(empty);
        }

        if (tagRootDropZone && !tagRootDropZone.dataset.bound) {
            tagRootDropZone.dataset.bound = '1';
            tagRootDropZone.addEventListener('dragover', (event) => {
                if (!draggingTagId) return;
                event.preventDefault();
                tagRootDropZone.classList.add('tag-drop-target-valid');
                tagRootDropZone.classList.remove('tag-drop-target-invalid');
            });
            tagRootDropZone.addEventListener('dragleave', () => {
                tagRootDropZone.classList.remove('tag-drop-target-valid', 'tag-drop-target-invalid');
            });
            tagRootDropZone.addEventListener('drop', (event) => {
                if (!draggingTagId) return;
                event.preventDefault();
                tagRootDropZone.classList.remove('tag-drop-target-valid', 'tag-drop-target-invalid');
                void applyTagParent(draggingTagId, null);
            });
        }
    }

    async function handleTagNameChange(tagId, input) {
        const next = input.value.trim();
        const initial = input.dataset.initialValue || '';
        if (!next || next === initial) {
            input.value = next || initial;
            return;
        }
        try {
            setStatus('Updating tagâ€¦');
            const payload = await updateTagDefinition(tagId, { name: next });
            if (Array.isArray(payload?.tags)) {
                state.tags = payload.tags;
            }
            input.dataset.initialValue = next;
            showToast('Tag renamed');
            renderTagManagement();
        } catch (error) {
            handleError(error);
            input.value = initial;
        } finally {
            setStatus('Saved/Idle');
        }
    }

    
    async function handleTagColorChange(tagId, color) {
        if (!color) return;
        try {
            setStatus('Updating tag...');
            const payload = await updateTagDefinition(tagId, { color });
            if (Array.isArray(payload?.tags)) {
                state.tags = payload.tags;
            }
            showToast('Tag color updated');
            renderTagManagement();
        } catch (error) {
            handleError(error);
        } finally {
            setStatus('Saved/Idle');
        }
    }

    async function handleTagVisibilityChange(tagId, showHeader) {
        try {
            setStatus('Updating tag...');
            const payload = await updateTagDefinition(tagId, { show_header: !!showHeader });
            if (Array.isArray(payload?.tags)) {
                state.tags = payload.tags;
            }
            showToast('Tag visibility updated');
            renderTagManagement();
        } catch (error) {
            handleError(error);
        } finally {
            setStatus('Saved/Idle');
        }
    }

    async function applyTagParent(tagId, parentId, { onError } = {}) {
        try {
            setStatus('Updating tag...');
            const payload = await updateTagDefinition(tagId, { parent_id: parentId });
            if (Array.isArray(payload?.tags)) {
                state.tags = payload.tags;
            }
            renderTagManagement();
            document.dispatchEvent(new CustomEvent('qualifile:tags-updated'));
            showToast('Tag parent updated');
        } catch (error) {
            onError?.(error);
            handleError(error);
        } finally {
            setStatus('Saved/Idle');
        }
    }

    async function handleTagParentChange(tagId, select, feedback) {
        const previous = select?.dataset?.lastValue ?? '';
        if (feedback) {
            feedback.classList.add('d-none');
            feedback.textContent = '';
        }
        const next = select?.value || null;
        await applyTagParent(tagId, next, {
            onError: (error) => {
                if (select) {
                    select.value = previous;
                }
                if (feedback) {
                    feedback.textContent = error.message || 'Unable to update parent.';
                    feedback.classList.remove('d-none');
                }
            },
        });
        if (select) {
            select.dataset.lastValue = next || '';
        }
    }

    function openTagDeleteModal(tagId, tagName) {
        pendingTagDelete = { tagId, tagName };
        if (tagDeleteNameLabel) {
            tagDeleteNameLabel.textContent = tagName || 'This tag';
        }
        if (tagDeleteChildrenLabel) {
            const childCount = (tagRelationsCache?.children.get(tagId) || []).length;
            if (childCount > 0) {
                tagDeleteChildrenLabel.classList.remove('d-none');
                tagDeleteChildrenLabel.textContent = `This tag has ${childCount} child tag${childCount === 1 ? '' : 's'}. They will be moved to root.`;
            } else {
                tagDeleteChildrenLabel.classList.add('d-none');
                tagDeleteChildrenLabel.textContent = '';
            }
        }
        if (tagDeleteModal) {
            bootstrap.Modal.getOrCreateInstance(tagDeleteModal).show();
        } else {
            void handleTagDelete(tagId, tagName);
        }
    }

    async function handleTagDelete(tagId, tagName) {
        try {
            setStatus('Deleting tag...');
            const payload = await deleteTagDefinition(tagId);
            if (Array.isArray(payload?.tags)) {
                state.tags = payload.tags;
            }
            if (payload?.assignments) {
                state.tagAssignments = payload.assignments;
            }
            renderTagManagement();
            showToast(`Tag "${tagName || 'Tag'}" deleted.`);
            document.dispatchEvent(new CustomEvent('qualifile:tags-updated'));
        } catch (error) {
            handleError(error);
        } finally {
            setStatus('Saved/Idle');
            if (tagDeleteModal) {
                bootstrap.Modal.getOrCreateInstance(tagDeleteModal).hide();
            }
            pendingTagDelete = null;
        }
    }

function focusSettingsSection(sectionId) {
        activateSettingsPane(sectionId || state.settingsPanel.activeSection || 'general');
        const activePane = Array.from(panes).find((pane) => pane.classList.contains('is-active'));
        activePane?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    navItems.forEach((item) => {
        item.addEventListener('click', () => {
            activateSettingsPane(item.dataset.settingsNav);
        });
    });
    activateSettingsPane(state.settingsPanel.activeSection || 'general');
    updateThemeButtons(state.theme);

    if (tagDeleteModal) {
        tagDeleteModal.addEventListener('hidden.bs.modal', () => {
            pendingTagDelete = null;
        });
    }

    if (tagDeleteConfirmButton) {
        tagDeleteConfirmButton.addEventListener('click', () => {
            if (!pendingTagDelete) return;
            void handleTagDelete(pendingTagDelete.tagId, pendingTagDelete.tagName);
        });
    }

    designModeInputs.forEach((input) => {
        input.addEventListener('change', updateSaveButtonState);
    });

    if (sidebarCompactLockToggle) {
        sidebarCompactLockToggle.addEventListener('change', updateSaveButtonState);
    }

    document.addEventListener('qualifile:theme-change', (event) => {
        const nextTheme = event.detail?.theme || state.theme;
        draftTheme = nextTheme;
        updateThemeButtons(nextTheme);
        updateSaveButtonState();
    });

    if (tagsHierarchyToggle) {
        tagsHierarchyToggle.addEventListener('change', updateSaveButtonState);
    }
    if (syncAutoRefreshToggle) {
        syncAutoRefreshToggle.addEventListener('change', () => {
            if (syncAutoRefreshInterval) {
                syncAutoRefreshInterval.disabled = !syncAutoRefreshToggle.checked;
            }
            updateSaveButtonState();
        });
    }
    if (greenshotEnabledToggle) {
        greenshotEnabledToggle.addEventListener('change', () => {
            updateGreenshotConfigVisibility(greenshotEnabledToggle.checked);
            updateSaveButtonState();
        });
    }

    tagCreateForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const value = tagNameInput?.value?.trim() || '';
        if (!value) {
            if (tagNameFeedback) {
                tagNameFeedback.textContent = 'Enter a name for the tag.';
            }
            tagNameInput?.classList.add('is-invalid');
            return;
        }
        try {
            setStatus('Creating tagâ€¦');
            const payload = await createTagDefinition(value);
            if (Array.isArray(payload?.tags)) {
                state.tags = payload.tags;
            }
            if (tagNameInput) {
                tagNameInput.value = '';
                tagNameInput.classList.remove('is-invalid');
            }
            if (tagNameFeedback) {
                tagNameFeedback.textContent = '';
            }
            showToast('Tag created');
            renderTagManagement();
        } catch (error) {
            if (tagNameFeedback) {
                tagNameFeedback.textContent = error.message || 'Unable to create tag.';
            }
            tagNameInput?.classList.add('is-invalid');
            handleError(error);
        } finally {
            setStatus('Saved/Idle');
        }
    });

    tagNameInput?.addEventListener('input', () => {
        tagNameInput.classList.remove('is-invalid');
        if (tagNameFeedback) {
            tagNameFeedback.textContent = '';
        }
    });

    modal.addEventListener('show.bs.modal', () => {
        draftTheme = state.theme;
        rootInput.value = state.root || '';
        softToggle.checked = state.settings.softDelete;
        document.getElementById('settings-merge-paper').value = state.settings.mergeDefaults.paperSize;
        document.getElementById('settings-merge-orientation').value = state.settings.mergeDefaults.orientation;
        document.getElementById('settings-merge-margin').value = state.settings.mergeDefaults.margin;
        document.getElementById('settings-merge-fit').value = state.settings.mergeDefaults.fit;
        document.getElementById('settings-merge-alignment').value = state.settings.mergeDefaults.phraseAlignment;
        document.getElementById('settings-merge-page-numbers').checked = Boolean(state.settings.mergeDefaults.pageNumbers);
        if (officePreviewQualityInput) {
            officePreviewQualityInput.value = (state.settings.preview?.officeQuality || DEFAULT_OFFICE_PREVIEW_QUALITY);
        }
          document.getElementById('settings-greenshot-path').value = state.settings.greenshot.path || '';
          document.getElementById('settings-greenshot-hotkey').value = state.settings.greenshot.hotkey || '';
          document.getElementById('settings-greenshot-delay').value = state.settings.greenshot.delay ?? 350;
          if (greenshotEnabledToggle) {
              greenshotEnabledToggle.checked = normalizeGreenshotEnabled(
                  state.settings.greenshot.enabled,
                  state.settings.greenshot.path || '',
              );
              updateGreenshotConfigVisibility(greenshotEnabledToggle.checked);
          }
          if (screenshotPromptToggle) {
              screenshotPromptToggle.checked = Boolean(state.settings.screenshot.promptDetails);
          }
          if (tagsHierarchyToggle) {
              tagsHierarchyToggle.checked = Boolean(state.settings.tags?.hierarchyView);
          }
        if (nestedProjectsToggle) {
            nestedProjectsToggle.checked = Boolean(state.settings.projects?.nestedView);
        }
        if (includeProjectChildrenToggle) {
            includeProjectChildrenToggle.checked = Boolean(state.settings.projects?.includeChildEntries);
        }
        if (timelineOpenOnClickToggle) {
            timelineOpenOnClickToggle.checked = Boolean(state.settings.projects?.timelineOpenTaskOnClick);
        }
        if (compactTaskPreviewToggle) {
            compactTaskPreviewToggle.checked = state.settings.projects?.compactTaskPreview !== false;
        }
        if (projectColorStyleSelect) {
            projectColorStyleSelect.value = state.settings.projects?.projectColorStyle || 'pill';
        }
        if (timelineHierarchyLinksSelect) {
            timelineHierarchyLinksSelect.value = state.settings.projects?.timelineHierarchyLinkStyle || 'hover';
        }
        if (projectsNoteLinesInput) {
            const val = state.settings.projects?.notePreviewLines ?? 1;
            projectsNoteLinesInput.value = val;
        }
        if (timelineSettingBarLabels) {
            timelineSettingBarLabels.checked = Boolean(state.settings.projects?.timelineShowBarLabels);
        }
        if (timelineSettingHighlightRows) {
            timelineSettingHighlightRows.checked = Boolean(state.settings.projects?.timelineHighlightRows);
        }
        if (timelineHierarchyEnabled) {
            timelineHierarchyEnabled.checked = Boolean(state.settings.projects?.taskHierarchyView);
        }
        if (syncAutoRefreshToggle) {
            syncAutoRefreshToggle.checked = state.settings.syncManager?.autoRefreshEnabled !== false;
        }
        if (syncAutoRefreshInterval) {
            syncAutoRefreshInterval.value = String(
                normalizeSyncRefreshInterval(state.settings.syncManager?.autoRefreshIntervalMs, 7000),
            );
            syncAutoRefreshInterval.disabled = syncAutoRefreshToggle ? !syncAutoRefreshToggle.checked : false;
        }
        if (syncProjectColorStyle) {
            syncProjectColorStyle.value = normalizeSyncProjectColorStyle(
                state.settings.syncManager?.projectColorStyle,
            );
        }
        if (syncAdvancedRowActionsToggle) {
            syncAdvancedRowActionsToggle.checked = !!state.settings.syncManager?.showAdvancedRowActions;
        }
        if (syncActivityPanelVisibleToggle) {
            syncActivityPanelVisibleToggle.checked = state.settings.syncManager?.activityPanelVisibleByDefault !== false;
        }
        if (tagSearchInput) {
            tagSearchInput.addEventListener('input', renderTagManagement);
        }
        designModeInputs.forEach((input) => {
            input.checked = input.value === state.designMode;
        });
        if (sidebarCompactLockToggle) {
            sidebarCompactLockToggle.checked = state.sidebarCompactLocked === true;
        }
        activateSettingsPane(state.settingsPanel.activeSection || 'general');
        updateThemeButtons(draftTheme);
        settingsBaseline = JSON.stringify(collectSettingsSnapshot());
        updateSaveButtonState();
        renderTagManagement();
        void refreshTagState({ silent: true })
            .then(() => {
                renderTagManagement();
            })
            .catch(() => {});
    });

    modal.addEventListener('shown.bs.modal', () => {
        if (pendingSettingsSectionId) {
            focusSettingsSection(pendingSettingsSectionId);
            pendingSettingsSectionId = null;
        }
    });

    modal.addEventListener('hidden.bs.modal', () => {
        settingsBaseline = '';
        if (saveButton) {
            saveButton.disabled = true;
        }
        draftTheme = state.theme;
    });

    const resetStateAfterRootChange = () => {
        clearSelection();
        updateCurrentPath('.', false);
        state.navigation = { stack: ['.'], index: 0 };
        state.includeSubfolders = false;
        clearPreview();
    };

    applyButton?.addEventListener('click', async () => {
        if (!rootInput.value.trim()) {
            showToast('Enter a path to apply.', true);
            return;
        }
        try {
            setStatus('Updating rootâ€¦');
            const result = await updateRoot(rootInput.value.trim());
            state.root = result.root;
            const appShell = document.getElementById('app');
            if (appShell) {
                appShell.dataset.root = state.root || '.';
            }
            resetStateAfterRootChange();
            bootstrap.Modal.getInstance(modal)?.hide();
            showToast('Root updated');
            requestGlobalRefresh();
        } catch (error) {
            handleError(error);
        } finally {
            setStatus('Saved/Idle');
        }
    });

    clearButton?.addEventListener('click', async () => {
        try {
            await clearRoot();
            state.root = null;
            const appShell = document.getElementById('app');
            if (appShell) {
                appShell.dataset.root = '.';
            }
            resetStateAfterRootChange();
            showToast('Root cleared');
            requestGlobalRefresh();
        } catch (error) {
            handleError(error);
        }
    });

    softToggle?.addEventListener('change', updateSaveButtonState);

    function updateThemeButtons(activeTheme) {
        themeButtons.forEach(({ el, value }) => {
            const isActive = activeTheme === value;
            el.classList.toggle('active-theme', isActive);
            el.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
    }

    themeLight?.addEventListener('click', () => setDraftTheme('light'));
    themeLightPlus?.addEventListener('click', () => setDraftTheme('light+'));
    themeDark?.addEventListener('click', () => setDraftTheme('dark'));
    themeDarkPlus?.addEventListener('click', () => setDraftTheme('dark+'));

    resetLayout?.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('qualifile:reset-layout'));
    });

    copyButton?.addEventListener('click', async () => {
        if (!copyButton) return;
        const originalLabel = copyButton.textContent;
        updateCopyFeedback(copyFeedback, '');
        copyButton.disabled = true;
        copyButton.textContent = 'Copyingâ€¦';
        try {
            if (!tocExtractorScript) {
                const useMinifiedAssets = window.__QUALIFILE__?.useMinifiedAssets === true;
                const tocExtractorPath = useMinifiedAssets
                    ? '../../shared/toc-extractor.min.js'
                    : '../../shared/toc-extractor.js';
                const response = await fetch(new URL(tocExtractorPath, import.meta.url), { cache: 'no-cache' });
                if (!response.ok) {
                    throw new Error('Unable to load TOC extractor script.');
                }
                tocExtractorScript = await response.text();
            }
            await copyTextToClipboard(tocExtractorScript);
            updateCopyFeedback(copyFeedback, 'Code copied to clipboard.', 'success');
            showToast('TOC extractor copied to clipboard');
        } catch (error) {
            tocExtractorScript = null;
            updateCopyFeedback(copyFeedback, 'Unable to copy code. Please try again.', 'error');
            handleError(error);
            showToast('Unable to copy code.', true);
        } finally {
            copyButton.disabled = false;
            copyButton.textContent = originalLabel;
        }
    });

    copyVersionButton?.addEventListener('click', async () => {
        if (!copyVersionButton) return;
        const versionText = (appVersionLabel?.textContent || '').trim();
        if (!versionText) {
            updateCopyFeedback(copyVersionFeedback, 'Version unavailable.', 'error');
            return;
        }
        const originalLabel = copyVersionButton.textContent;
        updateCopyFeedback(copyVersionFeedback, '');
        copyVersionButton.disabled = true;
        copyVersionButton.textContent = 'Copying...';
        try {
            await copyTextToClipboard(versionText);
            updateCopyFeedback(copyVersionFeedback, 'Version copied to clipboard.', 'success');
            showToast('Version copied to clipboard');
        } catch (error) {
            updateCopyFeedback(copyVersionFeedback, 'Unable to copy version.', 'error');
            handleError(error);
            showToast('Unable to copy version.', true);
        } finally {
            copyVersionButton.disabled = false;
            copyVersionButton.textContent = originalLabel;
        }
    });

    openDataDirButton?.addEventListener('click', async () => {
        await openPortableDataDir();
    });

    exitButton?.addEventListener('click', async () => {
        const originalLabel = exitButton.textContent;
        exitButton.disabled = true;
        exitButton.textContent = 'Closing...';
        try {
            setStatus('Shutting down...');
            await shutdownServer();
            showToast('Closing QualiFile. You can close this window.');
        } catch (error) {
            handleError(error);
        } finally {
            exitButton.disabled = false;
            exitButton.textContent = originalLabel;
            setStatus('Saved/Idle');
        }
    });

    clearCacheButton?.addEventListener('click', async () => {
        const confirmed = await showConfirmDialog(
            'This will delete cached preview artifacts. Previews will regenerate when needed. Continue?',
            'Clear preview cache',
        );
        if (!confirmed) return;
        clearCacheButton.disabled = true;
        clearCacheSpinner?.classList.remove('d-none');
        try {
            await requestJson('/api/cache/clear', { method: 'POST', body: JSON.stringify({}) });
            showToast('Cache cleared.');
        } catch (error) {
            handleError(error);
            showToast(error.message || 'Unable to clear cache.', true);
        } finally {
            clearCacheButton.disabled = false;
            clearCacheSpinner?.classList.add('d-none');
        }
    });

    saveButton?.addEventListener('click', async () => {
        const snapshot = collectSettingsSnapshot();
        const currentGreenshotEnabled = normalizeGreenshotEnabled(
            state.settings.greenshot?.enabled,
            state.settings.greenshot?.path || '',
        );
        const currentOfficePreviewQuality = normalizeOfficePreviewQuality(
            state.settings.preview?.officeQuality,
            DEFAULT_OFFICE_PREVIEW_QUALITY,
        );
        if (currentGreenshotEnabled !== !!snapshot.greenshot.enabled) {
            try {
                await setGreenshotIntegrationEnabled(!!snapshot.greenshot.enabled);
            } catch (error) {
                handleError(error);
                showToast('Unable to save Greenshot integration state.', true);
                return;
            }
        }
        if (currentOfficePreviewQuality !== snapshot.officePreviewQuality) {
            try {
                await setOfficePreviewQuality(snapshot.officePreviewQuality);
            } catch (error) {
                handleError(error);
                showToast('Unable to save Office preview quality.', true);
                return;
            }
        }
        applySettingsSnapshot(snapshot);
        persistPreferences();
        settingsBaseline = JSON.stringify(snapshot);
        updateSaveButtonState();
        showToast('Preferences saved');
    });
}

function updateCopyFeedback(element, message, variant) {
    if (!element) return;
    element.textContent = message;
    element.classList.remove('text-success', 'text-danger');
    if (!message) {
        return;
    }
    if (variant === 'success') {
        element.classList.add('text-success');
    } else if (variant === 'error') {
        element.classList.add('text-danger');
    }
}

async function copyTextToClipboard(text) {
    if (navigator?.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch (error) {
            // Fallback to execCommand below.
        }
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let successful = false;
    if (typeof document.execCommand === 'function') {
        successful = document.execCommand('copy');
    }
    document.body.removeChild(textarea);
    if (!successful) {
        throw new Error('Clipboard copy command was not successful.');
    }
}

/** Validate file/folder names for modal forms. */
function validateName(name, feedback) {
    const input = feedback?.previousElementSibling;
    if (!name) {
        feedback.textContent = 'Name is required.';
        input?.classList?.add('is-invalid');
        return false;
    }
    if (/^[.]+$/.test(name) || /[\\/:*?"<>|]/.test(name)) {
        feedback.textContent = 'Name contains invalid characters.';
        input?.classList?.add('is-invalid');
        return false;
    }
    input?.classList?.remove('is-invalid');
    feedback.textContent = '';
    return true;
}

function renderTagSelector(container, { selected = [], idPrefix = 'tag-option' } = {}) {
    if (!container) return;
    container.innerHTML = '';
    const tags = Array.isArray(state.tags) ? state.tags : [];
    container.classList.add('tag-picker');
    if (!tags.length) {
        const empty = document.createElement('p');
        empty.className = 'text-muted mb-0';
        empty.textContent = 'No tags available. Create tags in Settings.';
        container.appendChild(empty);
        return;
    }
    const selectedSet = new Set(selected);
    tags.forEach((tag, index) => {
        if (!tag?.id) return;
        const option = document.createElement('label');
        option.className = 'tag-picker-option';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'form-check-input';
        input.id = `${idPrefix}-${index}`;
        input.value = tag.id;
        input.checked = selectedSet.has(tag.id);
        const swatch = document.createElement('span');
        swatch.className = 'tag-picker-swatch';
        const colors = resolveTagColors(tag.color || '#6c757d');
        swatch.style.setProperty('--tag-color', colors.background);
        swatch.style.setProperty('--tag-color-text', colors.text);
        const name = document.createElement('span');
        name.className = 'tag-picker-label';
        name.textContent = tag.name;
        option.append(input, swatch, name);
        container.appendChild(option);
    });
}

function collectSelectedTags(container) {
    if (!container) return [];
    const values = [];
    container.querySelectorAll('input[type=\"checkbox\"]').forEach((input) => {
        if (input.checked && input.value) {
            values.push(input.value);
        }
    });
    return values;
}

function setupNotesViewModal() {
    notesModalElement = document.getElementById('modal-notes');
    if (!notesModalElement) return;
    notesOpenList = notesModalElement.querySelector('#notes-open-list');
    notesClosedList = notesModalElement.querySelector('#notes-closed-list');
    notesClosedToggle = notesModalElement.querySelector('#notes-closed-toggle');
    notesPriorityBadge = notesModalElement.querySelector('#notes-priority-badge');
    notesDeadlineBadge = notesModalElement.querySelector('#notes-deadline-badge');
    notesTargetName = notesModalElement.querySelector('#notes-target-name');
    notesTargetCrumb = notesModalElement.querySelector('#notes-target-path');
    notesEmptyState = notesModalElement.querySelector('#notes-empty');
    notesClosedSummary = notesModalElement.querySelector('#notes-closed-summary');
    notesModalElement.querySelector('#notes-add-button')?.addEventListener('click', () => {
        openNoteCreateModal(notesTargetPath, notesTargetLabel);
    });
    notesClosedToggle?.setAttribute('aria-expanded', 'false');
    notesClosedToggle?.addEventListener('click', () => {
        if (!notesClosedList) return;
        const expanded = notesClosedList.classList.toggle('d-none');
        notesClosedToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
    notesModalElement.addEventListener('hidden.bs.modal', () => {
        cachedNotes = [];
        notesTargetPath = '.';
        notesTargetLabel = '';
        notesClosedList?.classList.add('d-none');
        notesClosedToggle?.setAttribute('aria-expanded', 'false');
    });
}

export async function openNotesModal(path, label = '') {
    if (!notesModalElement) {
        setupNotesViewModal();
    }
    if (!notesModalElement) return;
    const modalInstance = bootstrap.Modal.getOrCreateInstance(notesModalElement);
    notesTargetPath = normalizePath(path) || '.';
    notesTargetLabel = label || notesTargetPath.split('/').pop() || 'Selected item';
    if (notesTargetName) {
        notesTargetName.textContent = notesTargetLabel;
    }
    if (notesTargetCrumb) {
        notesTargetCrumb.textContent = notesTargetPath === '.' ? 'Root' : notesTargetPath;
    }
    modalInstance.show();
    await loadNotesForActivePath();
}

async function loadNotesForActivePath() {
    if (!notesTargetPath) return;
    try {
        setStatus('Loading notesâ€¦');
        const payload = await fetchNotes(notesTargetPath);
        cachedNotes = Array.isArray(payload?.notes) ? payload.notes : [];
        applyNotesSummary(payload?.summary || {});
        renderNotes();
    } catch (error) {
        handleError(error);
    } finally {
        setStatus('Saved/Idle');
    }
}

function setupNoteCreateModal() {
    noteCreateModal = document.getElementById('modal-note-create');
    if (!noteCreateModal) return;
    noteCreateForm = document.getElementById('form-note-create');
    noteCreatePathLabel = document.getElementById('note-create-path');
    noteCreateText = document.getElementById('note-create-text');
    noteCreateDeadline = document.getElementById('note-create-deadline');
    noteCreatePriority = document.getElementById('note-create-priority');
    noteCreateStatus = document.getElementById('note-create-status');
    noteCreateColorToggle = document.getElementById('note-create-color-toggle');
    noteCreateColor = document.getElementById('note-create-color');
    noteCreateForm?.addEventListener('submit', handleNoteCreateSubmit);
    noteCreateColorToggle?.addEventListener('change', () => syncNoteColorToggle(noteCreateColorToggle, noteCreateColor));
    noteCreateModal.addEventListener('hidden.bs.modal', () => {
        noteCreateForm?.reset();
        if (noteCreateStatus) {
            noteCreateStatus.value = 'none';
        }
        if (noteCreateColorToggle) {
            noteCreateColorToggle.checked = false;
        }
        syncNoteColorToggle(noteCreateColorToggle, noteCreateColor);
    });
}

export function openNoteCreateModal(path, label = '') {
    if (!noteCreateModal) {
        setupNoteCreateModal();
    }
    notesTargetPath = normalizePath(path) || '.';
    notesTargetLabel = label || notesTargetPath.split('/').pop() || 'Selected item';
    if (noteCreatePathLabel) {
        noteCreatePathLabel.textContent = notesTargetPath === '.' ? 'Root' : notesTargetPath;
    }
    if (noteCreateColorToggle) {
        noteCreateColorToggle.checked = false;
    }
    if (noteCreateColor) {
        noteCreateColor.value = '#f3f4f6';
    }
    syncNoteColorToggle(noteCreateColorToggle, noteCreateColor);
    const instance = bootstrap.Modal.getOrCreateInstance(noteCreateModal);
    instance.show();
}

async function handleNoteCreateSubmit(event) {
    event.preventDefault();
    if (!notesTargetPath) return;
    const payload = {
        path: notesTargetPath,
        text: noteCreateText?.value || '',
        deadline: noteCreateDeadline?.value || null,
        priority: noteCreatePriority?.value || null,
        status: noteCreateStatus?.value || 'none',
        color: noteCreateColorToggle?.checked ? getNoteColorPayload(noteCreateColorToggle, noteCreateColor) : null,
    };
    try {
        setStatus('Saving noteâ€¦');
        const response = await createNote(notesTargetPath, payload);
        cachedNotes = Array.isArray(response?.notes) ? response.notes : cachedNotes;
        applyNotesSummary(response?.summary || {});
        renderNotes();
        document.dispatchEvent(new CustomEvent('qualifile:preview-refresh', { detail: { path: notesTargetPath } }));
        bootstrap.Modal.getInstance(noteCreateModal)?.hide();
        showToast('Note added');
        requestGlobalRefresh({ refreshTree: false, refreshList: true });
    } catch (error) {
        handleError(error);
    } finally {
        setStatus('Saved/Idle');
    }
}

function setupNoteEditModal() {
    noteEditModal = document.getElementById('modal-note-edit');
    if (!noteEditModal) return;
    noteEditForm = document.getElementById('form-note-edit');
    noteEditPathLabel = document.getElementById('note-edit-path');
    noteEditText = document.getElementById('note-edit-text');
    noteEditDeadline = document.getElementById('note-edit-deadline');
    noteEditPriority = document.getElementById('note-edit-priority');
    noteEditStatus = document.getElementById('note-edit-status');
    noteEditColorToggle = document.getElementById('note-edit-color-toggle');
    noteEditColor = document.getElementById('note-edit-color');
    noteEditForm?.addEventListener('submit', handleNoteEditSubmit);
    noteEditColorToggle?.addEventListener('change', () => syncNoteColorToggle(noteEditColorToggle, noteEditColor));
    noteEditModal.addEventListener('hidden.bs.modal', () => {
        editingNoteId = null;
        noteEditForm?.reset();
        if (noteEditStatus) {
            noteEditStatus.value = 'none';
        }
        if (noteEditColorToggle) {
            noteEditColorToggle.checked = false;
        }
        syncNoteColorToggle(noteEditColorToggle, noteEditColor);
    });
}

function openNoteEditModal(note) {
    if (!note) return;
    if (!noteEditModal) {
        setupNoteEditModal();
    }
    editingNoteId = note.id;
    if (noteEditPathLabel) {
        noteEditPathLabel.textContent = notesTargetPath === '.' ? 'Root' : notesTargetPath;
    }
    if (noteEditText) noteEditText.value = note.text || '';
    if (noteEditDeadline) noteEditDeadline.value = note.deadline || '';
    if (noteEditPriority) noteEditPriority.value = note.priority || '';
    if (noteEditStatus) noteEditStatus.value = note.status || 'none';
    if (noteEditColor) {
        noteEditColor.value = normalizeHexColor(note.color) || '#f3f4f6';
    }
    if (noteEditColorToggle) {
        noteEditColorToggle.checked = Boolean(normalizeHexColor(note.color));
    }
    syncNoteColorToggle(noteEditColorToggle, noteEditColor);
    const instance = bootstrap.Modal.getOrCreateInstance(noteEditModal);
    instance.show();
}

async function handleNoteEditSubmit(event) {
    event.preventDefault();
    if (!notesTargetPath || !editingNoteId) return;
    const payload = {
        path: notesTargetPath,
        text: noteEditText?.value || '',
        deadline: noteEditDeadline?.value || null,
        priority: noteEditPriority?.value || null,
        status: noteEditStatus?.value || 'none',
        color: noteEditColorToggle?.checked ? getNoteColorPayload(noteEditColorToggle, noteEditColor) : null,
    };
    try {
        setStatus('Updating noteâ€¦');
        const response = await updateNote(notesTargetPath, editingNoteId, payload);
        cachedNotes = Array.isArray(response?.notes) ? response.notes : cachedNotes;
        applyNotesSummary(response?.summary || {});
        renderNotes();
        document.dispatchEvent(new CustomEvent('qualifile:preview-refresh', { detail: { path: notesTargetPath } }));
        bootstrap.Modal.getInstance(noteEditModal)?.hide();
        showToast('Note updated');
        requestGlobalRefresh({ refreshTree: false, refreshList: true });
    } catch (error) {
        handleError(error);
    } finally {
        setStatus('Saved/Idle');
    }
}

function renderNotes() {
    if (!notesOpenList || !notesClosedList) return;
    notesOpenList.innerHTML = '';
    notesClosedList.innerHTML = '';
    const openNotes = cachedNotes.filter((note) => note?.status !== 'closed');
    const closedNotes = cachedNotes.filter((note) => note?.status === 'closed');
    if (notesEmptyState) {
        notesEmptyState.classList.toggle('d-none', Boolean(openNotes.length || closedNotes.length));
    }
    renderNoteList(notesOpenList, openNotes, { muted: false });
    renderNoteList(notesClosedList, closedNotes, { muted: true });
    if (notesClosedList && !closedNotes.length) {
        notesClosedList.classList.add('d-none');
    }
    if (notesClosedSummary) {
        const count = closedNotes.length;
        notesClosedSummary.textContent = `${count || 'No'} closed notes${count ? ' (click to expand)' : ''}`;
    }
    if (notesClosedToggle) {
        notesClosedToggle.disabled = !closedNotes.length;
    }
}

function renderNoteList(container, notes, options = {}) {
    const muted = Boolean(options.muted);
    if (!notes.length) {
        const empty = document.createElement('p');
        empty.className = 'text-muted small mb-0';
        empty.textContent = muted ? 'No closed notes yet.' : 'No open notes.';
        container.appendChild(empty);
        return;
    }
    notes.forEach((note) => {
        const card = buildNoteCard(note, { muted });
        container.appendChild(card);
    });
}

function collapseNoteCard(noteId) {
    if (!noteId) return;
    const card = document.querySelector(`article.note-card[data-note-id="${CSS.escape(noteId)}"]`);
    if (!card) return;
    const text = card.querySelector('.note-text');
    const hint = card.querySelector('.note-more-indicator');
    if (text && !text.classList.contains('note-text-collapsed')) {
        text.classList.add('note-text-collapsed');
    }
    if (hint) {
        hint.classList.remove('d-none');
    }
}
function buildNoteCard(note, options = {}) {
    const muted = Boolean(options.muted);
    const card = document.createElement('article');
    card.className = 'note-card';
    card.dataset.noteId = note.id || '';
    if (muted) {
        card.classList.add('note-card-closed');
    }
    const normalizedColor = normalizeHexColor(note?.color);
    if (normalizedColor) {
        card.classList.add('note-card-custom');
        card.style.backgroundColor = normalizedColor;
        card.style.borderColor = normalizedColor;
        const textColor = getReadableTextColor(normalizedColor);
        card.style.color = textColor;
        card.style.setProperty('--note-text-color', textColor);
        const chipBg = textColor === '#FFFFFF' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.08)';
        card.style.setProperty('--note-chip-bg', chipBg);
        card.style.setProperty('--note-chip-border', `${textColor}33`);
    }
    const header = document.createElement('div');
    header.className = 'note-card-header d-flex align-items-start justify-content-between gap-3';

    const meta = document.createElement('div');
    meta.className = 'd-flex flex-wrap align-items-center gap-2 note-meta';
    const deadlineChip = createDeadlineChip(note);
    const priorityChip = createPriorityChip(note);
    const statusChip = createStatusChip(note);
    [deadlineChip, priorityChip, statusChip].forEach((chip) => {
        if (chip) meta.appendChild(chip);
    });
    header.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'note-actions d-flex gap-2 ms-auto';
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'btn btn-sm btn-primary';
    editButton.title = 'Modify note';
    editButton.setAttribute('aria-label', 'Modify note');
    editButton.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Zm14.71-9.04a1 1 0 0 0 0-1.41l-1.51-1.51a1 1 0 0 0-1.41 0l-1.13 1.13 3.75 3.75 1.3-1.46Z"></path></svg>';
    editButton.addEventListener('click', () => openNoteEditModal(note));
    actions.appendChild(editButton);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn-sm btn-danger';
    deleteButton.title = 'Delete note';
    deleteButton.setAttribute('aria-label', 'Delete note');
    deleteButton.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 4h6l1 1h4v2H3V5h4l1-1Zm1 5h2v8h-2V9Zm4 0h2v8h-2V9ZM7 9h2v8H7V9Z"></path></svg>';
    deleteButton.addEventListener('click', () => deleteNoteWithConfirm(note));
    actions.appendChild(deleteButton);

    if (note.status !== 'closed') {
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'btn btn-sm btn-success';
        closeButton.title = 'Close note';
        closeButton.setAttribute('aria-label', 'Close note');
        closeButton.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9.5 17.5 4 12l1.41-1.41L9.5 14.67l9.09-9.09L20 7l-10.5 10.5Z"></path></svg>';
        closeButton.addEventListener('click', () => quickUpdateStatus(note, 'closed'));
        actions.appendChild(closeButton);
    } else {
        const reopenButton = document.createElement('button');
        reopenButton.type = 'button';
        reopenButton.className = 'btn btn-sm btn-outline-primary';
        reopenButton.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 5V2L8 6l4 4V7c2.757 0 5 2.243 5 5a5.002 5.002 0 0 1-6.32 4.8 1 1 0 1 0-.52 1.94A7.002 7.002 0 0 0 19 12c0-3.86-3.141-7-7-7Z"></path></svg>';
        reopenButton.title = 'Reopen note';
        reopenButton.setAttribute('aria-label', 'Reopen note');
        reopenButton.addEventListener('click', () => quickUpdateStatus(note, 'in_progress'));
        actions.appendChild(reopenButton);
    }
    header.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'note-card-body';

    const text = document.createElement('p');
    text.className = 'note-text mb-0';
    text.textContent = note.text || '';
    const lineCount = (note.text || '').split(/\r?\n/).length;
    const isLong = lineCount > 4;
    if (isLong && expandedNoteId !== note.id) {
        text.classList.add('note-text-collapsed');
    }
    const moreHint = document.createElement('div');
    moreHint.className = 'note-more-indicator';
    moreHint.textContent = 'More';
    if (!isLong || expandedNoteId === note.id) {
        moreHint.classList.add('d-none');
    }
    const toggleExpansion = () => {
        if (!isLong) return;
        if (expandedNoteId && expandedNoteId !== note.id) {
            collapseNoteCard(expandedNoteId);
        }
        const isExpanded = expandedNoteId === note.id;
        if (isExpanded) {
            expandedNoteId = null;
            text.classList.add('note-text-collapsed');
            moreHint.classList.remove('d-none');
        } else {
            expandedNoteId = note.id;
            text.classList.remove('note-text-collapsed');
            moreHint.classList.add('d-none');
        }
    };
    text.addEventListener('click', toggleExpansion);
    moreHint.addEventListener('click', toggleExpansion);
    body.appendChild(text);
    body.appendChild(moreHint);

    card.append(header, body);
    return card;
}

function createDeadlineChip(note) {
    const info = resolveDeadlineState(note?.deadline);
    if (!info) return null;
    const chip = document.createElement('span');
    chip.className = `note-chip note-deadline note-deadline-${info.tone}`;
    chip.textContent = info.label;
    chip.setAttribute('aria-label', `Deadline ${info.label}`);
    return chip;
}

function createPriorityChip(note) {
    const priority = note?.priority || 'none';
    if (priority === 'high') {
        const chip = document.createElement('span');
        chip.className = 'note-chip note-priority note-priority-high';
        chip.textContent = 'High priority';
        chip.setAttribute('aria-label', 'High priority');
        return chip;
    }
    if (priority === 'medium') {
        const chip = document.createElement('span');
        chip.className = 'note-chip note-priority note-priority-medium';
        chip.textContent = 'Medium priority';
        chip.setAttribute('aria-label', 'Medium priority');
        return chip;
    }
    return null;
}

function createStatusChip(note) {
    const status = note?.status || 'none';
    if (status !== 'in_progress') {
        return null;
    }
    const chip = document.createElement('span');
    chip.className = 'note-chip note-status note-status-progress';
    chip.textContent = 'In progress';
    chip.setAttribute('aria-label', 'In progress');
    return chip;
}

function resolveDeadlineState(deadline) {
    if (!deadline) {
        return null;
    }
    const deadlineDate = new Date(deadline);
    if (Number.isNaN(deadlineDate.getTime())) {
        return null;
    }
    const today = new Date();
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startOfDeadline = new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate());
    const diffDays = Math.round((startOfDeadline.getTime() - startOfToday.getTime()) / (1000 * 60 * 60 * 24));
    const label = deadlineDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    let tone = 'comfort';
    if (diffDays <= 2) {
        tone = 'urgent';
    } else if (diffDays <= 5) {
        tone = 'soon';
    }
    return { label, tone };
}

async function deleteNoteWithConfirm(note) {
    const needsConfirm = note?.priority === 'high';
    if (needsConfirm) {
        const confirmed = await showConfirmDialog('Delete this high-priority note? This cannot be undone.', 'Delete note');
        if (!confirmed) return;
    }
    try {
        setStatus('Deleting noteâ€¦');
        const response = await deleteNote(notesTargetPath, note.id);
        cachedNotes = Array.isArray(response?.notes) ? response.notes : cachedNotes;
        applyNotesSummary(response?.summary || {});
        renderNotes();
        document.dispatchEvent(new CustomEvent('qualifile:preview-refresh', { detail: { path: notesTargetPath } }));
        showToast('Note deleted');
        requestGlobalRefresh({ refreshTree: false, refreshList: true });
    } catch (error) {
        handleError(error);
    } finally {
        setStatus('Saved/Idle');
    }
}

async function quickUpdateStatus(note, status) {
    try {
        setStatus('Updating noteâ€¦');
        const response = await updateNote(notesTargetPath, note.id, {
            path: notesTargetPath,
            status,
        });
        cachedNotes = Array.isArray(response?.notes) ? response.notes : cachedNotes;
        applyNotesSummary(response?.summary || {});
        renderNotes();
        document.dispatchEvent(new CustomEvent('qualifile:preview-refresh', { detail: { path: notesTargetPath } }));
        requestGlobalRefresh({ refreshTree: false, refreshList: true });
    } catch (error) {
        handleError(error);
    } finally {
        setStatus('Saved/Idle');
    }
}

function normalizeHexColor(value) {
    if (!value) return null;
    const match = String(value).trim().match(/^#?([0-9a-fA-F]{6})$/);
    if (!match) return null;
    return `#${match[1].toUpperCase()}`;
}

function syncNoteColorToggle(toggle, input, fallback = '#f3f4f6') {
    if (!toggle || !input) return;
    const enabled = toggle.checked;
    input.disabled = !enabled;
    if (enabled && !normalizeHexColor(input.value)) {
        input.value = fallback;
    }
}

function getNoteColorPayload(toggle, input) {
    if (!toggle?.checked || !input) return null;
    return normalizeHexColor(input.value);
}

function getReadableTextColor(hex) {
    const normalized = normalizeHexColor(hex);
    if (!normalized) return '#000000';
    const [r, g, b] = hexToRgb(normalized);
    const [rs, gs, bs] = [r, g, b].map((channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const luminance = 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    return luminance > 0.5 ? '#000000' : '#FFFFFF';
}

function hexToRgb(hex) {
    const normalized = normalizeHexColor(hex);
    if (!normalized) return [0, 0, 0];
    const value = normalized.slice(1);
    return [
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16),
    ];
}

function applyNotesSummary(summary) {
    const hasHigh = Boolean(summary?.has_high_priority);
    const hasOverdue = Boolean(summary?.has_overdue);
    if (notesPriorityBadge) {
        notesPriorityBadge.classList.toggle('d-none', !hasHigh);
    }
    if (notesDeadlineBadge) {
        notesDeadlineBadge.classList.toggle('d-none', !hasOverdue);
    }
}

/** Show the merge modal with the provided selection. */
export function openMergeModal(selection, options = {}) {
    currentMergeItems = [...selection];
    mergePhraseMap = new Map();
    const preferredMode = options && typeof options === 'object' ? options.preferredMode : null;
    mergeModalPreferredMode = preferredMode === 'pdf' || preferredMode === 'images' ? preferredMode : null;
    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('modal-merge'));
    modal.show();
}

/** Display the tag editor modal for a specific file. */
export async function openFileTagsModal(paths, label = '') {
    if (!tagEditorModal) {
        tagEditorModal = document.getElementById('modal-file-tags');
        tagEditorList = tagEditorModal?.querySelector('#file-tag-options') || null;
        tagEditorTarget = tagEditorModal?.querySelector('#file-tag-target') || null;
    }
    if (!tagEditorModal) return;
    const selection = Array.isArray(paths) ? paths.filter(Boolean) : paths ? [paths] : [];
    if (!selection.length) return;
    tagEditorPaths = selection;
    if (tagEditorTarget) {
        if (selection.length === 1) {
            tagEditorLabel = label || selection[0] || 'Selected item';
        } else {
            tagEditorLabel = `${selection.length} items selected`;
        }
        tagEditorTarget.textContent = tagEditorLabel;
    }
    if (!state.tags?.length) {
        try {
            await refreshTagState({ silent: true });
        } catch (error) {
            // already surfaced
        }
    }
    renderFileTagOptions();
    bootstrap.Modal.getOrCreateInstance(tagEditorModal).show();
}

/** Show the delete confirmation modal with the queued selection. */
export function openDeleteModal(selection) {
    deleteSelection = [...selection];
    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('modal-delete'));
    modal.show();
}

/** Present the conflict resolution dialog for drag-and-drop. */
export function openConflictDialog(targetPath) {
    document.getElementById('conflict-target').textContent = targetPath;
    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('modal-conflict'));
    modal.show();
    return new Promise((resolve) => {
        conflictResolver = resolve;
    });
}

/** Display the import structure modal. */
export function openImportModal() {
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modal-import')).show();
}

/** Display the application settings modal. */
export function openSettingsModal(sectionId = null) {
    pendingSettingsSectionId = sectionId || null;
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modal-settings')).show();
}

export function openPdfExtractModal(path) {
    currentPdfExtractSource = path;
    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('modal-pdf-extract'));
    modal.show();
}

function setupConfirmModal() {
    const modalElement = document.getElementById('modal-confirm');
    if (!modalElement) return;
    const okButton = document.getElementById('modal-confirm-ok');
    modalElement.addEventListener('hidden.bs.modal', () => {
        if (confirmResolver) {
            confirmResolver(false);
            confirmResolver = null;
        }
    });
    okButton?.addEventListener('click', () => {
        if (confirmResolver) {
            confirmResolver(true);
            confirmResolver = null;
        }
        bootstrap.Modal.getInstance(modalElement)?.hide();
    });
}

function setupFileTagsModal() {
    const modalElement = document.getElementById('modal-file-tags');
    if (!modalElement) return;
    tagEditorModal = modalElement;
    tagEditorList = modalElement.querySelector('#file-tag-options');
    tagEditorTarget = modalElement.querySelector('#file-tag-target');
    const form = modalElement.querySelector('#form-file-tags');
    form?.addEventListener('submit', handleFileTagSubmit);
    modalElement.addEventListener('hidden.bs.modal', () => {
        tagEditorPaths = [];
        tagEditorLabel = '';
    });
    modalElement.querySelector('#file-tags-manage')?.addEventListener('click', () => {
        bootstrap.Modal.getInstance(modalElement)?.hide();
        setTimeout(() => {
            openSettingsModal('tags');
        }, 200);
    });
}

function renderFileTagOptions() {
    if (!tagEditorList) return;
    tagEditorList.innerHTML = '';
    const tags = Array.isArray(state.tags) ? state.tags : [];
    if (!tagEditorPaths.length) {
        tagEditorList.innerHTML = '<p class="text-muted mb-0">Select a file to manage tags.</p>';
        return;
    }
    if (!tags.length) {
        tagEditorList.innerHTML = '<p class="text-muted mb-0">No tags available. Use "Manage tags" to add categories.</p>';
        return;
    }
    const assigned = resolveCommonTags(tagEditorPaths);
    tags.forEach((tag) => {
        if (!tag?.id) return;
        const wrapper = document.createElement('div');
        wrapper.className = 'tag-option form-check';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'form-check-input';
        input.id = `file-tag-${tag.id}`;
        input.value = tag.id;
        input.checked = assigned.includes(tag.id);
        const label = document.createElement('label');
        label.className = 'form-check-label d-flex align-items-center gap-2';
        label.setAttribute('for', input.id);
        const badge = document.createElement('span');
        badge.className = 'tag-badge';
        const colors = resolveTagColors(tag.color || '#6c757d');
        badge.style.setProperty('--tag-color', colors.background);
        badge.style.setProperty('--tag-color-text', colors.text);
        badge.textContent = tag.name;
        const nameSpan = document.createElement('span');
        nameSpan.textContent = tag.name;
        label.append(badge, nameSpan);
        wrapper.append(input, label);
        tagEditorList.appendChild(wrapper);
    });
}

async function handleFileTagSubmit(event) {
    event.preventDefault();
    if (!tagEditorPaths.length) return;
    const selections = [];
    tagEditorList?.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        if (input.checked) {
            selections.push(input.value);
        }
    });
    try {
        setStatus('Updating tagsâ€¦');
        let lastAppliedTags = selections;
        for (const path of tagEditorPaths) {
            const response = await assignTagsToPath(path, selections);
            const key = canonicalTagPath(response?.path || path);
            const applied = Array.isArray(response?.tags) ? response.tags : selections;
            state.tagAssignments[key] = applied;
            lastAppliedTags = applied;
            document.dispatchEvent(new CustomEvent('qualifile:preview-refresh', { detail: { path } }));
        }
        applyTagUpdates(tagEditorPaths, lastAppliedTags);
        showToast(tagEditorPaths.length > 1 ? 'Tags updated for selected items' : 'Tags updated');
        bootstrap.Modal.getInstance(tagEditorModal)?.hide();
    } catch (error) {
        handleError(error);
    } finally {
        setStatus('Saved/Idle');
    }
}

function resolveCommonTags(paths) {
    let common = null;
    paths.forEach((rawPath) => {
        const key = canonicalTagPath(rawPath);
        const tags = state.tagAssignments?.[key] || [];
        if (common === null) {
            common = [...tags];
        } else {
            common = common.filter((tagId) => tags.includes(tagId));
        }
    });
    return common || [];
}

export function showConfirmDialog(message, title = 'Confirm action') {
    const modalElement = document.getElementById('modal-confirm');
    if (!modalElement) return Promise.resolve(false);
    modalElement.querySelector('#modal-confirm-label').textContent = title;
    modalElement.querySelector('#modal-confirm-message').textContent = message;
    const instance = bootstrap.Modal.getOrCreateInstance(modalElement);
    instance.show();
    return new Promise((resolve) => {
        confirmResolver = resolve;
    });
}

async function refreshTagState(options = {}) {
    const silent = Boolean(options && options.silent);
    try {
        const payload = await fetchTagsState();
        if (Array.isArray(payload?.tags)) {
            state.tags = payload.tags;
        }
        if (payload?.assignments && typeof payload.assignments === 'object') {
            const assignments = {};
            Object.entries(payload.assignments).forEach(([entryPath, tags]) => {
                const key = canonicalTagPath(entryPath);
                assignments[key] = Array.isArray(tags) ? [...tags] : [];
            });
            state.tagAssignments = assignments;
        }
        return payload;
    } catch (error) {
        if (!silent) {
            handleError(error);
        }
        throw error;
    }
}
