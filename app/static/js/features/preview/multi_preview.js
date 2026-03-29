import { fetchPreview, fetchFileUrl, openInDefaultApp, handleError } from '../../shared/api.js';
import { showToast } from '../../shared/ui.js';
import { findItem } from '../../shared/list.js';

const modalElement = document.getElementById('modal-multi-preview');
const gridElement = document.getElementById('multi-preview-grid');
const layoutToggle = document.getElementById('multi-preview-layout-toggle');
const layoutLabel = document.getElementById('multi-preview-layout-label');
const layoutMenu = document.getElementById('multi-preview-layout-menu');
const headerToggle = document.getElementById('multi-preview-header-toggle');

const LAYOUT_PRESETS = {
    2: [
        { id: 'two-vertical', label: 'Side-by-side (vertical split)', className: 'multi-layout-two-vertical' },
        { id: 'two-horizontal', label: 'Stacked (horizontal split)', className: 'multi-layout-two-horizontal' },
        { id: 'two-picture', label: 'Focus first file (picture-in-picture)', className: 'multi-layout-two-picture' },
    ],
    3: [
        { id: 'three-columns', label: 'Three columns', className: 'multi-layout-three-columns' },
        { id: 'three-rows', label: 'Three rows', className: 'multi-layout-three-rows' },
        { id: 'three-focus', label: 'Focus first file + stacked', className: 'multi-layout-three-focus' },
    ],
    4: [
        { id: 'four-grid', label: '2 x 2 grid', className: 'multi-layout-four-grid' },
        { id: 'four-columns', label: 'Four columns', className: 'multi-layout-four-columns' },
        { id: 'four-rows', label: 'Four rows', className: 'multi-layout-four-rows' },
    ],
};

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;
const DEFAULT_ZOOM = 1;
const ZOOM_STEP = 0.2;
const MIN_ITEM_WIDTH = 240;
const MIN_ITEM_HEIGHT = 200;

let currentLayoutClass = '';
let currentLayoutId = null;
let currentCount = 0;
let headersHidden = false;
let layoutState = new Map();
let latestEntries = [];
const cardElements = new Map();
let activeCardPath = null;
let zOrderSeed = 10;
let gridResizeObserver = null;

if (modalElement) {
    modalElement.addEventListener('hidden.bs.modal', () => resetMultiPreview());
}

if (gridElement && window.ResizeObserver) {
    gridResizeObserver = new ResizeObserver(() => applyLayoutState());
    gridResizeObserver.observe(gridElement);
}

if (headerToggle) {
    headerToggle.addEventListener('click', () => {
        headersHidden = !headersHidden;
        applyHeaderVisibility();
    });
    applyHeaderVisibility();
}

export async function openMultiPreview(paths) {
    if (!modalElement || !gridElement) {
        showToast('Fullscreen comparison is not available in this view.', true);
        return;
    }
    const prepared = prepareTargets(paths);
    if (prepared.length < 2 || prepared.length > 4) {
        showToast('Select between two and four files to open them in fullscreen.', true);
        return;
    }
    setLoadingState();
    const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
    modal.show();
    try {
        const results = await Promise.allSettled(prepared.map(async ({ path, item }) => {
            const data = await fetchPreview(path);
            return buildEntry(path, item, data);
        }));

        const entries = [];
        let failed = 0;
        results.forEach((result) => {
            if (result.status === 'fulfilled') {
                entries.push(result.value);
            } else {
                failed += 1;
                console.warn('Failed to build fullscreen preview', result.reason);
            }
        });

        if (failed) {
            const suffix = failed === 1 ? '' : 's';
            showToast(`${failed} preview${suffix} could not be loaded.`, true);
        }
        if (!entries.length) {
            showToast('Unable to load previews for the selected files.', true);
            resetMultiPreview();
            modal.hide();
            return;
        }
        currentCount = entries.length;
        renderEntries(entries);
        renderLayoutMenu(entries.length);
    } catch (error) {
        handleError(error);
        resetMultiPreview();
        modal.hide();
    }
}

