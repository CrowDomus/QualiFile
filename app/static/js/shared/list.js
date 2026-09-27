import { fetchList, handleError, openInDefaultApp, renameItem } from './api.js';
import {
  state,
  setSelection,
  clearSelection,
  selectionArray,
  updateCurrentPath,
  persistPreferences,
} from './state.js';
import { showToast, setStatus } from './ui.js';
import { showPreview, clearPreview } from '../features/preview/preview.js';
import { requestGlobalRefresh, GLOBAL_REFRESH_EVENT } from './refresh.js';
import { normalizePath } from './paths.js';
import {
  buildCategoryGroups,
  buildTagLookup,
  escapeHtml,
  formatDate,
  formatSize,
  getTableColumnCount,
  iconForItem,
  renderNoteIndicators,
  renderTagBadges,
  renderValidationIcon,
  resolveTagColors,
} from './list_helpers.js';
import {
  createLoadingOperation,
  ensureLoadingModalClosed,
  isAbortError,
} from '../features/modals/loading_modal.js';
import { attachGridCardThumbnail } from './grid_thumbnails.js';

let tableBody = null;
let gridContainer = null;
let listView = null;
let gridView = null;
let selectAllCheckbox = null;
let filterInput = null;
let columnToggleElements = [];
let categorizeToggle = null;
let tagModeToggle = null;
let openFolderCallback = () => {};
let lastActivePath = null;
let listLoadOperation = null;
let advancedFilterToggle = null;
let advancedFilterBadge = null;
let advancedFilterPanel = null;
let advancedFilterStatus = null;
let advancedScopeRadios = [];
let advancedFolderInput = null;
let advancedModifiedSelect = null;
let advancedModifiedFrom = null;
let advancedModifiedTo = null;
let advancedCustomRange = null;
let advancedTagList = null;
let advancedFilterApplyButton = null;
let advancedFilterResetButton = null;
let advancedFilterCloseButton = null;
let rootListingCache = null;
let rootListingPromise = null;
let lastLoadedPath = null;
let rootScopeConfirmed = false;

function ensureFilterDefaults() {
  if (!state.filters) {
    state.filters = {};
  }
  state.filters.scope = state.filters.scope === 'root' ? 'root' : 'current';
  state.filters.tags = Array.isArray(state.filters.tags) ? state.filters.tags.filter(Boolean) : [];
  state.filters.modifiedPreset = state.filters.modifiedPreset || 'any';
  state.filters.modifiedFrom = state.filters.modifiedFrom || '';
  state.filters.modifiedTo = state.filters.modifiedTo || '';
  state.filters.folderName = state.filters.folderName || '';
}

export function initList(onFolderChange) {
  ensureFilterDefaults();
  tableBody = document.getElementById('file-rows');
  gridContainer = document.getElementById('file-grid');
  listView = document.getElementById('list-view');
  gridView = document.getElementById('grid-view');
  selectAllCheckbox = document.getElementById('select-all');
  filterInput = document.getElementById('filter-input');
  columnToggleElements = Array.from(document.querySelectorAll('.column-toggle'));
  columnToggleElements.forEach((checkbox) => {
    const key = checkbox.dataset.column;
    if (!key) return;
    if (key === 'name') {
      checkbox.checked = true;
      checkbox.disabled = true;
    } else if (state.columns[key] !== undefined) {
      checkbox.checked = !!state.columns[key];
    }
  });
  categorizeToggle = document.getElementById('categorize-toggle');
  if (categorizeToggle) {
    categorizeToggle.checked = !!state.categorizeFiles;
  }
  tagModeToggle = document.getElementById('tag-mode-toggle');
  updateTagModeToggle();
  initAdvancedFilters();
  openFolderCallback = onFolderChange;
  bindListEvents();
  updateViewMode(state.viewMode, false);
  updateSortIndicators();
  applyColumnVisibility();

  document.addEventListener('qualifile:tags-hierarchy-view-changed', (event) => {
    const enabled = !!event.detail?.enabled;
    if (!state.settings.tags) {
      state.settings.tags = {};
    }
    state.settings.tags.hierarchyView = enabled;
    if (state.categorizeFiles) {
      renderList();
    }
  });

  document.addEventListener('qualifile:tags-updated', () => {
    if (state.categorizeFiles) {
      renderList();
    }
  });
}

export async function loadList(includeSubfolders = false) {
  if (!tableBody) return;
  const pathChanged = lastLoadedPath !== state.currentPath;
  if (pathChanged) {
    resetAdvancedScopeToCurrent({ shouldRender: false });
  }
  state.includeSubfolders = includeSubfolders;
  if (listLoadOperation) {
    listLoadOperation.cancel({ silent: true });
  }
  const detail =
    state.currentPath && state.currentPath !== '.'
      ? `Reading ${state.currentPath}`
      : 'Reading root';
  const loading = createLoadingOperation({
    message: includeSubfolders ? 'Loading folders and files...' : 'Loading folder...',
    detail,
  });
  listLoadOperation = loading;
  try {
    setStatus('Loading…');
    const payload = await fetchList(state.currentPath, includeSubfolders, {
      signal: loading.signal,
    });
    if (loading.isAborted()) return;
    const items = Array.isArray(payload.items) ? payload.items : payload.items.entries || [];
    const subfolders = Array.isArray(payload.items) ? [] : payload.items.subfolders || [];
    state.items = items;
    state.subfolders = subfolders;
    state.tags = Array.isArray(payload.tags) ? payload.tags : [];
    renderAdvancedFilterTags();
    const validationMap = buildValidationAssignmentsRecursive(
      items,
      subfolders,
      payload.validation
    );
    state.validation = validationMap;
    applyValidationFlags(state.items, state.subfolders, validationMap);
    state.tagAssignments = buildTagAssignmentsRecursive(items, subfolders);
    maybeUpdateRootListingCache(includeSubfolders);
    syncAdvancedFilterBadge();
    updateAdvancedFilterStatusText();
    if (state.filters.scope === 'root' && !rootListingCache) {
      try {
        await ensureRootListing();
      } catch (error) {
        if (!isAbortError(error)) {
          handleError(error);
        }
        resetAdvancedScopeToCurrent({ shouldRender: false });
      }
    }
    renderList();
  } catch (error) {
    if (loading.isAborted() || isAbortError(error)) {
      return;
    }
    handleError(error);
  } finally {
    loading.finish();
    if (listLoadOperation === loading) {
      listLoadOperation = null;
    }
    lastLoadedPath = state.currentPath;
    setStatus('Saved/Idle');
    ensureLoadingModalClosed();
  }
}

/** Render the table and grid views based on filters. */
const collapsedCategories = new Set();

function renderList() {
  const items = applyViewFilters();
  if (state.categorizeFiles) {
    const hierarchyEnabled = !!(state.categorizeFiles && state.settings?.tags?.hierarchyView);
    const groups = buildCategoryGroups(items, state.tags, hierarchyEnabled);
    renderCategorizedTable(groups);
    renderCategorizedGrid(groups);
  } else {
    renderTable(items);
    renderGrid(items);
  }
  syncSelection(items);
  applyColumnVisibility();
}

