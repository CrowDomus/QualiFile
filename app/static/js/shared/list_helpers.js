const ICON_SPRITE_PATH = '/static/icons/file-icons.svg';

const ICON_MAP = {
    folder: createIcon('folder'),
    generic: createIcon('generic'),
    pdf: createIcon('pdf'),
    text: createIcon('text'),
    image: createIcon('image'),
    doc: createIcon('doc'),
    sheet: createIcon('sheet'),
    slide: createIcon('slide'),
    code: createIcon('code'),
    archive: createIcon('archive')
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'heic', 'heif', 'avif']);
const TEXT_EXTENSIONS = new Set(['txt', 'log', 'md', 'rst']);
const DOC_EXTENSIONS = new Set(['doc', 'docx', 'odt', 'rtf']);
const SHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'csv', 'ods']);
const SLIDE_EXTENSIONS = new Set(['ppt', 'pptx', 'key', 'odp']);
const CODE_EXTENSIONS = new Set(['js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'java', 'go', 'rs', 'php', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'swift', 'kt', 'sql', 'sh', 'bat', 'ps1', 'html', 'css', 'scss', 'less', 'json', 'yaml', 'yml', 'xml']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz']);
const UNTAGGED_GROUP_ID = '__untagged__';

export function isImagePath(target) {
    if (!target) return false;
    const raw = typeof target === 'string'
        ? target
        : (target?.path || target?.name || '');
    if (!raw) return false;
    const lower = raw.toLowerCase();
    const match = lower.match(/\.([a-z0-9]+)$/);
    if (!match) return false;
    return IMAGE_EXTENSIONS.has(match[1]);
}

/** Return an icon snippet for the given item. */
export function iconForItem(item) {
    if (item.is_dir) {
        return ICON_MAP.folder;
    }
    const ext = extensionForItem(item.name);
    if (!ext) {
        return ICON_MAP.generic;
    }
    if (ext === 'pdf') {
        return ICON_MAP.pdf;
    }
    if (DOC_EXTENSIONS.has(ext)) {
        return ICON_MAP.doc;
    }
    if (SHEET_EXTENSIONS.has(ext)) {
        return ICON_MAP.sheet;
    }
    if (SLIDE_EXTENSIONS.has(ext)) {
        return ICON_MAP.slide;
    }
    if (TEXT_EXTENSIONS.has(ext)) {
        return ICON_MAP.text;
    }
    if (IMAGE_EXTENSIONS.has(ext)) {
        return ICON_MAP.image;
    }
    if (CODE_EXTENSIONS.has(ext)) {
        return ICON_MAP.code;
    }
    if (ARCHIVE_EXTENSIONS.has(ext)) {
        return ICON_MAP.archive;
    }
    return ICON_MAP.generic;
}

/** Format byte sizes for display. */
export function formatSize(bytes) {
    if (bytes === undefined || bytes === null) return '';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
        value /= 1024;
        idx += 1;
    }
    return `${value.toFixed(1)} ${units[idx]}`;
}

/** Format timestamps for display. */
export function formatDate(value) {
    if (!value) return '';
    return new Date(value).toLocaleString();
}

