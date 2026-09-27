import { applyReferenceToImages, restoreImage, supportedImage } from '../preview/image_history.js';
import {
  state,
  setSelection,
  clearSelection,
  selectionArray,
  setClipboard,
  getClipboard,
  clearClipboard,
  updateCurrentPath,
} from '../../shared/state.js';
import {
  syncSelectionState,
  findItem,
  isImagePath,
  updateValidationState,
} from '../../shared/list.js';
import {
  openDeleteModal,
  openConflictDialog,
  showConfirmDialog,
  openFileTagsModal,
  openNotesModal,
} from '../modals/modals.js';
import { showToast, setStatus } from '../../shared/ui.js';
import {
  handleError,
  openInDefaultApp,
  copyItems,
  moveItems,
  revealInFileExplorer,
  updateRoot,
  setValidationState,
  createZipArchive,
  sendFileViaEmail,
} from '../../shared/api.js';
import { refreshTree } from './tree.js';
import { getPreviewedItem, clearPreview } from '../preview/preview.js';
import { isInvalidDestination, normalizePath } from '../../shared/paths.js';
import { requestGlobalRefresh } from '../../shared/refresh.js';
import { openWithGreenshot } from '../preview/greenshot.js';
import { openMultiPreview } from '../preview/multi_preview.js';

const EMAIL_ATTACHMENT_SIZE_LIMIT = 34 * 1024 * 1024;
const EMAIL_ATTACHMENT_COUNT_LIMIT = 20;

let menuElement = null;
let menuListElement = null;
let currentContext = null;
let folderChangeHandler = null;

/**
 * Initialise the custom context menu system.
 *
 * @param {(path: string, includeSubfolders: boolean) => Promise<void>|void} onFolderChange
 */
export function initContextMenu(onFolderChange) {
  folderChangeHandler = typeof onFolderChange === 'function' ? onFolderChange : null;
  if (menuElement) return;

  menuElement = document.createElement('div');
  menuElement.className = 'context-menu';
  menuElement.style.left = '-9999px';
  menuElement.style.top = '-9999px';
  menuElement.setAttribute('aria-hidden', 'true');
  menuElement.addEventListener('contextmenu', (event) => event.preventDefault());

  menuListElement = document.createElement('ul');
  menuListElement.className = 'context-menu-list';
  menuListElement.setAttribute('role', 'menu');
  menuElement.appendChild(menuListElement);

  document.body.appendChild(menuElement);

  document.addEventListener('contextmenu', handleContextMenu, { capture: true });
  document.addEventListener('pointerdown', handleGlobalPointer, { capture: true });
  document.addEventListener('keydown', handleGlobalKeydown, true);
  window.addEventListener('resize', hideMenu);
  window.addEventListener('scroll', hideMenu, true);
  window.addEventListener('blur', hideMenu);
}

function handleContextMenu(event) {
  const appShell = document.getElementById('app');
  if (!appShell || !appShell.contains(event.target)) {
    return;
  }

  if (isEditableTarget(event.target)) {
    hideMenu();
    return;
  }

  const context = resolveContext(event.target);
  event.preventDefault();
  hideMenu();
  if (!context || !menuElement || !menuListElement) {
    return;
  }

  currentContext = context;
  applyContextSelection(context);
  const items = buildMenuItems(context);
  if (!items.length) {
    return;
  }
  renderMenu(items);
  positionMenu(event.clientX, event.clientY);
}

function handleGlobalPointer(event) {
  if (!menuElement?.classList.contains('visible')) {
    return;
  }
  if (menuElement.contains(event.target)) {
    return;
  }
  hideMenu();
}

function handleGlobalKeydown(event) {
  if (event.key === 'Escape') {
    hideMenu();
  }
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, [contenteditable="true"]'));
}