/** Render the table representation of items. */
function renderTable(items) {
  if (!tableBody) return;
  tableBody.innerHTML = '';
  const tagLookup = buildTagLookup(state.tags);
  items.forEach((item, index) => {
    const row = createTableRow(item, index, tagLookup);
    tableBody.appendChild(row);
  });
}

/** Render the grid representation of items. */
function renderGrid(items) {
  if (!gridContainer) return;
  gridContainer.innerHTML = '';
  const tagLookup = buildTagLookup(state.tags);
  items.forEach((item) => {
    const card = createGridCard(item, tagLookup);
    gridContainer.appendChild(card);
  });
}

function renderCategorizedTable(groups) {
  if (!tableBody) return;
  tableBody.innerHTML = '';
  const tagLookup = buildTagLookup(state.tags);
  const columnCount = getTableColumnCount(tableBody);
  let rowIndex = 0;
  const hierarchyEnabled = !!groups?.hierarchyEnabled;
  const parentMap = groups?.parentMap || new Map();
  const isHiddenByAncestor = (id) => {
    let current = parentMap.get(id);
    while (current) {
      if (collapsedCategories.has(current)) return true;
      current = parentMap.get(current);
    }
    return false;
  };
  groups.forEach((group) => {
    if (hierarchyEnabled && isHiddenByAncestor(group.id)) {
      return;
    }
    const headerRow = document.createElement('tr');
    headerRow.className = 'category-header-row';
    headerRow.dataset.categoryId = group.id;
    const headerCell = document.createElement('td');
    headerCell.colSpan = columnCount;
    const header = document.createElement('div');
    header.className = 'category-header';
    header.style.setProperty('--category-color', group.color || '#6c757d');
    header.style.setProperty('--category-text-color', group.textColor || '#ffffff');
    header.style.setProperty('--category-chip-bg', group.accentBg || 'rgba(255, 255, 255, 0.25)');
    if (hierarchyEnabled && typeof group.depth === 'number') {
      header.dataset.depth = String(group.depth);
      header.style.setProperty('--category-depth', group.depth);
    }
    const title = document.createElement('span');
    title.className = 'category-title';
    title.textContent = group.name;
    const count = document.createElement('span');
    count.className = 'category-count';
    const displayedCount = hierarchyEnabled
      ? (group.totalItems ?? group.items.length)
      : group.items.length;
    count.textContent = `${displayedCount} ${displayedCount === 1 ? 'item' : 'items'}`;
    const collapsedSelf = collapsedCategories.has(group.id);
    if (collapsedSelf) {
      headerRow.classList.add('is-collapsed');
    }
    header.append(title, count);
    header.setAttribute('role', 'button');
    header.tabIndex = 0;
    header.addEventListener('click', () => toggleCategory(group.id));
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleCategory(group.id);
      }
    });
    headerCell.appendChild(header);
    headerRow.appendChild(headerCell);
    tableBody.appendChild(headerRow);
    const collapsed = collapsedSelf;
    group.items.forEach((item) => {
      const row = createTableRow(item, rowIndex++, tagLookup);
      row.dataset.categoryId = group.id;
      if (collapsed) {
        row.classList.add('category-collapsed');
      }
      tableBody.appendChild(row);
    });
  });
}

function renderCategorizedGrid(groups) {
  if (!gridContainer) return;
  gridContainer.innerHTML = '';
  const tagLookup = buildTagLookup(state.tags);
  const hierarchyEnabled = !!groups?.hierarchyEnabled;
  const parentMap = groups?.parentMap || new Map();
  const isHiddenByAncestor = (id) => {
    let current = parentMap.get(id);
    while (current) {
      if (collapsedCategories.has(current)) return true;
      current = parentMap.get(current);
    }
    return false;
  };
  groups.forEach((group) => {
    if (hierarchyEnabled && isHiddenByAncestor(group.id)) {
      return;
    }
    const header = document.createElement('div');
    header.className = 'category-grid-header';
    header.style.setProperty('--category-color', group.color || '#6c757d');
    header.style.setProperty('--category-text-color', group.textColor || '#ffffff');
    const displayedCount = hierarchyEnabled
      ? (group.totalItems ?? group.items.length)
      : group.items.length;
    header.textContent = `${group.name} • ${displayedCount}`;
    header.style.gridColumn = '1 / -1';
    header.setAttribute('role', 'button');
    header.tabIndex = 0;
    const collapsed = collapsedCategories.has(group.id);
    if (collapsed) {
      header.classList.add('is-collapsed');
    }
    if (hierarchyEnabled && typeof group.depth === 'number') {
      header.dataset.depth = String(group.depth);
      header.style.setProperty('--category-depth', group.depth);
    }
    header.addEventListener('click', () => toggleCategory(group.id));
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleCategory(group.id);
      }
    });
    gridContainer.appendChild(header);
    group.items.forEach((item) => {
      const card = createGridCard(item, tagLookup);
      card.dataset.categoryId = group.id;
      if (collapsed) {
        card.classList.add('category-collapsed');
      }
      gridContainer.appendChild(card);
    });
  });
}

function toggleCategory(categoryId) {
  if (!categoryId) return;
  if (collapsedCategories.has(categoryId)) {
    collapsedCategories.delete(categoryId);
  } else {
    collapsedCategories.add(categoryId);
  }
  renderList();
}

function createTableRow(item, index, tagLookup) {
  const row = document.createElement('tr');
  row.dataset.path = item.path;
  row.dataset.index = String(index);
  row.dataset.isDir = item.is_dir ? '1' : '0';
  row.tabIndex = 0;
  row.draggable = true;
  const icon = iconForItem(item);
  const displayName = escapeHtml(item.displayName || item.name);
  const typeLabel = escapeHtml(item.type || '');
  const tagsMarkup = renderTagBadges(item.tags, tagLookup, state.tagDisplayMode);
  const notesMarkup = renderNoteIndicators(item.notes, item.note_summary, item.note_children);
  const validationMarkup = renderValidationIcon(item);
  // qualifile-reviewed-html: list renderer escapes user values and uses constant fragments
  row.innerHTML = `
        <td class="text-center">
            <input class="form-check-input row-check" type="checkbox" aria-label="Select ${escapeHtml(item.displayName || item.name)}">
        </td>
        <td class="text-truncate" data-column="name">
            <span class="file-cell d-flex align-items-center gap-2 w-100">
                <span class="file-icon" aria-hidden="true">${icon}</span>
                <span class="file-label">${displayName}</span>
                ${validationMarkup}
                ${tagsMarkup}
                <span class="ms-auto file-note-indicators">${notesMarkup}</span>
            </span>
        </td>
        <td data-column="type">${typeLabel}</td>
        <td class="text-end" data-column="size">${formatSize(item.size)}</td>
        <td data-column="created">${formatDate(item.created)}</td>
        <td data-column="modified">${formatDate(item.modified)}</td>
    `;
  row.addEventListener('click', (event) => handleSelection(event, item));
  row.addEventListener('dblclick', () => {
    void openItem(item);
  });
  row.addEventListener('keydown', (event) => handleRowKeydown(event, item));
  row.addEventListener('dragstart', (event) => handleDragStart(event, item));
  row.addEventListener('dragend', handleDragEnd);
  if (item.is_dir) {
    enableFolderDrop(row, item.path);
  }
  const checkbox = row.querySelector('.row-check');
  checkbox.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSelection(item, event.shiftKey, event.ctrlKey || event.metaKey, checkbox.checked, true);
  });
  return row;
}