function prepareTargets(input) {
    const seen = new Set();
    const output = [];
    if (!Array.isArray(input)) {
        return output;
    }
    input.forEach((raw) => {
        const path = typeof raw === 'string' ? raw : String(raw || '');
        if (!path || seen.has(path)) {
            return;
        }
        const item = findItem(path);
        if (!item || item.is_dir) {
            return;
        }
        seen.add(path);
        output.push({ path, item });
    });
    return output;
}

function setLoadingState() {
    if (gridElement) {
        gridElement.innerHTML = '<div class="multi-preview-placeholder text-muted">Loading previews...</div>';
    }
    disableLayoutMenu();
}

function renderEntries(entries) {
    if (!gridElement) return;
    latestEntries = entries;
    cardElements.clear();
    activeCardPath = null;
    gridElement.innerHTML = '';
    entries.forEach((entry) => {
        const card = createPreviewCard(entry);
        card.dataset.path = entry.path;
        card.style.zIndex = String(zOrderSeed);
        gridElement.appendChild(card);
        cardElements.set(entry.path, card);
        zOrderSeed += 1;
    });
    ensureLayoutState();
    applyLayoutState();
    cardElements.forEach((card, path) => {
        makeCardInteractive(card, path);
    });
    if (entries[0]) {
        setActiveCard(entries[0].path);
    }
}

function renderLayoutMenu(count) {
    if (!layoutMenu || !layoutToggle || !layoutLabel) return;
    layoutMenu.innerHTML = '';
    const options = LAYOUT_PRESETS[count] || [];
    if (!options.length) {
        disableLayoutMenu();
        return;
    }
    layoutToggle.disabled = false;
    const header = document.createElement('li');
    header.innerHTML = '<h6 class="dropdown-header">Common splits</h6>';
    layoutMenu.appendChild(header);
    options.forEach((option) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dropdown-item';
        button.dataset.layoutId = option.id;
        button.textContent = option.label;
        button.setAttribute('role', 'menuitemradio');
        button.setAttribute('aria-checked', 'false');
        button.addEventListener('click', () => setLayout(option.id));
        li.appendChild(button);
        layoutMenu.appendChild(li);
    });
    const hasCurrent = options.some((option) => option.id === currentLayoutId);
    const target = hasCurrent ? currentLayoutId : options[0].id;
    setLayout(target, { preserve: hasCurrent });
}

function disableLayoutMenu() {
    if (layoutToggle) {
        layoutToggle.disabled = true;
    }
    if (layoutLabel) {
        layoutLabel.textContent = 'Split layout';
    }
    if (layoutMenu) {
        layoutMenu.innerHTML = '<li><span class="dropdown-item-text text-muted small">Layout options appear when previews are ready.</span></li>';
    }
    if (gridElement && currentLayoutClass) {
        gridElement.classList.remove(currentLayoutClass);
    }
    currentLayoutClass = '';
    currentCount = 0;
}

function applyHeaderVisibility() {
    if (modalElement) {
        modalElement.classList.toggle('multi-preview-hide-headers', headersHidden);
    }
    if (headerToggle) {
        headerToggle.textContent = headersHidden ? 'Show headers' : 'Hide headers';
        headerToggle.setAttribute('aria-pressed', headersHidden ? 'true' : 'false');
        headerToggle.classList.toggle('btn-primary', headersHidden);
    }
}

function setLayout(layoutId, { preserve = false } = {}) {
    if (!gridElement || !layoutLabel || !layoutMenu) return;
    const options = LAYOUT_PRESETS[currentCount] || [];
    if (!options.length) return;
    const layout = options.find((option) => option.id === layoutId) || options[0];
    if (!layout) return;
    if (currentLayoutClass) {
        gridElement.classList.remove(currentLayoutClass);
    }
    gridElement.classList.add(layout.className);
    currentLayoutClass = layout.className;
    currentLayoutId = layout.id;
    layoutLabel.textContent = layout.label;
    layoutMenu.querySelectorAll('[data-layout-id]').forEach((button) => {
        const isActive = button.dataset.layoutId === layout.id;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-checked', isActive ? 'true' : 'false');
    });
    if (!preserve) {
        layoutState = buildDefaultLayout(currentLayoutId, latestEntries);
    }
    applyLayoutState();
    headersHidden = false;
    applyHeaderVisibility();
}