function resolveContext(target) {
  if (!(target instanceof Element)) return null;

  const fileRow = target.closest('tr[data-path]');
  if (fileRow) {
    const path = fileRow.dataset.path || '';
    const isDir = fileRow.dataset.isDir === '1';
    const label =
      fileRow.querySelector('.file-label')?.textContent?.trim() || path.split('/').pop() || path;
    return {
      type: isDir ? 'folder' : 'file',
      panel: 'list',
      path,
      isDir,
      label,
      fallbackKind: isDir ? 'folder' : 'file',
    };
  }

  const fileCard = target.closest('.file-card[data-path]');
  if (fileCard) {
    const path = fileCard.dataset.path || '';
    const isDir = fileCard.dataset.isDir === '1';
    const label =
      fileCard.querySelector('.file-label')?.textContent?.trim() || path.split('/').pop() || path;
    return {
      type: isDir ? 'folder' : 'file',
      panel: 'list',
      path,
      isDir,
      label,
      fallbackKind: isDir ? 'folder' : 'file',
    };
  }

  const treeNode = target.closest('.tree-node[data-path]');
  if (treeNode) {
    const path = treeNode.dataset.path || '.';
    const label =
      treeNode.querySelector('.tree-toggle span:last-child')?.textContent?.trim() ||
      path.split('/').pop() ||
      path;
    return { type: 'folder', panel: 'tree', path, isDir: true, label, fallbackKind: 'folder' };
  }

  const treePane = document.getElementById('tree-pane');
  if (treePane?.contains(target)) {
    return {
      type: 'tree-empty',
      panel: 'tree',
      path: state.currentPath,
      isDir: true,
      label: null,
      fallbackKind: 'folder',
    };
  }

  const listPane = document.getElementById('list-pane');
  if (listPane?.contains(target)) {
    return { type: 'empty', panel: 'list', path: state.currentPath, isDir: false, label: null };
  }

  const previewPane = document.getElementById('preview-pane');
  if (previewPane?.contains(target)) {
    const previewItem = getPreviewedItem();
    if (previewItem) {
      const label = previewItem.displayName || previewItem.name || previewItem.path;
      return {
        type: 'file',
        panel: 'preview',
        path: previewItem.path,
        isDir: false,
        label,
        fallbackKind: 'file',
      };
    }
    return {
      type: 'preview-empty',
      panel: 'preview',
      path: state.currentPath,
      isDir: false,
      label: null,
    };
  }

  return null;
}

function applyContextSelection(context) {
  if (context.type === 'file' || context.type === 'folder') {
    if (context.panel === 'list') {
      const selected = selectionArray();
      if (!selected.includes(context.path)) {
        setSelection([context.path]);
      }
    } else {
      setSelection([context.path]);
    }
    syncSelectionState();
  } else if (
    context.type === 'empty' ||
    context.type === 'preview-empty' ||
    context.type === 'tree-empty'
  ) {
    clearSelection();
    syncSelectionState();
  }
}

function renderMenu(items) {
  if (!menuElement || !menuListElement) return;
  menuListElement.innerHTML = '';
  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    if (item === 'divider') {
      const divider = document.createElement('li');
      divider.className = 'context-menu-divider';
      divider.setAttribute('role', 'separator');
      fragment.appendChild(divider);
      return;
    }
    const entry = document.createElement('li');
    entry.className = 'context-menu-entry';
    entry.setAttribute('role', 'none');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'context-menu-item';
    button.textContent = item.label;
    button.setAttribute('role', 'menuitem');
    if (item.disabled) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    }
    if (item.danger) {
      button.classList.add('danger');
    }
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideMenu();
      if (typeof item.action === 'function') {
        try {
          await item.action();
        } catch (error) {
          handleError(error);
        }
      }
    });
    entry.appendChild(button);
    fragment.appendChild(entry);
  });
  menuListElement.appendChild(fragment);
}

function positionMenu(x, y) {
  if (!menuElement) return;
  menuElement.classList.remove('visible');
  menuElement.style.left = `${x}px`;
  menuElement.style.top = `${y}px`;
  menuElement.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    menuElement.classList.add('visible');
    const rect = menuElement.getBoundingClientRect();
    let left = x;
    let top = y;
    if (rect.right > window.innerWidth) {
      left = Math.max(8, window.innerWidth - rect.width - 8);
    }
    if (rect.bottom > window.innerHeight) {
      top = Math.max(8, window.innerHeight - rect.height - 8);
    }
    menuElement.style.left = `${left}px`;
    menuElement.style.top = `${top}px`;
  });
}

function hideMenu() {
  if (!menuElement) return;
  menuElement.classList.remove('visible');
  menuElement.style.left = '-9999px';
  menuElement.style.top = '-9999px';
  menuElement.setAttribute('aria-hidden', 'true');
  currentContext = null;
}