function createGridCard(item, tagLookup) {
  const card = document.createElement('div');
  card.className = 'file-card';
  card.setAttribute('role', 'listitem');
  card.tabIndex = 0;
  card.dataset.path = item.path;
  card.dataset.isDir = item.is_dir ? '1' : '0';
  card.draggable = true;
  const icon = iconForItem(item);
  const displayName = escapeHtml(item.displayName || item.name);
  const typeLabel = escapeHtml(item.type || '');
  const tagsMarkup = renderTagBadges(item.tags, tagLookup, state.tagDisplayMode);
  const notesMarkup = renderNoteIndicators(item.notes, item.note_summary, item.note_children);
  const validationMarkup = renderValidationIcon(item);
  // qualifile-reviewed-html: list renderer escapes user values and uses constant fragments
  card.innerHTML = `
        <div class="form-check">
            <input class="form-check-input card-check" type="checkbox" aria-label="Select ${escapeHtml(item.displayName || item.name)}">
        </div>
        <div class="file-card-thumbnail" data-thumb-region aria-hidden="true"></div>
        <div class="file-name d-flex align-items-center gap-2 w-100" data-column="name">
            <span class="file-icon" aria-hidden="true">${icon}</span>
            <span class="file-label">${displayName}</span>
            ${validationMarkup}
            ${tagsMarkup}
            <span class="ms-auto file-note-indicators">${notesMarkup}</span>
        </div>
        <div class="file-meta" data-column="type">${typeLabel}</div>
        <div class="file-meta" data-column="size">${formatSize(item.size)}</div>
        <div class="file-meta" data-column="created">${formatDate(item.created)}</div>
        <div class="file-meta" data-column="modified">${formatDate(item.modified)}</div>
    `;
  attachGridCardThumbnail(card, item, icon);
  card.addEventListener('click', (event) => handleSelection(event, item));
  card.addEventListener('dblclick', () => {
    void openItem(item);
  });
  card.addEventListener('keydown', (event) => handleRowKeydown(event, item));
  card.addEventListener('dragstart', (event) => handleDragStart(event, item));
  card.addEventListener('dragend', handleDragEnd);
  if (item.is_dir) {
    enableFolderDrop(card, item.path);
  }
  const checkbox = card.querySelector('.card-check');
  checkbox.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSelection(item, event.shiftKey, event.ctrlKey || event.metaKey, checkbox.checked, true);
  });
  return card;
}

/** Provide keyboard interactions for rows/cards. */
function handleRowKeydown(event, item) {
  if (event.key === 'Delete') {
    event.preventDefault();
    const selection = selectionArray();
    if (!selection.includes(item.path)) {
      setSelection([item.path]);
      syncSelection();
    }
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    void openItem(item);
  }
  if (event.key === ' ') {
    event.preventDefault();
    toggleSelection(item, false, true);
  }
  if (event.key === 'F2') {
    event.preventDefault();
    const row = document.querySelector(`tr[data-path="${CSS.escape(item.path)}"]`);
    if (row) {
      beginInlineRename(row, item);
    }
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    moveKeyboardFocus(item.path, offset);
    event.preventDefault();
  }
}

/** Attach global listeners for list controls. */
function bindListEvents() {
  filterInput?.addEventListener('input', () => renderList());
  selectAllCheckbox?.addEventListener('change', (event) => {
    if (event.target.checked) {
      setSelection(applyViewFilters().map((item) => item.path));
    } else {
      clearSelection();
    }
    syncSelection();
  });
  columnToggleElements.forEach((checkbox) => {
    const key = checkbox.dataset.column;
    if (!key || key === 'name') return;
    checkbox.addEventListener('change', (event) => {
      state.columns[key] = event.target.checked;
      persistPreferences();
      applyColumnVisibility();
      renderList();
    });
  });
  categorizeToggle?.addEventListener('change', (event) => {
    state.categorizeFiles = !!event.target.checked;
    persistPreferences();
    renderList();
  });
  tagModeToggle?.addEventListener('click', () => {
    state.tagDisplayMode = state.tagDisplayMode === 'dots' ? 'full' : 'dots';
    persistPreferences();
    updateTagModeToggle();
    renderList();
  });
  document.getElementById('columns-menu')?.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  document.querySelectorAll('.sortable').forEach((header) => {
    header.addEventListener('click', () => {
      const key = header.dataset.sort;
      if (!key) return;
      if (state.sort.key === key) {
        state.sort.direction = state.sort.direction === 'ascending' ? 'descending' : 'ascending';
      } else {
        state.sort = { key, direction: 'ascending' };
      }
      persistPreferences();
      updateSortIndicators();
      renderList();
    });
  });
  document
    .getElementById('view-mode-list')
    ?.addEventListener('click', () => updateViewMode('list'));
  document
    .getElementById('view-mode-grid')
    ?.addEventListener('click', () => updateViewMode('grid'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'F2' && selectionArray().length === 1) {
      const [path] = selectionArray();
      const row = tableBody?.querySelector(`tr[data-path="${CSS.escape(path)}"]`);
      const item = findItemByPath(path);
      if (row && item) {
        beginInlineRename(row, item);
      }
    }
  });
}

