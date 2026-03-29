import { requestJson } from '../../shared/api.js';
let modalInstance = null, modalElement = null, pathLabel = null, listElement = null, upButton = null, selectButton = null;
let errorElement = null, emptyElement = null, resolver = null, activeProjectId = null, currentPath = '.', parentPath = null, selectedPath = null, loadToken = 0;

function normalizePath(value) {
    const text = String(value || '').trim().replace(/\\/g, '/');
    if (!text || text === '/' || text === '.') return '.';
    return text.replace(/^\/+/, '').replace(/\/+$/, '') || '.';
}

function setError(message = '') {
    if (!errorElement) return;
    errorElement.textContent = message;
    errorElement.classList.toggle('d-none', !message);
}

function syncState() {
    if (listElement) {
        listElement.querySelectorAll('.list-group-item').forEach((entry) => {
            const isSelected = entry.dataset.path === selectedPath;
            entry.classList.toggle('active', isSelected);
            entry.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        });
    }
    if (pathLabel) {
        pathLabel.textContent = currentPath === '.' ? '/' : `/${currentPath}`;
    }
    if (upButton) upButton.disabled = !parentPath;
    if (selectButton) selectButton.disabled = !selectedPath;
}

function renderList(items) {
    if (!listElement) return;
    listElement.innerHTML = '';
    if (!items.length) { emptyElement?.classList.remove('d-none'); syncState(); return; }
    emptyElement?.classList.add('d-none');
    items.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const isDir = Boolean(item.is_dir);
        const relPath = normalizePath(item.rel_path || item.path || item.name);
        if (!relPath) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center';
        button.dataset.path = relPath;
        const label = document.createElement('span');
        label.className = 'text-truncate';
        label.textContent = String(item.name || relPath);
        const suffix = document.createElement('span');
        suffix.className = 'text-muted small';
        suffix.textContent = isDir ? 'Folder' : 'File';
        button.append(label, suffix);
        button.addEventListener('click', () => {
            if (isDir) { selectedPath = null; syncState(); void loadPath(relPath); return; }
            selectedPath = relPath;
            syncState();
        });
        listElement.appendChild(button);
    });
    syncState();
}

function resetState() {
    activeProjectId = null;
    currentPath = '.';
    parentPath = null;
    selectedPath = null;
    setError('');
    renderList([]);
}

function ensureModal() {
    if (modalInstance) return;
    modalElement = document.getElementById('modal-project-file-picker');
    if (!modalElement) throw new Error('Project file picker modal is missing.');
    pathLabel = document.getElementById('project-file-picker-path');
    listElement = document.getElementById('project-file-picker-list');
    upButton = document.getElementById('project-file-picker-up');
    selectButton = document.getElementById('project-file-picker-select');
    errorElement = document.getElementById('project-file-picker-error');
    emptyElement = document.getElementById('project-file-picker-empty');
    if (!pathLabel || !listElement || !upButton || !selectButton || !errorElement || !emptyElement) {
        throw new Error('Project file picker components are missing.');
    }
    modalInstance = bootstrap.Modal.getOrCreateInstance(modalElement);
    modalElement.addEventListener('hidden.bs.modal', () => {
        if (resolver) { resolver(null); resolver = null; }
        resetState();
    });
    upButton.addEventListener('click', () => { if (parentPath) void loadPath(parentPath); });
    selectButton.addEventListener('click', () => {
        if (!resolver || !selectedPath) return;
        resolver(selectedPath);
        resolver = null;
        modalInstance.hide();
    });
}

async function loadPath(path) {
    if (!activeProjectId) return;
    const token = ++loadToken;
    setError(''); selectedPath = null; syncState();
    const normalized = normalizePath(path);
    const url = `/api/projects/${encodeURIComponent(activeProjectId)}/browse?path=${encodeURIComponent(normalized)}`;
    try {
        const payload = await requestJson(url);
        if (token !== loadToken) return;
        currentPath = normalizePath(payload?.current_path);
        parentPath = payload?.parent_path === null ? null : normalizePath(payload?.parent_path);
        renderList(Array.isArray(payload?.items) ? payload.items : []);
    } catch (error) {
        if (token !== loadToken) return;
        setError(error?.message || 'Unable to browse files.');
    }
}

export function openProjectFilePicker({ projectId, initialPath = '.', title = 'Select file' } = {}) {
    if (!projectId) return Promise.reject(new Error('Project is required.'));
    ensureModal();
    const modalTitle = modalElement?.querySelector('.modal-title');
    if (modalTitle && title) modalTitle.textContent = title;
    activeProjectId = projectId;
    currentPath = normalizePath(initialPath);
    parentPath = null;
    selectedPath = null;
    setError('');
    renderList([]);
    void loadPath(currentPath);
    return new Promise((resolve) => {
        resolver = resolve;
        modalInstance.show();
    });
}