async function sendSelectionViaEmail(selection) {
  if (!Array.isArray(selection) || !selection.length) {
    showToast('Select at least one file to email.', true);
    return;
  }
  const items = selection.map((path) => findItem(path)).filter(Boolean);
  if (!items.length) {
    showToast('Unable to find selected items.', true);
    return;
  }
  if (items.some((item) => item.is_dir)) {
    showToast('Email supports files or archives only.', true);
    return;
  }
  if (items.length > EMAIL_ATTACHMENT_COUNT_LIMIT) {
    showToast(`Select ${EMAIL_ATTACHMENT_COUNT_LIMIT} or fewer items to email.`, true);
    return;
  }
  const sizes = items.map((item) => Number(item.size)).filter((value) => Number.isFinite(value));
  const totalSize = sizes.reduce((sum, value) => sum + value, 0);
  if (sizes.length === items.length && totalSize > EMAIL_ATTACHMENT_SIZE_LIMIT) {
    const limitMb = Math.floor(EMAIL_ATTACHMENT_SIZE_LIMIT / (1024 * 1024));
    showToast(`Total attachments exceed ${limitMb} MB.`, true);
    return;
  }
  await sendFileViaEmail(selection);
  showToast('Opening email client...');
}

function buildMenuItems(context) {
  switch (context.type) {
    case 'file':
      return buildFileMenu(context);
    case 'folder':
      return buildFolderMenu(context);
    case 'empty':
    case 'preview-empty':
      return buildEmptyMenu(context);
    case 'tree-empty':
      return buildTreeEmptyMenu(context);
    default:
      return [];
  }
}

function buildFileMenu(context) {
  const selection = getActiveSelection(context);
  const multiple = selection.length > 1;
  const canOpenWithGreenshot = !multiple && selection.length === 1 && isImagePath(selection[0]);
  const allFiles = selection.every((path) => {
    const item = findItem(path);
    return item && !item.is_dir;
  });
  const targetValidated = isPathValidated(context.path);
  const items = [];
  items.push({
    label: 'Open File',
    disabled: multiple,
    action: multiple
      ? null
      : async () => {
          await openInDefaultApp(context.path);
        },
  });
  items.push({
    label: 'Send via Email',
    disabled: !selection.length || !allFiles,
    action: () => sendSelectionViaEmail(selection),
  });
  if (selection.length && allFiles && selection.every(supportedImage)) {
    items.push({
      label: 'Apply annotations from reference...',
      action: () => applyReferenceToImages(selection),
    });
    if (!multiple) {
      items.push({
        label: 'Restore previous version...',
        action: () => restoreImage(selection[0]),
      });
    }
  }
  const canMultiFullscreen = selection.length >= 2 && selection.length <= 4 && allFiles;
  if (canMultiFullscreen) {
    items.push({
      label: `Open ${selection.length} Files Fullscreen`,
      action: () => openMultiPreview(selection),
    });
  }
  if (canOpenWithGreenshot) {
    items.push({
      label: 'Open in Greenshot',
      action: () => openWithGreenshot(selection[0]),
    });
  }
  items.push('divider');
  items.push({
    label: multiple ? `Copy ${selection.length} Items` : 'Copy File',
    action: () => prepareClipboard('copy', selection, context.fallbackKind || 'file'),
  });
  items.push({
    label: multiple ? `Move ${selection.length} Items` : 'Move File',
    action: () => prepareClipboard('move', selection, context.fallbackKind || 'file'),
  });
  items.push({
    label: 'Create ZIP Archive',
    action: () => createArchive(selection, state.currentPath || '.'),
  });
  items.push('divider');
  items.push({
    label: multiple ? 'Rename (first item)' : 'Rename File',
    disabled: selection.length !== 1,
    action: () => triggerInlineRename(selection[0]),
  });
  items.push({
    label: 'Manage Notes',
    disabled: selection.length !== 1,
    action: () => openNotesModal(selection[0], context.label),
  });
  items.push({
    label: targetValidated ? 'Unvalidate' : 'Validate',
    disabled: !selection.length || !allFiles,
    action: () => toggleValidation(selection, targetValidated),
  });
  items.push({
    label: multiple ? 'Edit Tags (all selected)' : 'Edit Tags',
    disabled: !selection.length || !allFiles,
    action: () => openFileTagsModal(selection, context.label),
  });
  items.push({
    label: multiple ? `Delete ${selection.length} Items` : 'Delete File',
    action: () => openDeleteModal(selection),
    danger: true,
    disabled: !selection.length,
  });
  items.push('divider');
  items.push({
    label: 'Show in File Explorer',
    disabled: selection.length !== 1,
    action: () => revealExplorer(context.path, false),
  });
  return items;
}