function initAdvancedFilters() {
  advancedFilterToggle = document.getElementById('advanced-filter-toggle');
  advancedFilterBadge = document.getElementById('advanced-filter-badge');
  advancedFilterPanel = document.getElementById('advanced-filter-panel');
  advancedFilterStatus = document.getElementById('advanced-filter-status');
  advancedScopeRadios = Array.from(
    document.querySelectorAll('input[name="advanced-filter-scope"]')
  );
  advancedFolderInput = document.getElementById('advanced-folder-filter');
  advancedModifiedSelect = document.getElementById('advanced-filter-modified');
  advancedModifiedFrom = document.getElementById('advanced-filter-modified-from');
  advancedModifiedTo = document.getElementById('advanced-filter-modified-to');
  advancedCustomRange = document.getElementById('advanced-filter-custom-range');
  advancedTagList = document.getElementById('advanced-filter-tag-list');
  advancedFilterApplyButton = document.getElementById('advanced-filter-apply');
  advancedFilterResetButton = document.getElementById('advanced-filter-reset');
  advancedFilterCloseButton = document.getElementById('advanced-filter-close');

  renderAdvancedFilterTags();
  syncAdvancedFiltersToInputs();
  syncAdvancedFilterBadge();
  updateAdvancedFilterStatusText();

  advancedFilterToggle?.addEventListener('click', toggleAdvancedFilterPanel);
  advancedFilterCloseButton?.addEventListener('click', closeAdvancedFilterPanel);
  advancedFilterApplyButton?.addEventListener('click', () => {
    void handleAdvancedFilterChange({ explicit: true });
    closeAdvancedFilterPanel();
  });
  advancedFilterResetButton?.addEventListener('click', () => {
    resetAdvancedFilters();
    renderList();
  });
  advancedScopeRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const nextScope = radio.value === 'root' ? 'root' : 'current';
      if (nextScope === 'root' && !confirmRootScope()) {
        resetAdvancedScopeToCurrent({ shouldRender: true });
        return;
      }
      state.filters.scope = nextScope;
      if (nextScope !== 'root') {
        rootScopeConfirmed = false;
      }
      syncAdvancedFiltersToInputs();
      syncAdvancedFilterBadge();
      updateAdvancedFilterStatusText();
      renderList();
    });
  });
  advancedFolderInput?.addEventListener('input', () => {
    state.filters.folderName = advancedFolderInput.value.trim();
    syncAdvancedFilterBadge();
    renderList();
  });
  advancedModifiedSelect?.addEventListener('change', handleModifiedChange);
  advancedModifiedFrom?.addEventListener('change', () => {
    void handleAdvancedFilterChange();
  });
  advancedModifiedTo?.addEventListener('change', () => {
    void handleAdvancedFilterChange();
  });
  document.addEventListener('click', handleAdvancedFilterOutsideClick);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeAdvancedFilterPanel();
    }
  });
  document.addEventListener(GLOBAL_REFRESH_EVENT, (event) => {
    const shouldInvalidate = event?.detail?.invalidateRootListing !== false;
    if (shouldInvalidate) {
      invalidateRootListing();
    }
  });
}

function toggleAdvancedFilterPanel() {
  if (!advancedFilterPanel) return;
  const isOpen = advancedFilterPanel.classList.contains('show');
  if (isOpen) {
    closeAdvancedFilterPanel();
  } else {
    openAdvancedFilterPanel();
  }
}

function openAdvancedFilterPanel() {
  if (!advancedFilterPanel) return;
  advancedFilterPanel.classList.add('show');
  advancedFilterToggle?.setAttribute('aria-expanded', 'true');
  syncAdvancedFiltersToInputs();
  syncAdvancedFilterBadge();
}

function closeAdvancedFilterPanel() {
  if (!advancedFilterPanel) return;
  advancedFilterPanel.classList.remove('show');
  advancedFilterToggle?.setAttribute('aria-expanded', 'false');
  syncAdvancedFilterBadge();
}

function handleAdvancedFilterOutsideClick(event) {
  if (!advancedFilterPanel?.classList.contains('show')) return;
  if (advancedFilterPanel.contains(event.target)) return;
  if (advancedFilterToggle?.contains(event.target)) return;
  closeAdvancedFilterPanel();
}

function renderAdvancedFilterTags() {
  if (!advancedTagList) return;
  const tags = Array.isArray(state.tags) ? state.tags : [];
  const selected = new Set(state.filters.tags || []);
  advancedTagList.innerHTML = '';
  if (!tags.length) {
    const empty = document.createElement('p');
    empty.className = 'text-muted small mb-0';
    empty.textContent = 'No tags available yet.';
    advancedTagList.appendChild(empty);
    return;
  }
  tags.forEach((tag) => {
    if (!tag?.id) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'advanced-filter-tag';
    button.dataset.tagId = tag.id;
    const colorDot = document.createElement('span');
    colorDot.className = 'color-dot';
    colorDot.style.background = resolveTagColors(tag.color).background;
    const name = document.createElement('span');
    name.textContent = tag.name || 'Tag';
    button.append(colorDot, name);
    if (selected.has(tag.id)) {
      button.classList.add('is-active');
    }
    button.addEventListener('click', () => toggleAdvancedTag(tag.id, button));
    advancedTagList.appendChild(button);
  });
}

function toggleAdvancedTag(tagId, element) {
  if (!tagId) return;
  const tags = new Set(state.filters.tags || []);
  if (tags.has(tagId)) {
    tags.delete(tagId);
  } else {
    tags.add(tagId);
  }
  state.filters.tags = Array.from(tags);
  if (element) {
    element.classList.toggle('is-active', tags.has(tagId));
  } else {
    renderAdvancedFilterTags();
  }
  syncAdvancedFilterBadge();
  renderList();
}

function syncAdvancedFiltersToInputs() {
  if (advancedFolderInput) {
    advancedFolderInput.value = state.filters.folderName || '';
  }
  if (advancedModifiedSelect) {
    const preset = state.filters.modifiedPreset || 'any';
    advancedModifiedSelect.value = preset;
    advancedCustomRange?.classList.toggle('d-none', preset !== 'custom');
  }
  if (advancedModifiedFrom) {
    advancedModifiedFrom.value = state.filters.modifiedFrom || '';
  }
  if (advancedModifiedTo) {
    advancedModifiedTo.value = state.filters.modifiedTo || '';
  }
  advancedScopeRadios.forEach((radio) => {
    radio.checked = radio.value === state.filters.scope;
  });
}

function handleModifiedChange() {
  if (!advancedModifiedSelect) return;
  state.filters.modifiedPreset = advancedModifiedSelect.value || 'any';
  if (state.filters.modifiedPreset !== 'custom') {
    state.filters.modifiedFrom = '';
    state.filters.modifiedTo = '';
  }
  advancedCustomRange?.classList.toggle('d-none', state.filters.modifiedPreset !== 'custom');
  void handleAdvancedFilterChange();
}

async function handleAdvancedFilterChange(options = {}) {
  if (advancedModifiedSelect) {
    state.filters.modifiedPreset = advancedModifiedSelect.value || 'any';
  }
  if (advancedFolderInput) {
    state.filters.folderName = advancedFolderInput.value.trim();
  }
  if (advancedModifiedFrom) {
    state.filters.modifiedFrom = advancedModifiedFrom.value || '';
  }
  if (advancedModifiedTo) {
    state.filters.modifiedTo = advancedModifiedTo.value || '';
  }
  syncAdvancedFilterBadge();
  updateAdvancedFilterStatusText();
  if (state.filters.scope === 'root' && !rootListingCache && options.explicit) {
    try {
      await ensureRootListing();
    } catch (error) {
      if (!isAbortError(error)) {
        handleError(error);
      }
      resetAdvancedScopeToCurrent({ shouldRender: true });
      return;
    }
  }
  renderList();
}

function resetAdvancedFilters() {
  state.filters = {
    scope: 'current',
    tags: [],
    modifiedPreset: 'any',
    modifiedFrom: '',
    modifiedTo: '',
    folderName: '',
  };
  rootScopeConfirmed = false;
  ensureFilterDefaults();
  syncAdvancedFiltersToInputs();
  renderAdvancedFilterTags();
  syncAdvancedFilterBadge();
  updateAdvancedFilterStatusText();
}

