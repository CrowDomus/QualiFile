import { fetchFileUrl } from './api.js';

const THUMBNAIL_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);
const MAX_CONCURRENT_LOADS = 6;
const OBSERVER_ROOT_MARGIN = '220px 0px';
const FALLBACK_ENQUEUE_DELAY_MS = 320;

const thumbnailCache = new Map();
const inFlightLoads = new Map();
const regionState = new WeakMap();
const loadQueue = [];

let activeLoads = 0;
let observer = null;

function parseRootMargin(rawMargin = '', index = 0) {
    const tokens = String(rawMargin).trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return 0;
    const expanded = [tokens[0], tokens[1] || tokens[0], tokens[2] || tokens[0], tokens[3] || tokens[1] || tokens[0]];
    const token = expanded[index] || '0';
    const parsed = Number.parseFloat(token);
    return Number.isFinite(parsed) ? parsed : 0;
}

function isNearViewport(region) {
    if (!region || typeof window === 'undefined') return false;
    const rect = region.getBoundingClientRect();
    const verticalMargin = parseRootMargin(OBSERVER_ROOT_MARGIN, 0);
    const horizontalMargin = parseRootMargin(OBSERVER_ROOT_MARGIN, 1);
    return (
        rect.bottom >= -verticalMargin &&
        rect.top <= window.innerHeight + verticalMargin &&
        rect.right >= -horizontalMargin &&
        rect.left <= window.innerWidth + horizontalMargin
    );
}

function clearFallbackTimer(state) {
    if (!state?.fallbackTimer || typeof window === 'undefined') return;
    window.clearTimeout(state.fallbackTimer);
    state.fallbackTimer = null;
}

function scheduleFallbackEnqueue(state) {
    if (!state || typeof window === 'undefined') return;
    clearFallbackTimer(state);
    state.fallbackTimer = window.setTimeout(() => {
        state.fallbackTimer = null;
        if (!state.region?.isConnected) return;
        const cached = thumbnailCache.get(state.key);
        if (cached?.status === 'loaded') {
            applyLoaded(state, cached.url);
            return;
        }
        if (cached?.status === 'failed') return;
        enqueue(state);
    }, FALLBACK_ENQUEUE_DELAY_MS);
}

function extensionForItem(item) {
    if (!item) return '';
    const typeValue = typeof item.type === 'string' ? item.type.trim().toLowerCase() : '';
    if (typeValue && typeValue !== 'directory') {
        return typeValue;
    }
    const name = (item.name || item.path || '').toLowerCase();
    const match = name.match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
}

function isThumbnailEligible(item) {
    if (!item || item.is_dir) return false;
    return THUMBNAIL_EXTENSIONS.has(extensionForItem(item));
}

function applyFallback(state) {
    if (!state?.region) return;
    clearFallbackTimer(state);
    state.region.classList.remove('is-loaded');
    if (state.image) {
        state.image.removeAttribute('src');
        state.image.classList.add('d-none');
    }
    if (state.placeholder) {
        state.placeholder.classList.remove('d-none');
    }
}

function applyLoaded(state, url) {
    if (!state?.region || !url) return;
    clearFallbackTimer(state);
    if (state.image) {
        state.image.src = url;
        state.image.classList.remove('d-none');
    }
    if (state.placeholder) {
        state.placeholder.classList.add('d-none');
    }
    state.region.classList.add('is-loaded');
}

function applyCachedState(state) {
    const cached = thumbnailCache.get(state?.key || '');
    if (!cached || cached.status !== 'loaded') {
        applyFallback(state);
        return;
    }
    applyLoaded(state, cached.url);
}

function startLoad(key, url) {
    const existing = inFlightLoads.get(key);
    if (existing) {
        return existing;
    }
    const pending = new Promise((resolve) => {
        const probe = new Image();
        probe.decoding = 'async';
        probe.onload = () => {
            thumbnailCache.set(key, { status: 'loaded', url });
            resolve();
        };
        probe.onerror = () => {
            thumbnailCache.set(key, { status: 'failed' });
            resolve();
        };
        probe.src = url;
    }).finally(() => {
        inFlightLoads.delete(key);
    });
    inFlightLoads.set(key, pending);
    return pending;
}

