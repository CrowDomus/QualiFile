import { fetchTree, browseRoot, handleError } from '../../shared/api.js';
import { state } from '../../shared/state.js';

let modalInstance = null;
let modalElement = null;
let pathLabel = null;
let listElement = null;
let upButton = null;
let selectButton = null;
let resolver = null;
let selectedChild = null;
let currentPath = '.';
let returnAbsolute = false;
let pickerMode = 'contained';
let basePath = null;
let currentAbsolutePath = null;

export function openFolderPicker({
  initialPath = null,
  title = 'Select folder',
  absolute = false,
  mode = 'contained',
} = {}) {
  ensureModal();
  const modalTitle = modalElement.querySelector('.modal-title');
  if (modalTitle && title) {
    modalTitle.textContent = title;
  }
  pickerMode = mode === 'system' ? 'system' : 'contained';
  basePath = null;
  currentAbsolutePath = null;
  currentPath = normalisePath(initialPath ?? state.currentPath ?? '.');
  selectedChild = null;
  returnAbsolute = Boolean(absolute);
  updatePathLabel();
  renderList([]);
  loadChildren(currentPath).catch(handleError);
  return new Promise((resolve) => {
    resolver = resolve;
    modalInstance.show();
  });
}

/** Ensure the folder picker modal DOM exists. */
function ensureModal() {
  if (modalInstance) return;
  modalElement = document.getElementById('modal-folder-picker');
  if (!modalElement) {
    throw new Error('Folder picker modal is missing.');
  }
  pathLabel = document.getElementById('folder-picker-path');
  listElement = document.getElementById('folder-picker-list');
  upButton = document.getElementById('folder-picker-up');
  selectButton = document.getElementById('folder-picker-select');
  if (!pathLabel || !listElement || !upButton || !selectButton) {
    throw new Error('Folder picker components are missing.');
  }
  modalInstance = bootstrap.Modal.getOrCreateInstance(modalElement);
  modalElement.addEventListener('hidden.bs.modal', () => {
    // Clear any lingering selection state so reopening is clean
    selectedChild = null;
    currentPath = '.';
    currentAbsolutePath = null;
    if (resolver) {
      resolver(null);
      resolver = null;
    }
  });
  upButton.addEventListener('click', () => {
    const parent = parentPath(currentPath);
    if (parent === currentPath) return;
    currentPath = parent;
    selectedChild = null;
    updatePathLabel();
    loadChildren(currentPath).catch(handleError);
  });
  selectButton.addEventListener('click', () => {
    if (!resolver) return;
    const value = selectedChild ?? currentPath;
    const relative = normalisePath(value);
    if (pickerMode === 'system') {
      resolver(resolveAbsolute(relative, basePath));
    } else {
      resolver(returnAbsolute ? resolveAbsolute(relative) : relative);
    }
    resolver = null;
    modalInstance.hide();
  });
}

/** Load child folders for the given path. */
async function loadChildren(path) {
  if (pickerMode === 'system') {
    const payload = await browseRoot(path, 'system');
    basePath = payload.base || basePath;
    currentPath = normalisePath(payload.relative || payload.path || path);
    currentAbsolutePath = payload.absolute || resolveAbsolute(currentPath, basePath);
    const children = Array.isArray(payload.children) ? payload.children : [];
    renderList(children);
  } else {
    const payload = await fetchTree(path);
    currentPath = normalisePath(payload.path || path);
    basePath = state.root || basePath;
    currentAbsolutePath = resolveAbsolute(currentPath, basePath);
    const children = Array.isArray(payload.children) ? payload.children : [];
    renderList(children);
  }
  updatePathLabel();
}

/** Render the current folder list inside the picker. */
function renderList(children) {
  if (!listElement) return;
  listElement.innerHTML = '';
  const emptyNotice = document.getElementById('folder-picker-empty');
  if (!children.length) {
    emptyNotice?.classList.remove('d-none');
    return;
  }
  emptyNotice?.classList.add('d-none');
  children.forEach((child) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      'list-group-item list-group-item-action d-flex justify-content-between align-items-center';
    button.dataset.path = child.path || child.name;
    const label = document.createElement('span');
    label.className = 'text-truncate';
    label.textContent = child.name;
    const arrow = document.createElement('span');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '>';
    button.append(label, arrow);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      selectedChild = button.dataset.path || null;
      highlightSelection();
    });
    button.addEventListener('dblclick', (event) => {
      event.preventDefault();
      const nextPath = button.dataset.path;
      if (!nextPath) return;
      currentPath = normalisePath(nextPath);
      selectedChild = null;
      updatePathLabel();
      loadChildren(currentPath).catch(handleError);
    });
    listElement.appendChild(button);
  });
  highlightSelection();
}

/** Highlight the active selection within the picker. */
function highlightSelection() {
  if (!listElement) return;
  listElement.querySelectorAll('.list-group-item').forEach((item) => {
    const path = item.dataset.path;
    const isSelected = selectedChild === path;
    item.classList.toggle('active', isSelected);
    item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  });
}

/** Update the displayed path label in the picker. */
function updatePathLabel() {
  if (pathLabel) {
    let display;
    if (pickerMode === 'system') {
      if (!basePath) {
        display = 'Loading\u2026';
      } else {
        const absolute = currentAbsolutePath || resolveAbsolute(currentPath, basePath);
        display = absolute || '/';
      }
    } else {
      display = currentPath === '.' ? '/' : `/${currentPath}`;
    }
    pathLabel.textContent = display;
  }
  if (upButton) {
    upButton.disabled = currentPath === '.';
  }
}

/** Normalise incoming paths for consistent handling. */
function normalisePath(path) {
  if (!path || path === '/' || path === '.') {
    return '.';
  }
  const normalised = path.replace(/\\/g, '/');
  const segments = normalised.split('/').filter(Boolean);
  const safe = [];
  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (safe.length) safe.pop();
      continue;
    }
    safe.push(segment);
  }
  return safe.length ? safe.join('/') : '.';
}

/** Return the parent path for navigation. */
function parentPath(path) {
  const normalised = normalisePath(path);
  if (normalised === '.') return '.';
  const segments = normalised.split('/').filter(Boolean);
  segments.pop();
  return segments.length ? segments.join('/') : '.';
}

/** Resolve absolute paths against the configured root. */
function resolveAbsolute(relative, baseOverride = null) {
  const base = baseOverride || state.root;
  if (!base) {
    return relative;
  }
  const root = base;
  if (relative === '.' || !relative) {
    return root;
  }
  const usesBackslash = root.includes('\\');
  const separator = usesBackslash ? '\\' : '/';
  const normalisedRoot = usesBackslash ? root.replace(/\//g, '\\') : root.replace(/\\/g, '/');
  const trimmedRoot = normalisedRoot.replace(/[\\/]+$/, '');
  const rootWithSeparator = `${trimmedRoot}${separator}`;
  const formattedRelative = (
    usesBackslash ? relative.replace(/\//g, '\\') : relative.replace(/\\/g, '/')
  ).replace(/^[\\/]+/, '');
  if (!formattedRelative) {
    return trimmedRoot || normalisedRoot || separator;
  }
  if (usesBackslash && /^[A-Za-z]:$/.test(trimmedRoot)) {
    return `${trimmedRoot}${separator}${formattedRelative}`;
  }
  return `${rootWithSeparator}${formattedRelative}`;
}