function activeAdvancedFilterCount() {
  const filters = state.filters || {};
  const tagCount = Array.isArray(filters.tags) ? filters.tags.filter(Boolean).length : 0;
  const hasFolderQuery = Boolean(filters.folderName && filters.folderName.trim());
  const hasModified = filters.modifiedPreset && filters.modifiedPreset !== 'any';
  const hasCustomDates =
    filters.modifiedPreset === 'custom' && (filters.modifiedFrom || filters.modifiedTo);
  let count = 0;
  if (filters.scope === 'root') count += 1;
  if (tagCount) count += 1;
  if (hasFolderQuery) count += 1;
  if (hasModified || hasCustomDates) count += 1;
  return count;
}

function syncAdvancedFilterBadge() {
  const count = activeAdvancedFilterCount();
  if (advancedFilterBadge) {
    advancedFilterBadge.textContent = String(count);
    advancedFilterBadge.classList.toggle('d-none', count === 0);
  }
  if (advancedFilterToggle) {
    const isOpen = advancedFilterPanel?.classList.contains('show');
    advancedFilterToggle.classList.toggle('is-active', count > 0 || isOpen);
  }
}

function updateAdvancedFilterStatusText(message) {
  if (!advancedFilterStatus) return;
  if (message) {
    advancedFilterStatus.textContent = message;
    return;
  }
  if (state.filters.scope === 'root' && !rootListingCache) {
    advancedFilterStatus.textContent = 'Scope: entire workspace (apply to load)';
    return;
  }
  const scopeLabel =
    state.filters.scope === 'root' ? 'Scope: entire workspace' : 'Scope: current folder';
  advancedFilterStatus.textContent = scopeLabel;
}

function confirmRootScope() {
  if (rootScopeConfirmed) {
    return true;
  }
  const approved = window.confirm(
    'Loading the entire workspace can be slow on large folders. Do you want to scan everything now?'
  );
  rootScopeConfirmed = approved;
  return approved;
}

function resetAdvancedScopeToCurrent({ shouldRender = true } = {}) {
  if (state.filters.scope === 'current') return;
  state.filters.scope = 'current';
  syncAdvancedFiltersToInputs();
  syncAdvancedFilterBadge();
  updateAdvancedFilterStatusText();
  if (shouldRender) {
    renderList();
  }
}

function maybeUpdateRootListingCache(includeSubfolders) {
  if (rootListingPromise) {
    return;
  }
  const atRoot = !state.currentPath || state.currentPath === '.';
  if (!includeSubfolders || !atRoot) {
    return;
  }
  rootListingCache = {
    items: state.items,
    subfolders: state.subfolders,
    validation: state.validation,
    assignments: state.tagAssignments,
  };
}

function patchRootListingCacheTags(pathSet, tags) {
  if (!rootListingCache || !pathSet?.size) {
    return;
  }
  const applyToEntries = (entries) => {
    if (!Array.isArray(entries)) return;
    entries.forEach((entry) => {
      if (!entry?.path) return;
      const key = canonicalTagPath(entry.path);
      if (pathSet.has(key)) {
        entry.tags = [...tags];
      }
    });
  };
  const applyToSubfolders = (groups) => {
    if (!Array.isArray(groups)) return;
    groups.forEach((group) => {
      if (group?.folder) {
        applyToEntries([group.folder]);
      }
      const children = group?.children;
      if (Array.isArray(children?.entries)) {
        applyToEntries(children.entries);
      } else if (Array.isArray(children)) {
        applyToEntries(children);
      }
      if (Array.isArray(children?.subfolders)) {
        applyToSubfolders(children.subfolders);
      }
    });
  };
  applyToEntries(rootListingCache.items);
  applyToSubfolders(rootListingCache.subfolders);
  if (!rootListingCache.assignments) {
    rootListingCache.assignments = {};
  }
  pathSet.forEach((path) => {
    rootListingCache.assignments[path] = [...tags];
  });
}

function invalidateRootListing() {
  rootListingCache = null;
  rootListingPromise = null;
}

async function ensureRootListing() {
  if (rootListingCache) {
    return rootListingCache;
  }
  if (rootListingPromise) {
    return rootListingPromise;
  }
  const controller = new AbortController();
  const loading = createLoadingOperation({
    controller,
    message: 'Scanning entire workspace...',
    detail:
      'Loading all folders and files for filtering. This may take a while on large workspaces.',
    onCancel: () => updateAdvancedFilterStatusText('Full workspace scan cancelled.'),
    delayMs: 500,
  });
  updateAdvancedFilterStatusText('Loading all folders...');
  const pending = fetchList('.', true, { signal: controller.signal })
    .then((payload) => {
      const items = Array.isArray(payload.items) ? payload.items : payload.items.entries || [];
      const subfolders = Array.isArray(payload.items) ? [] : payload.items.subfolders || [];
      const validationMap = buildValidationAssignmentsRecursive(
        items,
        subfolders,
        payload.validation
      );
      applyValidationFlags(items, subfolders, validationMap);
      const assignments = buildTagAssignmentsRecursive(items, subfolders);
      rootListingCache = {
        items,
        subfolders,
        validation: validationMap,
        assignments,
      };
      state.tagAssignments = { ...state.tagAssignments, ...assignments };
      if (Array.isArray(payload.tags)) {
        state.tags = payload.tags;
        renderAdvancedFilterTags();
      }
      updateAdvancedFilterStatusText();
      return rootListingCache;
    })
    .catch((error) => {
      if (loading.wasCancelled() || isAbortError(error)) {
        updateAdvancedFilterStatusText('Full workspace scan cancelled.');
        return Promise.reject(error);
      }
      handleError(error);
      updateAdvancedFilterStatusText('Unable to load the full folder tree.');
      throw error;
    })
    .finally(() => {
      loading.finish();
      rootListingPromise = null;
      ensureLoadingModalClosed();
    });
  rootListingPromise = pending;
  return pending;
}

/** Switch between list and grid layouts. */
function updateViewMode(mode, persist = true) {
  state.viewMode = mode;
  if (listView && gridView) {
    if (mode === 'list') {
      listView.classList.remove('d-none');
      gridView.classList.add('d-none');
      gridView.setAttribute('aria-hidden', 'true');
      listView.removeAttribute('aria-hidden');
    } else {
      gridView.classList.remove('d-none');
      listView.classList.add('d-none');
      listView.setAttribute('aria-hidden', 'true');
      gridView.removeAttribute('aria-hidden');
    }
  }
  document.getElementById('view-mode-list')?.classList.toggle('active', mode === 'list');
  document.getElementById('view-mode-grid')?.classList.toggle('active', mode === 'grid');
  if (persist) {
    persistPreferences();
  }
}