function ensureLayoutState() {
    if (!latestEntries.length) {
        layoutState = new Map();
        return;
    }
    let missing = layoutState.size !== latestEntries.length;
    if (!missing) {
        latestEntries.forEach((entry) => {
            if (!layoutState.has(entry.path)) {
                missing = true;
            }
        });
    }
    if (missing) {
        layoutState = buildDefaultLayout(currentLayoutId, latestEntries);
    }
}

function applyLayoutState() {
    if (!gridElement || !layoutState.size) return;
    const metrics = getGridMetrics();
    if (!metrics) return;
    layoutState.forEach((state, path) => {
        const card = cardElements.get(path);
        if (!card) return;
        positionCard(card, state, metrics);
    });
}

function getGridMetrics() {
    if (!gridElement) return null;
    const rect = gridElement.getBoundingClientRect();
    const computed = window.getComputedStyle(gridElement);
    const paddingLeft = parseFloat(computed.paddingLeft) || 0;
    const paddingRight = parseFloat(computed.paddingRight) || 0;
    const paddingTop = parseFloat(computed.paddingTop) || 0;
    const paddingBottom = parseFloat(computed.paddingBottom) || 0;
    const width = Math.max(rect.width - paddingLeft - paddingRight, MIN_ITEM_WIDTH);
    const height = Math.max(rect.height - paddingTop - paddingBottom, MIN_ITEM_HEIGHT);
    return {
        width,
        height,
    };
}

function positionCard(card, state, metrics) {
    const leftPx = state.left * metrics.width;
    const topPx = state.top * metrics.height;
    card.style.left = `${leftPx}px`;
    card.style.top = `${topPx}px`;
    card.style.width = `${state.width * metrics.width}px`;
    card.style.height = `${state.height * metrics.height}px`;
}

function makeCardInteractive(card, path) {
    const header = card.querySelector('.multi-preview-item-header');
    const handle = card.querySelector('.multi-preview-resize-handle');
    if (header) {
        header.style.cursor = 'move';
        header.addEventListener('pointerdown', (event) => startCardDrag(event, card, path));
    }
    if (handle) {
        handle.addEventListener('pointerdown', (event) => startCardResize(event, card, path));
    }
    card.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        setActiveCard(path);
    });
}

function startCardDrag(event, card, path) {
    if (!gridElement || !layoutState.has(path)) return;
    if (event.button !== 0) return;
    if (isInteractiveTarget(event.target)) return;
    event.preventDefault();
    setActiveCard(path);
    const pointerId = event.pointerId;
    const metrics = getGridMetrics();
    if (!metrics) return;
    const state = layoutState.get(path);
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = state.left;
    const startTop = state.top;
    card.setPointerCapture(pointerId);
    card.classList.add('is-dragging');
    let active = true;
    const onMove = (moveEvent) => {
        if (!active || moveEvent.pointerId !== pointerId) return;
        const deltaX = (moveEvent.clientX - startX) / metrics.width;
        const deltaY = (moveEvent.clientY - startY) / metrics.height;
        state.left = clamp(startLeft + deltaX, 0, 1 - state.width);
        state.top = clamp(startTop + deltaY, 0, 1 - state.height);
        positionCard(card, state, metrics);
    };
    const finish = () => {
        if (!active) return;
        active = false;
        card.removeEventListener('pointermove', onMove);
        card.releasePointerCapture(pointerId);
        card.classList.remove('is-dragging');
    };
    const onUp = (upEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        finish();
    };
    card.addEventListener('pointermove', onMove);
    card.addEventListener('pointerup', onUp, { once: true });
    card.addEventListener('pointercancel', onUp, { once: true });
    card.addEventListener('lostpointercapture', finish, { once: true });
}