function buildFolderMenu(context) {
  const selection = getActiveSelection(context);
  const multiple = selection.length > 1;
  const items = [];
  items.push({
    label: 'Open Folder',
    action: () => navigateToFolder(context.path, context.panel === 'tree' ? 'tree' : 'list'),
  });
  items.push('divider');
  items.push({
    label: multiple ? `Copy ${selection.length} Items` : 'Copy Folder',
    action: () => prepareClipboard('copy', selection, 'folder'),
  });
  items.push({
    label: multiple ? `Move ${selection.length} Items` : 'Move Folder',
    action: () => prepareClipboard('move', selection, 'folder'),
  });
  const clipboard = getClipboard();
  if (clipboard?.items?.length) {
    items.push({
      label: `${describeClipboardAction(clipboard)} into Folder`,
      disabled:
        clipboard.operation === 'move' && isInvalidDestination(clipboard.items, context.path),
      action: () => pasteInto(context.path),
    });
  }
  items.push({
    label: 'Create ZIP Archive',
    action: () => {
      const destination =
        context.panel === 'tree' ? parentPath(context.path) || '.' : state.currentPath || '.';
      return createArchive(selection, destination);
    },
  });
  items.push('divider');
  items.push({
    label: multiple ? 'Rename (first item)' : 'Rename Folder',
    disabled: !selection.length || (selection.length === 1 && isRootPath(selection[0])),
    action: () => renameFolderContext(selection[0], context.panel),
  });
  items.push({
    label: 'Manage Notes',
    disabled: selection.length !== 1,
    action: () => openNotesModal(selection[0], context.label),
  });
  items.push({
    label: multiple ? `Delete ${selection.length} Items` : 'Delete Folder',
    danger: true,
    disabled: selection.some((path) => isRootPath(path)),
    action: () => openDeleteModal(selection),
  });
  items.push('divider');
  items.push({
    label: 'Set as root folder',
    disabled: selection.length !== 1 || isRootPath(selection[0]),
    action: () => confirmSetRoot(selection[0]),
  });
  items.push({
    label: 'Show in File Explorer',
    disabled: selection.length !== 1,
    action: () => revealExplorer(context.path, true),
  });
  return items;
}

function buildEmptyMenu(context) {
  const clipboard = getClipboard();
  const destination = context.path || state.currentPath || '.';
  const items = [];
  items.push({
    label: 'Create New Folder',
    action: () => document.getElementById('action-new-folder')?.click(),
  });
  items.push({
    label: 'Create New File',
    action: () => document.getElementById('action-new-file')?.click(),
  });
  items.push('divider');
  items.push({
    label: clipboard ? describeClipboardLabel(clipboard) : 'Paste',
    disabled:
      !clipboard?.items?.length ||
      (clipboard.operation === 'move' && isInvalidDestination(clipboard.items, destination)),
    action: () => pasteInto(destination),
  });
  items.push('divider');
  items.push({
    label: 'Open Current Folder in File Explorer',
    action: () => revealExplorer(destination, true),
  });
  items.push({
    label: 'Capture',
    action: () => document.getElementById('action-capture')?.click(),
  });
  items.push({
    label: 'Go to Parent Folder',
    disabled: !parentPath(destination),
    action: async () => {
      const parent = parentPath(destination);
      if (parent) {
        await navigateToFolder(parent, 'tree');
      }
    },
  });
  return items;
}

function buildTreeEmptyMenu(context) {
  const clipboard = getClipboard();
  const destination = context.path || state.currentPath || '.';
  const items = [];
  items.push({
    label: 'Refresh Folders',
    action: () => refreshTree(state.currentPath),
  });
  items.push({
    label: clipboard ? `${describeClipboardLabel(clipboard)} into Current Folder` : 'Paste',
    disabled:
      !clipboard?.items?.length ||
      (clipboard.operation === 'move' && isInvalidDestination(clipboard.items, destination)),
    action: () => pasteInto(destination),
  });
  items.push({
    label: 'Open Current Folder in File Explorer',
    action: () => revealExplorer(destination, true),
  });
  return items;
}