/** Filter items using search text and preferences. */
function applyViewFilters() {
  ensureFilterDefaults();
  const filterValue = (filterInput?.value || '').trim().toLowerCase();
  const filters = state.filters || {};
  const requiredTags = Array.isArray(filters.tags) ? filters.tags.filter(Boolean) : [];
  const folderQuery = (filters.folderName || '').trim().toLowerCase();
  const { afterDate, beforeDate } = resolveModifiedRange(
    filters.modifiedPreset,
    filters.modifiedFrom,
    filters.modifiedTo
  );
  const listing = getActiveListing(filters.scope);
  const combined = getCombinedItems(listing);
  const hasAdvancedFilters = Boolean(
    requiredTags.length || folderQuery || afterDate || beforeDate || filters.scope === 'root'
  );
  if (listing.includeSubfolders && !filterValue && !hasAdvancedFilters) {
    return combined;
  }
  const items = combined.filter((item) => {
    const name = (item.displayName || item.name || '').toLowerCase();
    if (folderQuery) {
      if (!item.is_dir) return false;
      if (!name.includes(folderQuery)) return false;
    }
    if (filterValue && !name.includes(filterValue)) {
      return false;
    }
    if (requiredTags.length) {
      const itemTags = Array.isArray(item.tags) ? item.tags : [];
      const matchesTags = requiredTags.every((tagId) => itemTags.includes(tagId));
      if (!matchesTags) return false;
    }
    if (afterDate || beforeDate) {
      const modifiedTime = new Date(item.modified || item.created || item.updated || 0).getTime();
      if (Number.isNaN(modifiedTime)) {
        return false;
      }
      if (afterDate && modifiedTime < afterDate) {
        return false;
      }
      if (beforeDate && modifiedTime > beforeDate) {
        return false;
      }
    }
    return true;
  });
  const sorted = [...items].sort((a, b) => compareItems(a, b, state.sort.key));
  if (state.sort.direction === 'descending') {
    sorted.reverse();
  }
  return sorted;
}

function resolveModifiedRange(preset = 'any', from = '', to = '') {
  const now = Date.now();
  if (preset === '24h') {
    return { afterDate: now - 24 * 60 * 60 * 1000, beforeDate: null };
  }
  if (preset === '7d') {
    return { afterDate: now - 7 * 24 * 60 * 60 * 1000, beforeDate: null };
  }
  if (preset === '30d') {
    return { afterDate: now - 30 * 24 * 60 * 60 * 1000, beforeDate: null };
  }
  if (preset === '90d') {
    return { afterDate: now - 90 * 24 * 60 * 60 * 1000, beforeDate: null };
  }
  if (preset === 'custom') {
    const fromTime = from ? Date.parse(`${from}T00:00:00`) : null;
    const toTime = to ? Date.parse(`${to}T23:59:59`) : null;
    return {
      afterDate: Number.isFinite(fromTime) ? fromTime : null,
      beforeDate: Number.isFinite(toTime) ? toTime : null,
    };
  }
  return { afterDate: null, beforeDate: null };
}

/** Toggle selection when rows/cards are clicked. */
function handleSelection(event, item) {
  const path = item.path;
  const allowRange = event.shiftKey;
  const allowToggle = event.metaKey || event.ctrlKey;
  const alreadySelected = state.selection.has(path);
  if (allowRange && selectionArray().length && lastActivePath) {
    const items = applyViewFilters();
    const startIndex = items.findIndex((entry) => entry.path === lastActivePath);
    const endIndex = items.findIndex((entry) => entry.path === path);
    if (startIndex !== -1 && endIndex !== -1) {
      const [start, end] = [startIndex, endIndex].sort((a, b) => a - b);
      const range = items.slice(start, end + 1).map((entry) => entry.path);
      const combined = new Set(selectionArray());
      range.forEach((value) => combined.add(value));
      state.selection = combined;
    }
  } else if (allowToggle) {
    if (alreadySelected) {
      state.selection.delete(path);
    } else {
      state.selection.add(path);
    }
  } else {
    setSelection([path]);
  }
  lastActivePath = path;
  syncSelection();
  if (!item.is_dir) {
    showPreview(item);
  } else {
    clearPreview();
  }
}

/** Toggle selection state for a single item. */
function toggleSelection(item, shiftKey, toggleKey, isCheckedOverride, forceToggle = false) {
  const path = item.path;
  const useToggle = forceToggle || toggleKey;
  if (shiftKey && lastActivePath) {
    const items = applyViewFilters();
    const startIndex = items.findIndex((entry) => entry.path === lastActivePath);
    const endIndex = items.findIndex((entry) => entry.path === path);
    if (startIndex !== -1 && endIndex !== -1) {
      const [start, end] = [startIndex, endIndex].sort((a, b) => a - b);
      const range = items.slice(start, end + 1).map((entry) => entry.path);
      const combined = new Set(selectionArray());
      range.forEach((value) => combined.add(value));
      state.selection = combined;
    }
  } else if (useToggle) {
    if (state.selection.has(path) && (isCheckedOverride === undefined || !isCheckedOverride)) {
      state.selection.delete(path);
    } else {
      state.selection.add(path);
    }
  } else {
    if (isCheckedOverride === false) {
      state.selection.delete(path);
    } else {
      setSelection([path]);
    }
  }
  lastActivePath = path;
  syncSelection();
  if (!item.is_dir) {
    showPreview(item);
  }
}

/** Open folders in the list or preview files. */
async function openItem(item) {
  if (item.is_dir) {
    await openFolder(item.path, false, { source: 'list' });
  } else {
    try {
      await openInDefaultApp(item.path);
    } catch (error) {
      handleError(error);
    }
  }
}

async function openFolder(path, includeSubfolders = false, options = {}) {
  const normalized = normalizePath(path);
  updateCurrentPath(normalized, includeSubfolders);
  resetAdvancedScopeToCurrent({ shouldRender: false });
  clearSelection();
  syncSelection();
  await loadList(includeSubfolders);
  if (typeof openFolderCallback === 'function') {
    await openFolderCallback(normalized, includeSubfolders, { source: options.source || 'list' });
  } else {
    requestGlobalRefresh();
  }
}

/** Synchronise checkbox state with the selection set. */
function syncSelection(items = null) {
  const activeItems = items || applyViewFilters();
  const selected = selectionArray();
  if (tableBody) {
    tableBody.querySelectorAll('tr').forEach((row) => {
      const path = row.dataset.path;
      const isSelected = state.selection.has(path);
      row.classList.toggle('selected', isSelected);
      const checkbox = row.querySelector('.row-check');
      if (checkbox) {
        checkbox.checked = isSelected;
      }
    });
  }
  if (gridContainer) {
    gridContainer.querySelectorAll('.file-card').forEach((card) => {
      const path = card.dataset.path;
      const isSelected = state.selection.has(path);
      card.classList.toggle('active', isSelected);
      const checkbox = card.querySelector('.card-check');
      if (checkbox) {
        checkbox.checked = isSelected;
      }
    });
  }
  updateSelectAllState(activeItems);
  if (selected.length === 1) {
    lastActivePath = selected[0];
  }
  document.dispatchEvent(
    new CustomEvent('qualifile:selection-changed', {
      detail: { selection: [...selected] },
    })
  );
}

/** Update the master checkbox based on selection. */
function updateSelectAllState(items) {
  if (!selectAllCheckbox) return;
  const selected = selectionArray();
  const selectable = items.map((item) => item.path);
  const allSelected = selectable.length > 0 && selectable.every((path) => selected.includes(path));
  const noneSelected = selectable.every((path) => !selected.includes(path));
  selectAllCheckbox.indeterminate = !allSelected && !noneSelected;
  selectAllCheckbox.checked = allSelected;
}