function startCardResize(event, card, path) {
    if (!gridElement || !layoutState.has(path)) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveCard(path);
    const pointerId = event.pointerId;
    const metrics = getGridMetrics();
    if (!metrics) return;
    const state = layoutState.get(path);
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = state.width;
    const startHeight = state.height;
    const minWidth = MIN_ITEM_WIDTH / metrics.width;
    const minHeight = MIN_ITEM_HEIGHT / metrics.height;
    card.setPointerCapture(pointerId);
    card.classList.add('is-resizing');
    let active = true;
    const onMove = (moveEvent) => {
        if (!active || moveEvent.pointerId !== pointerId) return;
        const deltaX = (moveEvent.clientX - startX) / metrics.width;
        const deltaY = (moveEvent.clientY - startY) / metrics.height;
        state.width = clamp(startWidth + deltaX, minWidth, 1 - state.left);
        state.height = clamp(startHeight + deltaY, minHeight, 1 - state.top);
        positionCard(card, state, metrics);
    };
    const finish = () => {
        if (!active) return;
        active = false;
        card.removeEventListener('pointermove', onMove);
        card.releasePointerCapture(pointerId);
        card.classList.remove('is-resizing');
    };
    const onUp = (upEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        finish();
    };
    card.addEventListener('pointermove', onMove);
    card.addEventListener('pointerup', onUp, { once: true });
    card.addEventListener('pointercancel', onUp, { once: true });
    card.addEventListener('lostpointercapture', finish, { once: true });
}

function buildDefaultLayout(layoutId, entries) {
    const map = new Map();
    if (!entries.length) {
        return map;
    }
    const slots = computeDefaultSlots(layoutId, entries.length);
    entries.forEach((entry, index) => {
        const slot = slots[index] || {
            left: 0,
            top: index / entries.length,
            width: 1,
            height: 1 / entries.length,
        };
        map.set(entry.path, { ...slot });
    });
    return map;
}

function computeDefaultSlots(layoutId, count) {
    switch (layoutId) {
        case 'two-vertical':
            return buildGridSlots(2, 1, count);
        case 'two-horizontal':
            return buildGridSlots(1, 2, count);
        case 'two-picture':
            return [
                { left: 0, top: 0, width: 0.66, height: 1 },
                { left: 0.66, top: 0, width: 0.34, height: count > 2 ? 0.5 : 1 },
                { left: 0.66, top: 0.5, width: 0.34, height: 0.5 },
            ];
        case 'three-columns':
            return buildGridSlots(3, 1, count);
        case 'three-rows':
            return buildGridSlots(1, 3, count);
        case 'three-focus':
            return [
                { left: 0, top: 0, width: 0.6, height: 1 },
                { left: 0.6, top: 0, width: 0.4, height: 0.5 },
                { left: 0.6, top: 0.5, width: 0.4, height: 0.5 },
            ];
        case 'four-grid':
            return buildGridSlots(2, 2, count);
        case 'four-columns':
            return buildGridSlots(count, 1, count);
        case 'four-rows':
            return buildGridSlots(1, count, count);
        default:
            return buildGridSlots(Math.min(count, 2), Math.ceil(count / Math.min(count, 2)), count);
    }
}

function buildGridSlots(columns, rows, count) {
    const slots = [];
    const colWidth = 1 / columns;
    const rowHeight = 1 / rows;
    let index = 0;
    for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < columns; col += 1) {
            if (index >= count) break;
            slots.push({
                left: col * colWidth,
                top: row * rowHeight,
                width: colWidth,
                height: rowHeight,
            });
            index += 1;
        }
    }
    return slots;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function isInteractiveTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest('button, input, select, textarea, a, .btn'));
}

function resetMultiPreview() {
    if (gridElement) {
        gridElement.innerHTML = '<div class="multi-preview-placeholder text-muted">Select files to view them side by side.</div>';
        if (currentLayoutClass) {
            gridElement.classList.remove(currentLayoutClass);
        }
    }
    currentLayoutClass = '';
    currentLayoutId = null;
    currentCount = 0;
    latestEntries = [];
    layoutState = new Map();
    cardElements.clear();
    activeCardPath = null;
    disableLayoutMenu();
    headersHidden = false;
    applyHeaderVisibility();
}