function runQueue() {
    while (activeLoads < MAX_CONCURRENT_LOADS && loadQueue.length) {
        const next = loadQueue.shift();
        if (!next) continue;
        next.enqueued = false;
        if (!next.region?.isConnected) {
            clearFallbackTimer(next);
            continue;
        }

        const cached = thumbnailCache.get(next.key);
        if (cached?.status === 'loaded') {
            applyLoaded(next, cached.url);
            continue;
        }
        if (cached?.status === 'failed') {
            applyFallback(next);
            continue;
        }

        const active = inFlightLoads.get(next.key);
        if (active) {
            active.finally(() => applyCachedState(next));
            continue;
        }

        activeLoads += 1;
        startLoad(next.key, next.url)
            .finally(() => {
                activeLoads = Math.max(0, activeLoads - 1);
                applyCachedState(next);
                runQueue();
            });
    }
}

function enqueue(state) {
    if (!state || state.enqueued) return;
    state.enqueued = true;
    loadQueue.push(state);
    runQueue();
}

function handleIntersections(entries) {
    entries.forEach((entry) => {
        if (!entry.target?.isConnected) {
            observer?.unobserve(entry.target);
            return;
        }
        if (!entry.isIntersecting) return;
        const state = regionState.get(entry.target);
        if (!state) {
            observer?.unobserve(entry.target);
            return;
        }
        if (observer) {
            observer.unobserve(entry.target);
        }
        clearFallbackTimer(state);
        enqueue(state);
    });
}

function ensureObserver() {
    if (observer) return observer;
    if (typeof window === 'undefined' || typeof window.IntersectionObserver !== 'function') {
        return null;
    }
    observer = new window.IntersectionObserver(handleIntersections, {
        root: null,
        rootMargin: OBSERVER_ROOT_MARGIN,
        threshold: 0.01,
    });
    return observer;
}

function createThumbnailShell(region, fallbackIconHtml) {
    region.innerHTML = '';

    const image = document.createElement('img');
    image.className = 'file-card-thumb-image d-none';
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';

    const placeholder = document.createElement('div');
    placeholder.className = 'file-card-thumb-placeholder';
    placeholder.innerHTML = fallbackIconHtml || '';

    region.appendChild(image);
    region.appendChild(placeholder);

    return { image, placeholder };
}

export function attachGridCardThumbnail(card, item, fallbackIconHtml = '') {
    const region = card?.querySelector('[data-thumb-region]');
    if (!region) return;

    const key = String(item?.path || '').trim();
    const url = key ? fetchFileUrl(key) : '';
    const shell = createThumbnailShell(region, fallbackIconHtml);
    const state = {
        key,
        url,
        region,
        image: shell.image,
        placeholder: shell.placeholder,
        enqueued: false,
        fallbackTimer: null,
    };
    regionState.set(region, state);

    if (!key || !url || !isThumbnailEligible(item)) {
        applyFallback(state);
        return;
    }

    const cached = thumbnailCache.get(key);
    if (cached?.status === 'loaded') {
        applyLoaded(state, cached.url);
        return;
    }
    let shouldRetryCachedFailure = false;
    if (cached?.status === 'failed') {
        // Failure can be transient (e.g. stale observer timing during rapid navigation).
        // Retry on the next attachment instead of requiring a full page reload.
        thumbnailCache.delete(key);
        shouldRetryCachedFailure = true;
        applyFallback(state);
    }

    const io = ensureObserver();
    if (io) {
        io.observe(region);
        if (isNearViewport(region) || shouldRetryCachedFailure) {
            enqueue(state);
        }
        scheduleFallbackEnqueue(state);
        return;
    }

    enqueue(state);
}