/** Support keyboard navigation between rows. */
function moveKeyboardFocus(currentPath, offset) {
  const items = applyViewFilters();
  const index = items.findIndex((entry) => entry.path === currentPath);
  if (index === -1) return;
  let nextIndex = index + offset;
  nextIndex = Math.max(0, Math.min(items.length - 1, nextIndex));
  const next = items[nextIndex];
  if (!next) return;
  const row = tableBody?.querySelector(`tr[data-path="${CSS.escape(next.path)}"]`);
  const card = gridContainer?.querySelector(`.file-card[data-path="${CSS.escape(next.path)}"]`);
  if (row && state.viewMode === 'list') {
    row.focus();
  } else if (card && state.viewMode === 'grid') {
    card.focus();
  }
  setSelection([next.path]);
  syncSelection();
  if (!next.is_dir) {
    showPreview(next);
  }
}

/** Return a combined array of root items and subfolders. */
function getCombinedItems(listing = null) {
  const source = listing || getActiveListing();
  const combined = [];
  const subfolderMap = buildSubfolderMap(source.subfolders);
  const files = (source.items || []).filter((item) => !item.is_dir);
  const folders = (source.items || []).filter((item) => item.is_dir);
  files.forEach((file) => combined.push({ ...file }));
  folders.forEach((folder) => {
    combined.push({ ...folder });
    if (source.includeSubfolders) {
      const group = subfolderMap.get(folder.path);
      if (group) {
        appendSubtree(combined, group, subfolderMap);
      }
    }
  });
  return combined;
}

function getActiveListing(scopeOverride = null) {
  const requestedScope =
    scopeOverride === 'root' ? 'root' : scopeOverride || state.filters?.scope || 'current';
  if (requestedScope === 'root' && rootListingCache) {
    return {
      items: rootListingCache.items || [],
      subfolders: rootListingCache.subfolders || [],
      includeSubfolders: true,
    };
  }
  return {
    items: state.items || [],
    subfolders: state.subfolders || [],
    includeSubfolders: state.includeSubfolders,
  };
}

function buildSubfolderMap(subfolders = state.subfolders) {
  const map = new Map();
  const walk = (groups) => {
    if (!Array.isArray(groups)) return;
    groups.forEach((group) => {
      const folderPath = group?.folder?.path || group?.folder?.name;
      if (!folderPath) return;
      map.set(folderPath, group);
      const children = group?.children?.subfolders || [];
      walk(children);
    });
  };
  walk(subfolders || []);
  return map;
}

function appendSubtree(combined, group, map) {
  const children = group?.children || {};
  const entries = Array.isArray(children) ? children : children.entries || [];
  const childFiles = entries.filter((entry) => !entry.is_dir);
  const childFolders = entries.filter((entry) => entry.is_dir);
  childFiles.forEach((entry) => combined.push({ ...entry }));
  childFolders.forEach((entry) => {
    combined.push({ ...entry });
    const nestedGroup = map?.get(entry.path);
    if (nestedGroup) {
      appendSubtree(combined, nestedGroup, map);
    }
  });
}

/** Comparator used for column sorting. */
function compareItems(a, b, key) {
  if (key === 'size') {
    return (a.size || 0) - (b.size || 0);
  }
  if (key === 'created' || key === 'modified') {
    return new Date(a[key]).getTime() - new Date(b[key]).getTime();
  }
  if (key === 'type') {
    return (a.type || '').localeCompare(b.type || '');
  }
  const valueA = (a.displayName || a.name || '').toLowerCase();
  const valueB = (b.displayName || b.name || '').toLowerCase();
  return valueA.localeCompare(valueB);
}

/** Show or hide columns based on preferences. */
function applyColumnVisibility() {
  const visibility = { ...state.columns, name: true };
  document.querySelectorAll('#file-table thead [data-column]').forEach((header) => {
    const key = header.dataset.column;
    if (!key) return;
    const visible = visibility[key];
    header.classList.toggle('d-none', !visible);
    header.setAttribute('aria-hidden', visible ? 'false' : 'true');
  });
  if (tableBody) {
    tableBody.querySelectorAll('tr').forEach((row) => {
      row.querySelectorAll('[data-column]').forEach((cell) => {
        const key = cell.dataset.column;
        if (!key) return;
        const visible = visibility[key];
        cell.classList.toggle('d-none', !visible);
      });
    });
  }
  if (gridContainer) {
    gridContainer.querySelectorAll('[data-column]').forEach((element) => {
      const key = element.dataset.column;
      if (!key) return;
      const visible = visibility[key];
      element.classList.toggle('d-none', !visible);
    });
  }
  columnToggleElements.forEach((checkbox) => {
    const key = checkbox.dataset.column;
    if (!key) return;
    if (key === 'name') {
      checkbox.checked = true;
      checkbox.disabled = true;
      return;
    }
    checkbox.checked = !!visibility[key];
  });
}

function updateTagModeToggle() {
  if (!tagModeToggle) return;
  if (state.tagDisplayMode === 'dots') {
    tagModeToggle.textContent = 'Show Full Tags';
    tagModeToggle.setAttribute('aria-pressed', 'true');
  } else {
    tagModeToggle.textContent = 'Show Tag Dots';
    tagModeToggle.setAttribute('aria-pressed', 'false');
  }
}

/** Locate an item by its path. */
function findItemByPath(path) {
  return getCombinedItems().find((item) => item.path === path);
}