function setActiveCard(path) {
    const target = cardElements.get(path);
    if (!target) return;
    if (activeCardPath && cardElements.has(activeCardPath) && activeCardPath !== path) {
        const previous = cardElements.get(activeCardPath);
        previous.classList.remove('is-top');
    }
    activeCardPath = path;
    target.classList.add('is-top');
    zOrderSeed += 1;
    target.style.zIndex = String(zOrderSeed);
}

function buildEntry(path, item, data) {
    const metadata = data?.metadata || {};
    const title = metadata.name || item?.displayName || item?.name || deriveNameFromPath(path);
    const typeLabel = metadata.type || item?.type || data?.mime || '';
    return {
        path,
        data,
        title,
        typeLabel,
    };
}

function createPreviewCard(entry) {
    const card = document.createElement('article');
    card.className = 'multi-preview-item';
    const header = document.createElement('div');
    header.className = 'multi-preview-item-header flex-wrap';

    const title = document.createElement('span');
    title.className = 'multi-preview-item-title text-truncate';
    title.textContent = entry.title;
    title.title = entry.title;
    header.appendChild(title);

    if (entry.typeLabel) {
        const badge = document.createElement('span');
        badge.className = 'badge bg-secondary-subtle text-secondary-emphasis text-uppercase';
        badge.textContent = entry.typeLabel;
        header.appendChild(badge);
    }

    const actions = document.createElement('div');
    actions.className = 'multi-preview-item-tools d-flex flex-wrap align-items-center gap-2 ms-auto';
    header.appendChild(actions);

    const state = {
        path: entry.path,
        type: entry.data?.type || 'notice',
        zoom: DEFAULT_ZOOM,
        panX: 0,
        panY: 0,
        contentElement: null,
        viewport: null,
        isPanning: false,
        pointerOffsetX: 0,
        pointerOffsetY: 0,
    };

    if (shouldEnableZoom(state.type)) {
        actions.appendChild(createZoomControls(state));
    }

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'btn btn-sm btn-outline-secondary';
    openButton.textContent = 'Open externally';
    openButton.addEventListener('click', async () => {
        try {
            await openInDefaultApp(entry.path);
        } catch (error) {
            handleError(error);
        }
    });
    actions.appendChild(openButton);

    const body = document.createElement('div');
    body.className = 'multi-preview-item-body';
    const canvas = document.createElement('div');
    canvas.className = 'multi-preview-canvas';
    canvas.setAttribute('role', 'group');
    canvas.setAttribute('aria-label', `Preview of ${entry.title}`);
    renderEntryContent(canvas, entry, state);
    body.appendChild(canvas);

    card.appendChild(header);
    card.appendChild(body);
    const handle = document.createElement('div');
    handle.className = 'multi-preview-resize-handle';
    handle.title = 'Resize panel';
    card.appendChild(handle);
    return card;
}

function shouldEnableZoom(type) {
    return type !== 'pdf';
}

function createZoomControls(state) {
    const group = document.createElement('div');
    group.className = 'multi-preview-zoom-group d-inline-flex align-items-center gap-1 flex-wrap';

    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.className = 'btn btn-sm btn-outline-secondary';
    zoomOut.textContent = '−';
    zoomOut.addEventListener('click', () => adjustZoom(state, -ZOOM_STEP));

    const zoomLabel = document.createElement('span');
    zoomLabel.className = 'multi-preview-zoom-label';
    zoomLabel.textContent = '100%';

    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'btn btn-sm btn-outline-secondary';
    zoomIn.textContent = '+';
    zoomIn.addEventListener('click', () => adjustZoom(state, ZOOM_STEP));

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn btn-sm btn-outline-secondary';
    reset.textContent = 'Reset';
    reset.addEventListener('click', () => setZoom(state, DEFAULT_ZOOM));

    group.appendChild(zoomOut);
    group.appendChild(zoomLabel);
    group.appendChild(zoomIn);
    group.appendChild(reset);

    state.zoomLabel = zoomLabel;
    return group;
}

