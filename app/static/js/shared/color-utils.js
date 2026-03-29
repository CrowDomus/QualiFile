function parseHexToRgb(value) {
    if (typeof value !== 'string') return null;
    let text = value.trim();
    if (!text) return null;
    if (text.startsWith('#')) text = text.slice(1);
    if (text.length === 3) {
        text = text
            .split('')
            .map((ch) => ch + ch)
            .join('');
    }
    if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
    const r = parseInt(text.slice(0, 2), 16);
    const g = parseInt(text.slice(2, 4), 16);
    const b = parseInt(text.slice(4, 6), 16);
    return { r, g, b };
}

function linearize(channel) {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function relativeLuminance({ r, g, b }) {
    return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrastRatio(l1, l2) {
    const light = Math.max(l1, l2);
    const dark = Math.min(l1, l2);
    return (light + 0.05) / (dark + 0.05);
}

export function pickReadableTextColor(
    bgHex,
    { light = '#FFFFFF', dark = '#0F1115', min = 4.5 } = {},
) {
    const bg = parseHexToRgb(bgHex);
    if (!bg) return 'var(--bs-body-color)';
    const lightRgb = parseHexToRgb(light) || { r: 255, g: 255, b: 255 };
    const darkRgb = parseHexToRgb(dark) || { r: 15, g: 17, b: 21 };
    const bgLum = relativeLuminance(bg);
    const lightRatio = contrastRatio(bgLum, relativeLuminance(lightRgb));
    const darkRatio = contrastRatio(bgLum, relativeLuminance(darkRgb));
    if (lightRatio >= darkRatio) {
        return lightRatio >= min ? light : light;
    }
    return darkRatio >= min ? dark : dark;
}