/** Render inline rename input for a row. */
function beginInlineRename(row, item) {
  const original = item.name;
  const cell = row.querySelector('td:nth-child(2)');
  if (!cell || cell.querySelector('input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = original;
  input.className = 'form-control form-control-sm';
  input.maxLength = 120;
  cell.innerHTML = '';
  cell.appendChild(input);
  input.focus();
  input.select();

  const finish = async (commit) => {
    input.disabled = true;
    if (!commit) {
      renderList();
      return;
    }
    const newName = input.value.trim();
    if (!newName) {
      showToast('Name cannot be empty.', true);
      renderList();
      return;
    }
    if (newName === original) {
      renderList();
      return;
    }
    try {
      setStatus('Renaming…');
      const result = await renameItem(item.path, newName);
      const newPath = result.path;
      showToast('Item renamed successfully');
      await loadList(state.includeSubfolders);
      setSelection([newPath]);
      syncSelection();
      requestGlobalRefresh({ refreshList: false });
    } catch (error) {
      handleError(error);
      renderList();
    } finally {
      setStatus('Saved/Idle');
    }
  };

  input.addEventListener('keydown', async (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      await finish(true);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

/** Update sort direction indicators on headers. */
function updateSortIndicators() {
  document.querySelectorAll('.sortable').forEach((header) => {
    const key = header.dataset.sort;
    if (key === state.sort.key) {
      header.setAttribute('aria-sort', state.sort.direction);
    } else {
      header.setAttribute('aria-sort', 'none');
    }
  });
}

/** Allow dropping items onto folder rows/cards. */
function enableFolderDrop(element, destinationPath) {
  element.addEventListener('dragover', (event) => {
    const payload = parseDragPayload(event.dataTransfer);
    if (!payload?.items?.length) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    element.classList.add('drop-target');
    event.dataTransfer.dropEffect = 'move';
  });
  element.addEventListener('dragleave', (event) => {
    event.stopPropagation();
    if (!element.contains(event.relatedTarget)) {
      element.classList.remove('drop-target');
    }
  });
  element.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    element.classList.remove('drop-target');
    const payload = parseDragPayload(event.dataTransfer);
    if (!payload?.items?.length) {
      return;
    }
    document.dispatchEvent(
      new CustomEvent('qualifile:folder-drop', {
        detail: { items: payload.items, destination: destinationPath },
      })
    );
  });
}

/** Read the drag payload for list drop targets. */
function parseDragPayload(dataTransfer) {
  try {
    const raw = dataTransfer.getData('application/json');
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

/** Begin dragging selected items. */
function handleDragStart(event, item) {
  const selection = selectionArray();
  if (!selection.includes(item.path)) {
    setSelection([item.path]);
    syncSelection();
  }
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/json', JSON.stringify({ items: selection }));
  document.dispatchEvent(new CustomEvent('qualifile:drag-start', { detail: { items: selection } }));
}

/** Signal that a drag operation has ended. */
function handleDragEnd() {
  document.dispatchEvent(new CustomEvent('qualifile:drag-end'));
}

export function getSelection() {
  return selectionArray();
}

export { renderList };

export function triggerRename() {
  if (selectionArray().length !== 1) {
    showToast('Select a single item to rename.', true);
    return;
  }
  const [path] = selectionArray();
  const row = tableBody?.querySelector(`tr[data-path="${CSS.escape(path)}"]`);
  const item = findItemByPath(path);
  if (!row || !item) {
    showToast('Unable to find selected item.', true);
    return;
  }
  beginInlineRename(row, item);
}

export function syncSelectionState() {
  syncSelection();
}

export function findItem(path) {
  return findItemByPath(path);
}

function canonicalValidationPath(path) {
  const normalized = normalizePath(path);
  return normalized || '.';
}

function buildValidationAssignmentsRecursive(items, subfolders, providedMap) {
  const map = {};
  const source = providedMap && typeof providedMap === 'object' ? providedMap : {};
  Object.entries(source).forEach(([key, value]) => {
    const normalized = canonicalValidationPath(key);
    if (!normalized || normalized === '.') return;
    if (value) {
      map[normalized] = true;
    }
  });
  const addEntry = (entry) => {
    if (!entry || !entry.path || entry.is_dir) return;
    if (!entry.validated) return;
    const key = canonicalValidationPath(entry.path);
    if (!key || key === '.') return;
    map[key] = true;
  };
  (items || []).forEach(addEntry);
  const walk = (groups) => {
    if (!Array.isArray(groups)) return;
    groups.forEach((group) => {
      if (group?.folder) {
        addEntry(group.folder);
      }
      const children = group?.children;
      if (Array.isArray(children)) {
        children.forEach(addEntry);
      } else if (children?.entries) {
        children.entries.forEach(addEntry);
      }
      if (children?.subfolders) {
        walk(children.subfolders);
      }
    });
  };
  walk(subfolders || []);
  return map;
}

function applyValidationFlags(items, subfolders, validationMap = {}) {
  const lookup = validationMap || {};
  const annotate = (entry) => {
    if (!entry || !entry.path) return;
    const key = canonicalValidationPath(entry.path);
    entry.validated = !entry.is_dir && Boolean(lookup[key]);
  };
  (items || []).forEach(annotate);
  const walk = (groups) => {
    if (!Array.isArray(groups)) return;
    groups.forEach((group) => {
      if (group?.folder) {
        annotate(group.folder);
      }
      const children = group?.children;
      if (Array.isArray(children)) {
        children.forEach(annotate);
      } else if (children?.entries) {
        children.entries.forEach(annotate);
      }
      if (children?.subfolders) {
        walk(children.subfolders);
      }
    });
  };
  walk(subfolders || []);
}

export function updateValidationState(paths, validated) {
  if (!state.validation) {
    state.validation = {};
  }
  const targets = Array.isArray(paths) ? paths : [paths];
  const normalized = [];
  targets.forEach((path) => {
    const key = canonicalValidationPath(path);
    if (!key || key === '.') return;
    if (validated) {
      state.validation[key] = true;
    } else {
      delete state.validation[key];
    }
    normalized.push(key);
  });
  applyValidationFlags(state.items, state.subfolders, state.validation);
  renderList();
  if (normalized.length) {
    document.dispatchEvent(
      new CustomEvent('qualifile:validation-updated', {
        detail: { paths: normalized, validated },
      })
    );
  }
}

function buildTagAssignmentsRecursive(items, subfolders) {
  const map = {};
  const addEntries = (entries) => {
    entries.forEach((entry) => {
      if (!entry || !entry.path) return;
      const key = canonicalTagPath(entry.path);
      map[key] = Array.isArray(entry.tags) ? [...entry.tags] : [];
    });
  };
  addEntries(items || []);
  const walk = (groups) => {
    if (!Array.isArray(groups)) return;
    groups.forEach((group) => {
      if (group?.folder) {
        addEntries([group.folder]);
      }
      const children = group?.children;
      if (Array.isArray(children)) {
        addEntries(children);
      } else if (children?.entries) {
        addEntries(children.entries);
      }
      if (children?.subfolders) {
        walk(children.subfolders);
      }
    });
  };
  walk(subfolders || []);
  return map;
}

function canonicalTagPath(path) {
  const normalized = normalizePath(path);
  return normalized || '.';
}

export function applyTagUpdates(paths, tagIds) {
  const normalizedPaths = Array.isArray(paths) ? paths : paths ? [paths] : [];
  const targets = normalizedPaths.map((path) => canonicalTagPath(path)).filter(Boolean);
  if (!targets.length) return;
  const tags = Array.isArray(tagIds) ? tagIds.filter(Boolean) : [];
  const pathSet = new Set(targets);
  const applyToEntries = (entries) => {
    if (!Array.isArray(entries)) return;
    entries.forEach((entry) => {
      if (!entry?.path) return;
      const key = canonicalTagPath(entry.path);
      if (pathSet.has(key)) {
        entry.tags = [...tags];
      }
    });
  };
  const applyToSubfolders = (groups) => {
    if (!Array.isArray(groups)) return;
    groups.forEach((group) => {
      if (group?.folder) {
        applyToEntries([group.folder]);
      }
      const children = group?.children;
      if (Array.isArray(children?.entries)) {
        applyToEntries(children.entries);
      } else if (Array.isArray(children)) {
        applyToEntries(children);
      }
      if (Array.isArray(children?.subfolders)) {
        applyToSubfolders(children.subfolders);
      }
    });
  };
  targets.forEach((path) => {
    state.tagAssignments[path] = [...tags];
  });
  applyToEntries(state.items);
  applyToSubfolders(state.subfolders);
  patchRootListingCacheTags(pathSet, tags);
  renderList();
}

export { isImagePath } from './list_helpers.js';