function adjustZoom(state, amount) {
    setZoom(state, state.zoom + amount);
}

function setZoom(state, value) {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
    if (clamped === state.zoom) {
        return;
    }
    state.zoom = clamped;
    if (state.zoomLabel) {
        state.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    }
    if (state.zoom <= 1 && state.type === 'image') {
        state.panX = 0;
        state.panY = 0;
    }
    applyTransforms(state);
}

function applyTransforms(state) {
    if (!state.contentElement) return;
    if (state.type === 'image') {
        state.contentElement.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    } else {
        state.contentElement.style.transform = `scale(${state.zoom})`;
        state.contentElement.style.transformOrigin = 'top left';
    }
    if (state.zoomLabel) {
        state.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    }
}

function renderEntryContent(container, entry, state) {
    if (!entry?.data) {
        container.innerHTML = '<div class="multi-preview-placeholder text-muted">Preview unavailable.</div>';
        return;
    }
    const type = entry.data.type;
    switch (type) {
        case 'image':
            renderImageContent(container, entry, state);
            break;
        case 'pdf':
            renderPdfContent(container, entry);
            break;
        case 'code':
            renderCodeContent(container, entry, state);
            break;
        case 'text':
            renderTextContent(container, entry, state);
            break;
        case 'notice':
            renderNoticeContent(container, entry, state);
            break;
        default:
            renderBinaryContent(container, entry, state);
            break;
    }
}

function renderImageContent(container, entry, state) {
    container.innerHTML = '';
    const viewport = document.createElement('div');
    viewport.className = 'multi-preview-viewport is-pannable';
    const img = document.createElement('img');
    img.className = 'multi-preview-image';
    img.src = entry.data.url || fetchFileUrl(entry.path);
    img.alt = entry.title;
    img.draggable = false;
    img.style.userSelect = 'none';
    viewport.appendChild(img);
    container.appendChild(viewport);

    state.contentElement = img;
    state.viewport = viewport;
    applyTransforms(state);
    enableImagePanning(viewport, state);
    enableWheelZoom(viewport, state);
}

function renderPdfContent(container, entry) {
    container.innerHTML = '';
    const frame = document.createElement('iframe');
    frame.className = 'multi-preview-iframe';
    const url = entry.data.url || fetchFileUrl(entry.path);
    frame.src = `${url}#toolbar=0&navpanes=0`;
    frame.title = entry.title;
    container.appendChild(frame);
}

function renderTextContent(container, entry, state) {
    container.innerHTML = '';
    const viewport = document.createElement('div');
    viewport.className = 'multi-preview-viewport scrollable';
    const wrapper = document.createElement('div');
    wrapper.className = 'multi-preview-content';
    const pre = document.createElement('pre');
    pre.className = 'multi-preview-text';
    pre.textContent = entry.data.content || '';
    wrapper.appendChild(pre);
    viewport.appendChild(wrapper);
    container.appendChild(viewport);

    state.contentElement = wrapper;
    state.viewport = viewport;
    applyTransforms(state);
    enableWheelZoom(viewport, state);
}

function renderCodeContent(container, entry, state) {
    container.innerHTML = '';
    const viewport = document.createElement('div');
    viewport.className = 'multi-preview-viewport scrollable';
    const wrapper = document.createElement('div');
    wrapper.className = 'multi-preview-content';
    const pre = document.createElement('pre');
    const language = String(entry.data.language || 'plain').toLowerCase();
    const languageClass = `language-${language}`;
    pre.className = `multi-preview-text ${languageClass}`;
    pre.dataset.language = language;
    const code = document.createElement('code');
    code.className = languageClass;
    code.textContent = entry.data.content || '';
    pre.appendChild(code);
    wrapper.appendChild(pre);
    viewport.appendChild(wrapper);
    container.appendChild(viewport);
    state.contentElement = wrapper;
    state.viewport = viewport;
    applyTransforms(state);
    highlightCodeBlock(code);
    enableWheelZoom(viewport, state);
}