function getActiveSelection(context) {
  const selection = selectionArray();
  if (selection.length && selection.includes(context.path)) {
    return [...selection];
  }
  return [context.path];
}

function prepareClipboard(operation, paths, fallbackKind) {
  if (!Array.isArray(paths) || !paths.length) return;
  const unique = [...new Set(paths.map(String))];
  const kind = determineSelectionKind(unique, fallbackKind);
  setClipboard({ operation, items: unique, kind, source: currentContext?.panel || null });
  const descriptor = describeItems(kind, unique.length);
  const verb = operation === 'move' ? 'move' : 'copy';
  showToast(`${descriptor} ready to ${verb}.`);
}

function determineSelectionKind(paths, fallback) {
  let hasFiles = false;
  let hasFolders = false;
  const fallbackKind = fallback || 'mixed';
  paths.forEach((path) => {
    const item = findItem(path);
    if (item) {
      if (item.is_dir) {
        hasFolders = true;
      } else {
        hasFiles = true;
      }
      return;
    }
    if (fallbackKind === 'folder') {
      hasFolders = true;
    } else if (fallbackKind === 'file') {
      hasFiles = true;
    } else {
      hasFiles = true;
      hasFolders = true;
    }
  });
  if (hasFiles && hasFolders) return 'mixed';
  if (hasFolders) return 'folder';
  return 'file';
}

function describeItems(kind, count) {
  if (count === 1) {
    if (kind === 'folder') return 'Folder';
    if (kind === 'file') return 'File';
    return 'Item';
  }
  if (kind === 'folder') return `${count} folders`;
  if (kind === 'file') return `${count} files`;
  return `${count} items`;
}

function describeClipboardLabel(clipboard) {
  return clipboard?.items?.length
    ? `Paste ${describeItems(clipboard.kind, clipboard.items.length)}`
    : 'Paste';
}

function describeClipboardAction(clipboard) {
  const noun = describeItems(clipboard.kind, clipboard.items.length);
  return clipboard.operation === 'move' ? `Move ${noun}` : `Copy ${noun}`;
}

function isPathValidated(path) {
  const item = findItem(path);
  if (item && !item.is_dir) {
    return Boolean(item.validated);
  }
  const key = normalizePath(path);
  if (!key) return false;
  return Boolean(state.validation?.[key]);
}

async function toggleValidation(selection, currentlyValidated) {
  const files = selection.filter((path) => {
    const item = findItem(path);
    return item && !item.is_dir;
  });
  if (!files.length) {
    showToast('Select at least one file to validate.', true);
    return;
  }
  const desired = !currentlyValidated;
  setStatus(desired ? 'Validating...' : 'Clearing validation...');
  try {
    const updatedPaths = [];
    for (const path of files) {
      const response = await setValidationState(path, desired);
      updatedPaths.push(response?.path || normalizePath(path) || path);
    }
    updateValidationState(updatedPaths, desired);
    showToast(desired ? 'Marked as validated' : 'Validation removed');
  } catch (error) {
    handleError(error);
  } finally {
    setStatus('Saved/Idle');
  }
}

async function createArchive(selection, destination) {
  if (!Array.isArray(selection) || !selection.length) {
    showToast('Select at least one item to archive.', true);
    return null;
  }
  const target = destination && destination !== '' ? destination : '.';
  setStatus('Creating ZIP archive...');
  try {
    const result = await createZipArchive({ items: selection, destination: target });
    const archiveName = result?.name || 'archive.zip';
    showToast(`Archive created: ${archiveName}`);
    if (normalizePath(target) === normalizePath(state.currentPath)) {
      requestGlobalRefresh({ refreshTree: false });
    }
    return result;
  } catch (error) {
    handleError(error);
    return null;
  } finally {
    setStatus('Saved/Idle');
  }
}