/** Escape HTML entities for safe insertion. */
export function escapeHtml(value = '') {
    return value.replace(/[&<>'"]/g, (match) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[match] || match));
}

export function renderNoteIndicators(notes, summary, noteChildren = false) {
    const noteList = Array.isArray(notes) ? notes : [];
    const hasDirect = noteList.length || (summary && (summary.open_count || summary.closed_count));
    const allClosed = hasDirect && (
        (noteList.length && noteList.every((note) => (note?.status || 'none') === 'closed')) ||
        (!noteList.length && (summary?.open_count || 0) === 0 && (summary?.closed_count || 0) > 0)
    );
    const effectiveHasDirect = hasDirect && !allClosed;
    const hasAny = noteChildren || effectiveHasDirect;
    if (!hasAny) return '';
    const hasDeadline = effectiveHasDirect && (noteList.some((note) => !!note.deadline) || Boolean(summary?.has_overdue));
    const hasHighPriority = effectiveHasDirect && (noteList.some((note) => note.priority === 'high') || Boolean(summary?.has_high_priority));
    const parts = [];
    if (effectiveHasDirect) {
        parts.push('<span class="note-indicator" title="Notes available" aria-label="Notes available">📄</span>');
        if (hasDeadline) {
            parts.push('<span class="note-indicator" title="Deadline present" aria-label="Deadline present">⏰</span>');
        }
        if (hasHighPriority) {
            parts.push('<span class="note-indicator" title="High priority note" aria-label="High priority note">❗</span>');
        }
    }
    if (noteChildren && !effectiveHasDirect) {
        parts.push('<span class="note-indicator" title="Folder contains noted items" aria-label="Folder contains noted items">📚</span>');
    } else if (noteChildren && effectiveHasDirect) {
        parts.push('<span class="note-indicator" title="Folder contains noted items" aria-label="Folder contains noted items">📚</span>');
    }
    return parts.join('');
}

export function renderValidationIcon(item) {
    if (!item || item.is_dir || !item.validated) {
        return '';
    }
    return `
        <span class="validation-indicator" title="Validated" aria-label="Validated">
            <svg class="validation-icon" viewBox="0 0 24 24" role="presentation" focusable="false">
                <polyline points="7 12.5 10.5 16 17 8" />
            </svg>
        </span>

    `;
}

export function buildTagLookup(tags) {
    const lookup = new Map();
    (tags || []).forEach((tag) => {
        if (tag && tag.id) {
            lookup.set(tag.id, tag);
        }
    });
    return lookup;
}

export function buildCategoryGroups(items, tags, hierarchyEnabled) {
    const lookup = buildTagLookup(tags);
    const groups = new Map();
    const order = new Map();
    (tags || []).forEach((tag, index) => {
        if (tag?.id && tag.show_header !== false) {
            order.set(tag.id, index);
        }
    });
    const ensureGroup = (id, name, colorValue) => {
        const colors = resolveTagColors(colorValue || '#6c757d');
        const accentBg = colors.text === '#ffffff' ? 'rgba(255, 255, 255, 0.25)' : 'rgba(0, 0, 0, 0.15)';
        if (!groups.has(id)) {
            groups.set(id, { id, name, color: colors.background, textColor: colors.text, accentBg, items: [] });
        }
        const group = groups.get(id);
        group.name = name || group.name || 'Category';
        group.color = colors.background || group.color || '#6c757d';
        group.textColor = colors.text || group.textColor || '#ffffff';
        group.accentBg = accentBg;
        return group;
    };
    items.forEach((item) => {
        const tagIds = Array.isArray(item.tags) && item.tags.length ? item.tags : null;
        if (!tagIds) {
            ensureGroup(UNTAGGED_GROUP_ID, 'Uncategorized', '#6c757d').items.push(item);
            return;
        }
        const visibleTags = tagIds.filter((tagId) => {
            const meta = lookup.get(tagId);
            return meta && meta.show_header !== false;
        });
        const targetTags = visibleTags.length ? visibleTags : [];
        if (!targetTags.length) {
            ensureGroup(UNTAGGED_GROUP_ID, 'Uncategorized', '#6c757d').items.push(item);
            return;
        }
        targetTags.forEach((tagId) => {
            const meta = lookup.get(tagId);
            const name = meta?.name || tagId;
            const color = meta?.color || '#6c757d';
            ensureGroup(tagId, name, color).items.push(item);
        });
    });
    const tagById = new Map();
    (tags || []).forEach((tag) => {
        if (tag?.id && tag.show_header !== false) {
            tagById.set(tag.id, tag);
            // ensure group exists even without direct items so descendant counts can bubble
            ensureGroup(tag.id, tag.name, tag.color);
        }
    });

    if (!hierarchyEnabled) {
        const list = Array.from(groups.values()).filter((group) => group.items.length);
        list.sort((a, b) => {
            if (a.id === UNTAGGED_GROUP_ID && b.id !== UNTAGGED_GROUP_ID) return 1;
            if (b.id === UNTAGGED_GROUP_ID && a.id !== UNTAGGED_GROUP_ID) return -1;
            const aOrder = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
            const bOrder = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return a.name.localeCompare(b.name);
        });
        return list;
    }

    const childrenByParent = new Map();
    const parentMap = new Map();
    const roots = [];
    const getOrder = (id) => (order.has(id) ? order.get(id) : Number.MAX_SAFE_INTEGER);

    function resolvedParent(tagId) {
        const tag = tagById.get(tagId);
        if (!tag) return null;
        let parent = tag.parent_id || null;
        const seen = new Set([tagId]);
        while (parent) {
            if (seen.has(parent)) {
                console.warn?.('Cycle detected in tags, ignoring parent', { tagId, parent });
                return null;
            }
            seen.add(parent);
            if (!tagById.has(parent)) {
                return null;
            }
            const ancestor = tagById.get(parent);
            parent = ancestor?.parent_id || null;
            if (parent === tagId) {
                console.warn?.('Cycle detected in tags, ignoring parent', { tagId, parent });
                return null;
            }
        }
        const directParent = tag.parent_id || null;
        if (directParent && !tagById.has(directParent)) return null;
        return directParent;
    }

    tagById.forEach((tag, id) => {
        const parentId = resolvedParent(id);
        if (!parentId) {
            roots.push(id);
            parentMap.set(id, null);
            return;
        }
        parentMap.set(id, parentId);
        if (!childrenByParent.has(parentId)) {
            childrenByParent.set(parentId, []);
        }
        childrenByParent.get(parentId).push(id);
    });

    const sortIds = (ids) => {
        return [...ids].sort((a, b) => {
            const aOrder = getOrder(a);
            const bOrder = getOrder(b);
            if (aOrder !== bOrder) return aOrder - bOrder;
            const aName = tagById.get(a)?.name || a;
            const bName = tagById.get(b)?.name || b;
            return aName.localeCompare(bName);
        });
    };

    function computeTotals(tagId) {
        const group = groups.get(tagId);
        const direct = group?.items?.length || 0;
        const children = childrenByParent.get(tagId) || [];
        let total = direct;
        children.forEach((childId) => {
            total += computeTotals(childId);
        });
        if (group) {
            group.totalItems = total;
        }
        return total;
    }

    function traverse(tagId, depth, output) {
        const group = groups.get(tagId);
        if (!group) return;
        const total = typeof group.totalItems === 'number' ? group.totalItems : group.items.length;
        const children = sortIds(childrenByParent.get(tagId) || []);
        if (total > 0) {
            output.push({
                ...group,
                depth,
                totalItems: total,
                parentId: parentMap.get(tagId) || null,
                children,
            });
        }
        children.forEach((childId) => traverse(childId, depth + 1, output));
    }

    const sortedRoots = sortIds(roots);
    sortedRoots.forEach((id) => computeTotals(id));
    const list = [];
    sortedRoots.forEach((rootId) => traverse(rootId, 0, list));

    // Append Uncategorized as last if present
    const untagged = groups.get(UNTAGGED_GROUP_ID);
    if (untagged && untagged.items.length) {
        untagged.depth = 0;
        untagged.totalItems = untagged.items.length;
        list.push(untagged);
    }

    list.hierarchyEnabled = true;
    list.parentMap = parentMap;
    return list;
}

export function getTableColumnCount(tableBody) {
    if (!tableBody) return 7;
    const table = tableBody.closest('table');
    if (!table) return 7;
    const headers = table.querySelectorAll('thead th');
    let visible = 0;
    headers.forEach((header) => {
        const style = window.getComputedStyle(header);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
            visible += 1;
        }
    });
    return visible || headers.length || 7;
}

export function renderTagBadges(tagIds, lookup, tagDisplayMode) {
    if (!Array.isArray(tagIds) || !tagIds.length) {
        return '';
    }
    const dotMode = tagDisplayMode === 'dots';
    const badges = [];
    tagIds.forEach((id) => {
        const tag = lookup.get(id);
        if (!tag) return;
        const colors = resolveTagColors(tag.color);
        const name = escapeHtml(tag.name || '');
        const bg = escapeHtml(colors.background);
        if (dotMode) {
            badges.push(`<span class="tag-dot" style="--tag-color:${bg};" title="${name}" aria-label="${name}"></span>`);
        } else {
            const textColor = escapeHtml(colors.text);
            badges.push(`<span class="tag-badge" style="--tag-color:${bg};--tag-color-text:${textColor};" title="${name}">${name}</span>`);
        }
    });
    if (!badges.length) {
        return '';
    }
    const wrapperClass = dotMode ? 'file-tags tag-dots' : 'file-tags';
    return `<span class="${wrapperClass} d-inline-flex flex-wrap gap-1">${badges.join('')}</span>`;
}

export function resolveTagColors(color) {
    const normalized = normalizeHex(color || '#6c757d');
    const text = pickTagTextColor(normalized);
    return { background: normalized, text };
}

function createIcon(name) {
    return `<svg class="file-icon-svg icon-${name}" viewBox="0 0 24 24" role="presentation" focusable="false"><use href="${ICON_SPRITE_PATH}#icon-${name}"></use></svg>`;
}

function extensionForItem(name = '') {
    const normalized = name.toLowerCase();
    const lastDot = normalized.lastIndexOf('.');
    if (lastDot === -1 || lastDot === normalized.length - 1) {
        return '';
    }
    return normalized.slice(lastDot + 1);
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

function pickTagTextColor(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const luminance = 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
    return luminance > 0.6 ? '#0f1115' : '#ffffff';
}

function linearize(channel) {
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}