function renderNoticeContent(container, entry, state) {
    container.innerHTML = '';
    const viewport = document.createElement('div');
    viewport.className = 'multi-preview-viewport scrollable';
    const wrapper = document.createElement('div');
    wrapper.className = 'multi-preview-content';
    const block = document.createElement('div');
    block.className = 'multi-preview-placeholder text-muted';
    block.textContent = entry.data.message || 'Preview not available. Use the Open externally button.';
    wrapper.appendChild(block);
    viewport.appendChild(wrapper);
    container.appendChild(viewport);
    state.contentElement = wrapper;
    state.viewport = viewport;
    applyTransforms(state);
    enableWheelZoom(viewport, state);
}

function renderBinaryContent(container, entry, state) {
    container.innerHTML = '';
    const viewport = document.createElement('div');
    viewport.className = 'multi-preview-viewport scrollable';
    const wrapper = document.createElement('div');
    wrapper.className = 'multi-preview-content';
    const block = document.createElement('div');
    block.className = 'multi-preview-placeholder text-muted';
    block.textContent = 'This file type cannot be previewed. Use the Open externally button.';
    wrapper.appendChild(block);
    viewport.appendChild(wrapper);
    container.appendChild(viewport);
    state.contentElement = wrapper;
    state.viewport = viewport;
    applyTransforms(state);
    enableWheelZoom(viewport, state);
}

function enableImagePanning(viewport, state) {
    let pointerId = null;

    const stopPan = () => {
        if (!state.isPanning) return;
        state.isPanning = false;
        if (pointerId !== null) {
            viewport.releasePointerCapture(pointerId);
        }
        viewport.classList.remove('is-dragging');
        pointerId = null;
    };

    viewport.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || state.zoom <= 1) {
            return;
        }
        event.preventDefault();
        pointerId = event.pointerId;
        state.isPanning = true;
        state.pointerOffsetX = event.clientX - state.panX;
        state.pointerOffsetY = event.clientY - state.panY;
        viewport.setPointerCapture(pointerId);
        viewport.classList.add('is-dragging');
    });

    viewport.addEventListener('pointermove', (event) => {
        if (!state.isPanning || pointerId !== event.pointerId) {
            return;
        }
        state.panX = event.clientX - state.pointerOffsetX;
        state.panY = event.clientY - state.pointerOffsetY;
        applyTransforms(state);
    });

    viewport.addEventListener('pointerup', (event) => {
        if (pointerId === event.pointerId) {
            stopPan();
        }
    });

    viewport.addEventListener('pointercancel', stopPan);
    viewport.addEventListener('pointerleave', stopPan);
}

function enableWheelZoom(viewport, state) {
    if (!viewport) return;
    viewport.addEventListener(
        'wheel',
        (event) => {
            if (state.type === 'pdf') {
                return;
            }
            const requiresModifier = state.type !== 'image';
            if (requiresModifier && !(event.ctrlKey || event.metaKey)) {
                // For text/code/other: only Ctrl/Cmd + wheel should zoom; allow normal scroll otherwise.
                return;
            }
            event.preventDefault();
            const direction = event.deltaY > 0 ? -1 : 1;
            if (direction === 0) return;
            const normalizedStep = Math.min(Math.abs(event.deltaY) / 240, 3) || 1;
            adjustZoom(state, direction * ZOOM_STEP * normalizedStep);
        },
        { passive: false },
    );
}

function deriveNameFromPath(path) {
    if (!path) return 'File';
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts.pop() || normalized;
}

function highlightCodeBlock(codeElement) {
    const prism = window.Prism;
    if (!prism || typeof prism.highlightElement !== 'function') return;
    try {
        prism.highlightElement(codeElement);
    } catch (error) {
        console.warn('Syntax highlighting failed', error);
    }
}