async function pasteInto(destination) {
  const clipboard = getClipboard();
  if (!clipboard || !clipboard.items?.length) return;
  const target = destination && destination !== '' ? destination : '.';
  if (clipboard.operation === 'move' && isInvalidDestination(clipboard.items, target)) {
    showToast('Cannot move an item into itself or its subfolder.', true);
    return;
  }

  const operationSelect = document.getElementById('conflict-operation');
  if (operationSelect) {
    operationSelect.value = clipboard.operation === 'move' ? 'move' : 'copy';
  }
  const response = await openConflictDialog(target);
  if (!response) return;
  const operation = response.operation === 'copy' ? 'copy' : 'move';
  try {
    setStatus(operation === 'copy' ? 'Copying…' : 'Moving…');
    if (operation === 'copy') {
      await copyItems(clipboard.items, target, response.conflict);
    } else {
      await moveItems(clipboard.items, target, response.conflict);
      if (clipboard.operation === 'move') {
        clearClipboard();
      }
    }
    const message = operation === 'copy' ? 'Items copied.' : 'Items moved.';
    showToast(message);
    requestGlobalRefresh();
  } catch (error) {
    handleError(error);
  } finally {
    setStatus('Saved/Idle');
  }
}

async function confirmSetRoot(path) {
  const normalized = normalizePath(path);
  const relative = normalized || '.';
  const absolute = resolveAbsolutePath(relative);
  const display = absolute || '/';
  const confirmed = await showConfirmDialog(
    `Set "${display}" as the application root?`,
    'Set root folder'
  );
  if (!confirmed) return;
  try {
    setStatus('Updating root…');
    const result = await updateRoot(absolute);
    state.root = result.root || absolute;
    const appShell = document.getElementById('app');
    if (appShell) {
      appShell.dataset.root = state.root || '.';
    }
    resetStateAfterRootChange();
    showToast('Root folder updated');
    requestGlobalRefresh({ refreshList: true, refreshTree: true });
  } catch (error) {
    handleError(error);
  } finally {
    setStatus('Saved/Idle');
  }
}

function resetStateAfterRootChange() {
  clearSelection();
  updateCurrentPath('.', false);
  state.navigation = { stack: ['.'], index: 0 };
  state.includeSubfolders = false;
  syncSelectionState();
  clearPreview();
}

function resolveAbsolutePath(relativePath) {
  const appShell = document.getElementById('app');
  const baseRaw = state.root || appShell?.dataset.root || '.';
  const baseNormalized = (baseRaw || '.').replace(/\\/g, '/');
  const relativeNormalized = (
    !relativePath || relativePath === '.' ? '' : relativePath.replace(/\\/g, '/')
  ).replace(/^\.\//, '');
  if (!relativeNormalized) {
    return baseNormalized;
  }
  const trimmedBase = baseNormalized === '/' ? '/' : baseNormalized.replace(/\/+$/, '');
  const separator = trimmedBase === '/' ? '' : '/';
  return `${trimmedBase}${separator}${relativeNormalized}`;
}

async function navigateToFolder(path, source = 'nav') {
  const target = path && path !== '' ? path : '.';
  updateCurrentPath(target, false);
  clearSelection();
  syncSelectionState();
  if (folderChangeHandler) {
    await folderChangeHandler(target, false, { source });
  } else {
    requestGlobalRefresh();
  }
}

function parentPath(path) {
  const normalised = normalizePath(path);
  if (!normalised) return null;
  const parts = normalised.split('/');
  parts.pop();
  return parts.length ? parts.join('/') : '.';
}

async function renameFolderContext(path, panel) {
  if (!path || isRootPath(path)) return;
  if (panel === 'list') {
    triggerInlineRename(path);
    return;
  }
  const parent = parentPath(path);
  if (parent) {
    await navigateToFolder(parent, 'tree');
    setSelection([path]);
    syncSelectionState();
    triggerInlineRename(path);
  }
}

function triggerInlineRename(path) {
  if (!path) return;
  setSelection([path]);
  syncSelectionState();
  document.getElementById('action-rename')?.click();
}

function isRootPath(path) {
  return normalizePath(path) === normalizePath('.') || normalizePath(path) === '';
}

async function revealExplorer(path, preferFolder) {
  const target = path && path !== '' ? path : '.';
  try {
    await revealInFileExplorer(target, !preferFolder);
    showToast('Opened in File Explorer');
  } catch (error) {
    handleError(error);
  }
}
