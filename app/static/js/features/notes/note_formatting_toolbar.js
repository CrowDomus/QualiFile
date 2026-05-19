const TOOLBAR_CLASS = 'note-format-toolbar';
const ATTACHED_ATTR = 'data-note-formatting-attached';
const BULLET = '\u2022';
const INDENT = '  ';

const ACTIONS = [
    { action: 'bullet', label: 'Bullet list', text: BULLET },
    { action: 'number', label: 'Numbered list', text: '1.' },
    { action: 'indent', label: 'Indent', text: '\u2192' },
    { action: 'outdent', label: 'Outdent', text: '\u2190' },
];

function lineStartIndex(value, index) {
    return value.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
}

function lineEndIndex(value, index) {
    const next = value.indexOf('\n', index);
    return next === -1 ? value.length : next;
}

function affectedRange(value, start, end) {
    const hasSelection = end > start;
    const effectiveEnd = hasSelection && value[end - 1] === '\n' ? end - 1 : end;
    return {
        start: lineStartIndex(value, start),
        end: lineEndIndex(value, effectiveEnd),
        hasSelection,
    };
}

function splitIndent(line) {
    const match = line.match(/^(\s*)(.*)$/);
    return { indent: match?.[1] || '', body: match?.[2] || '' };
}

function stripListPrefix(body) {
    return body
        .replace(/^(?:\u2022|-)\s+/, '')
        .replace(/^\d+[.)]\s+/, '');
}

function transformLine(line, action, number, skipBlank) {
    if (skipBlank && !line.trim()) return { line, numbered: false };
    if (action === 'indent') {
        return { line: line.trim() ? `${INDENT}${line}` : line, numbered: false };
    }
    if (action === 'outdent') {
        if (line.startsWith(INDENT)) return { line: line.slice(INDENT.length), numbered: false };
        if (line.startsWith(' ')) return { line: line.slice(1), numbered: false };
        return { line, numbered: false };
    }
    const { indent, body } = splitIndent(line);
    const content = stripListPrefix(body);
    if (action === 'bullet') {
        return { line: `${indent}${BULLET} ${content}`, numbered: false };
    }
    return { line: `${indent}${number}. ${content}`, numbered: true };
}

export function formatSelectedNoteLines(textarea, action) {
    if (!textarea || !ACTIONS.some((item) => item.action === action)) return null;
    const value = textarea.value || '';
    const selectionStart = textarea.selectionStart ?? 0;
    const selectionEnd = textarea.selectionEnd ?? selectionStart;
    const range = affectedRange(value, selectionStart, selectionEnd);
    const segment = value.slice(range.start, range.end);
    const lines = segment.split('\n');
    const skipBlank = range.hasSelection && lines.length > 1;
    let nextNumber = 1;
    const transformed = lines.map((line) => {
        const result = transformLine(line, action, nextNumber, skipBlank);
        if (result.numbered) nextNumber += 1;
        return result.line;
    });
    const replacement = transformed.join('\n');
    const nextValue = `${value.slice(0, range.start)}${replacement}${value.slice(range.end)}`;
    textarea.value = nextValue;

    const lengthDelta = replacement.length - segment.length;
    if (range.hasSelection) {
        textarea.setSelectionRange(range.start, range.end + lengthDelta);
    } else {
        const caret = action === 'bullet' || action === 'number'
            ? Math.min(range.start + transformed[0].length, nextValue.length)
            : Math.min(selectionStart + lengthDelta, nextValue.length);
        textarea.setSelectionRange(caret, caret);
    }
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    return textarea.value;
}

function modeController(textarea) {
    const selector = textarea.dataset.noteFormattingModeSelect;
    if (!selector) {
        return { isEnabled: () => true, modeSelect: null };
    }
    const modeSelect = document.querySelector(selector);
    const noteValue = textarea.dataset.noteFormattingNoteValue || 'note';
    return {
        isEnabled: () => !modeSelect || modeSelect.value === noteValue,
        modeSelect,
    };
}

function buildToolbar(textarea, isEnabled) {
    const toolbar = document.createElement('div');
    toolbar.className = TOOLBAR_CLASS;
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Note formatting');
    ACTIONS.forEach(({ action, label, text }) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-outline-secondary btn-sm note-format-toolbar__button';
        button.dataset.noteFormatAction = action;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.textContent = text;
        button.addEventListener('click', () => {
            if (!isEnabled()) return;
            formatSelectedNoteLines(textarea, action);
        });
        toolbar.appendChild(button);
    });
    return toolbar;
}

function syncToolbar(toolbar, textarea, enabled) {
    toolbar.classList.toggle('d-none', !enabled);
    toolbar.setAttribute('aria-hidden', enabled ? 'false' : 'true');
    textarea.dataset.noteFormattingActive = enabled ? 'true' : 'false';
}

export function attachNoteFormattingToolbar(textarea) {
    if (!(textarea instanceof HTMLTextAreaElement)) return null;
    if (textarea.getAttribute(ATTACHED_ATTR) === 'true') {
        return textarea.previousElementSibling?.classList.contains(TOOLBAR_CLASS)
            ? textarea.previousElementSibling
            : null;
    }
    const { isEnabled, modeSelect } = modeController(textarea);
    const toolbar = buildToolbar(textarea, isEnabled);
    textarea.parentNode?.insertBefore(toolbar, textarea);
    textarea.setAttribute(ATTACHED_ATTR, 'true');
    const update = () => syncToolbar(toolbar, textarea, isEnabled());
    modeSelect?.addEventListener('change', update);
    textarea.closest('.modal')?.addEventListener('shown.bs.modal', update);
    textarea.addEventListener('focus', update);
    textarea.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab' || !isEnabled()) return;
        event.preventDefault();
        formatSelectedNoteLines(textarea, event.shiftKey ? 'outdent' : 'indent');
    });
    update();
    return toolbar;
}

export function initNoteFormattingToolbars(root = document) {
    root.querySelectorAll?.('textarea[data-note-formatting]').forEach((textarea) => {
        attachNoteFormattingToolbar(textarea);
    });
}
