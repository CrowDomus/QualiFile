import { fetchTree, handleError } from '../../shared/api.js';
import { updateCurrentPath, clearSelection } from '../../shared/state.js';
import { setStatus, showToast } from '../../shared/ui.js';
import { normalizePath } from '../../shared/paths.js';
import {
  createLoadingOperation,
  ensureLoadingModalClosed,
  isAbortError,
} from '../modals/loading_modal.js';

let container = null;
let onSelectCallback = () => {};
const expandOperations = new Map();
const TREE_ICON_STATE_CLASSES = ['tree-icon-collapsed', 'tree-icon-expanded', 'tree-icon-empty'];

export async function initTree(onSelect, initialSelection = '.') {
  container = document.getElementById('folder-tree');
  if (!container) return;
  onSelectCallback = onSelect;
  container.innerHTML = '';
  const rootNode = createTreeNode({ name: 'Root', path: '.', has_children: true });
  rootNode.dataset.loaded = '0';
  container.appendChild(rootNode);
  await expandNode(rootNode, true);
  if (initialSelection && initialSelection !== '.') {
    await revealPath(initialSelection);
    highlightTree(initialSelection);
  } else {
    highlightTree('.');
  }
}

export async function refreshTree(selectionPath = '.') {
  if (!container) return;
  await initTree(onSelectCallback, selectionPath);
}

export function highlightTree(path) {
  if (!container) return;
  const target = canonicalTreePath(path);
  container.querySelectorAll('.tree-toggle').forEach((btn) => {
    const isMatch = btn.dataset.path === target;
    btn.classList.toggle('active', isMatch);
    btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    const node = btn.closest('.tree-node');
    if (node) {
      node.classList.toggle('tree-node-active', isMatch);
    }
  });
}

export async function syncTreeSelection(path, { scrollIntoView = true } = {}) {
  if (!container) return;
  await revealPath(path);
  highlightTree(path);
  if (scrollIntoView) {
    scrollTreeToPath(path);
  }
}

/** Create a tree node DOM element for a folder. */
function createTreeNode(data) {
  const normalizedPath = canonicalTreePath(data.path);
  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';
  wrapper.dataset.path = normalizedPath;

  const button = document.createElement('button');
  button.className = 'tree-toggle';
  button.type = 'button';
  button.dataset.path = normalizedPath;
  button.setAttribute('role', 'treeitem');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML =
    '<span class="tree-icon" aria-hidden="true"></span><span class="flex-grow-1 text-truncate"></span>';
  const icon = button.querySelector('.tree-icon');
  const label = button.querySelector('.text-truncate');
  if (label) {
    label.textContent = data.name;
  }
  if (icon) {
    setTreeIconState(icon, data.has_children ? 'collapsed' : 'empty');
  }

  const children = document.createElement('div');
  children.className = 'tree-children';
  children.setAttribute('role', 'group');

  button.addEventListener('click', (event) => {
    event.preventDefault();
    selectFolder(normalizedPath, false);
  });

  button.addEventListener('dblclick', async (event) => {
    event.preventDefault();
    await selectFolder(normalizedPath, true);
    if (data.has_children) {
      await expandNode(wrapper, true);
    }
  });

  button.addEventListener('keydown', async (event) => {
    if (event.key === 'ArrowRight') {
      await expandNode(wrapper, true);
    }
    if (event.key === 'ArrowLeft') {
      collapseNode(wrapper);
    }
    if (event.key === 'Enter') {
      await selectFolder(normalizedPath, false);
    }
  });

  if (data.has_children && icon) {
    icon.addEventListener('click', async (event) => {
      event.stopPropagation();
      const expanded = button.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        collapseNode(wrapper);
      } else {
        await expandNode(wrapper, false);
      }
    });
  }

  wrapper.appendChild(button);
  wrapper.appendChild(children);

  wrapper.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearTreeDropTargets();
    wrapper.classList.add('drop-target');
    event.dataTransfer.dropEffect = 'move';
  });

  wrapper.addEventListener('dragleave', (event) => {
    event.stopPropagation();
    if (!wrapper.contains(event.relatedTarget)) {
      wrapper.classList.remove('drop-target');
    }
  });

  wrapper.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearTreeDropTargets();
    const payload = parseDragData(event.dataTransfer);
    if (!payload?.items?.length) return;
    const destinationPath = event.currentTarget?.dataset?.path || normalizedPath || '.';
    document.dispatchEvent(
      new CustomEvent('qualifile:tree-drop', {
        detail: { items: payload.items, destination: destinationPath },
      })
    );
  });

  return wrapper;
}

