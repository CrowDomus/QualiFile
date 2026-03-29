const STORAGE_KEY = 'qualifile.annotate.toolColors';

export const COLOR_TOOLS = ['rectangle', 'highlight', 'circle', 'line', 'counter'];

export function buildDefaultToolColors(elements) {
    const defaultStroke = elements?.strokeColor?.value || '#ff4f5e';
    const defaultHighlight = elements?.highlightColor?.value || '#ffee79';
    return {
        rectangle: { stroke: defaultStroke, fill: '' },
        highlight: { stroke: defaultStroke, fill: defaultHighlight },
        circle: { stroke: defaultStroke, fill: '' },
        line: { stroke: defaultStroke, fill: '' },
        counter: { stroke: defaultStroke, fill: defaultHighlight },
    };
}

export function loadStoredToolColors(defaults) {
    try {
        const raw = window.localStorage?.getItem(STORAGE_KEY);
        if (!raw) {
            return { ...defaults };
        }
        const parsed = JSON.parse(raw);
        return { ...defaults, ...parsed };
    } catch (error) {
        console.warn('Unable to load annotate tool colors', error);
        return { ...defaults };
    }
}

export function persistToolColors(toolColors) {
    try {
        window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(toolColors));
    } catch (error) {
        console.warn('Unable to persist annotate tool colors', error);
    }
}

export function syncToolPalette(tool, elements, toolColors, defaults) {
    if (!COLOR_TOOLS.includes(tool) || !toolColors) return toolColors;
    const next = { ...(toolColors[tool] || defaults?.[tool] || {}) };
    if (elements?.strokeColor?.value) {
        next.stroke = elements.strokeColor.value;
    }
    if (elements?.highlightColor?.value) {
        next.fill = elements.highlightColor.value;
    }
    toolColors[tool] = next;
    persistToolColors(toolColors);
    return toolColors;
}

export function applyToolPalette(tool, elements, toolColors, defaults) {
    if (!COLOR_TOOLS.includes(tool)) return;
    const palette = toolColors?.[tool] || defaults?.[tool] || {};
    if (elements?.strokeColor && palette.stroke) {
        elements.strokeColor.value = palette.stroke;
    }
    if (elements?.highlightColor && palette.fill) {
        elements.highlightColor.value = palette.fill;
    }
}

export function mimeToExtension(mime) {
    switch ((mime || '').toLowerCase()) {
        case 'image/jpeg':
        case 'image/jpg':
            return '.jpg';
        case 'image/webp':
            return '.webp';
        default:
            return '.png';
    }
}

export function colorWithOpacity(hex, opacity) {
    const normalized = hex?.startsWith('#') ? hex.slice(1) : hex;
    if (!normalized || normalized.length < 6) {
        return `rgba(255, 235, 59, ${opacity})`;
    }
    const bigint = parseInt(normalized, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