/** Load and display children for a tree node. */
async function expandNode(node, forceReload) {
  const button = node.querySelector('.tree-toggle');
  if (!button) return;
  const path = node.dataset.path;
  if (button.getAttribute('aria-expanded') === 'true' && !forceReload) {
    return;
  }
  const existing = expandOperations.get(path);
  if (existing) {
    existing.cancel({ silent: true });
  }
  const loading = createLoadingOperation({
    message: 'Loading folder...',
    detail: path === '.' ? 'Root' : path,
  });
  expandOperations.set(path, loading);
  try {
    setStatus('Loading…');
    const data = await fetchTree(path, { signal: loading.signal });
    if (loading.isAborted()) return;
    populateChildren(node, data.children || []);
    button.setAttribute('aria-expanded', 'true');
    const icon = button.querySelector('.tree-icon');
    if (icon) setTreeIconState(icon, data.children.length ? 'expanded' : 'empty');
  } catch (error) {
    if (!loading.isAborted() && !isAbortError(error)) {
      handleError(error);
    }
  } finally {
    loading.finish();
    if (expandOperations.get(path) === loading) {
      expandOperations.delete(path);
    }
    setStatus('Saved/Idle');
    ensureLoadingModalClosed();
  }
}

/** Collapse a tree node and remove its children. */
function collapseNode(node) {
  const button = node.querySelector('.tree-toggle');
  if (!button) return;
  const children = node.querySelector('.tree-children');
  if (children) {
    children.innerHTML = '';
  }
  button.setAttribute('aria-expanded', 'false');
  const icon = button.querySelector('.tree-icon');
  if (icon && icon.dataset.state !== 'empty') {
    setTreeIconState(icon, 'collapsed');
  }
}

/** Populate a node with child folder elements. */
function populateChildren(node, childrenData) {
  const container = node.querySelector('.tree-children');
  if (!container) return;
  container.innerHTML = '';
  for (const child of childrenData) {
    const childNode = createTreeNode(child);
    container.appendChild(childNode);
  }
}

/** Parse drag payloads dropped onto the tree. */
function parseDragData(dataTransfer) {
  try {
    const raw = dataTransfer.getData('application/json');
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function clearTreeDropTargets() {
  if (!container) return;
  container.querySelectorAll('.tree-node.drop-target').forEach((node) => {
    node.classList.remove('drop-target');
  });
}

export async function revealPath(path) {
  if (!container) return;
  const normalized = normalizePath(path);
  const parts = normalized ? normalized.split('/').filter(Boolean) : [];
  let currentNode = getTreeNode('.');
  if (!currentNode) return;
  if (!parts.length) {
    await expandNode(currentNode, false);
    return;
  }
  let currentPath = '.';
  for (const part of parts) {
    await expandNode(currentNode, false);
    currentPath = currentPath === '.' ? part : `${currentPath}/${part}`;
    const nextNode = getTreeNode(currentPath);
    if (!nextNode) {
      return;
    }
    currentNode = nextNode;
  }
}

function scrollTreeToPath(path) {
  if (!container) return;
  const node = getTreeNode(path);
  if (!node) return;
  const target = node.querySelector('.tree-toggle') || node;
  target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

function getTreeNode(path) {
  if (!container) return null;
  const target = canonicalTreePath(path);
  return container.querySelector(`.tree-node[data-path="${CSS.escape(target)}"]`);
}

/** Select a folder from the tree and update state. */
async function selectFolder(path, includeSubfolders) {
  const target = canonicalTreePath(path);
  updateCurrentPath(target, includeSubfolders);
  clearSelection();
  highlightTree(target);
  await onSelectCallback(target, includeSubfolders, { source: 'tree' });
  if (includeSubfolders) {
    showToast('Showing files with subfolders');
  }
}

function canonicalTreePath(path) {
  const normalized = normalizePath(path);
  return normalized || '.';
}

function setTreeIconState(icon, state) {
  icon.classList.remove(...TREE_ICON_STATE_CLASSES);
  icon.classList.add(`tree-icon-${state}`);
  icon.dataset.state = state;
  icon.textContent = '';
}
