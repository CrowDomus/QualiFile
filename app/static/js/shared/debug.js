/**
 * Lightweight runtime diagnostics to surface silent failures.
 * - Logs uncaught errors and promise rejections.
 * - Wraps fetch to log non-2xx responses (status, url, snippet).
 * Keeps behaviour transparent for production; no UI changes beyond console.
 */

(() => {
    if (window.__QUALIFILE_DEBUG_ACTIVE__) return;
    window.__QUALIFILE_DEBUG_ACTIVE__ = true;

    window.addEventListener('error', (event) => {
        const { message, filename, lineno, colno, error } = event;
        // eslint-disable-next-line no-console
        console.error('[QualiFile][error]', { message, filename, lineno, colno, stack: error?.stack });
    });

    window.addEventListener('unhandledrejection', (event) => {
        // eslint-disable-next-line no-console
        console.error('[QualiFile][unhandledrejection]', event.reason);
    });

    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (!response.ok) {
            const clone = response.clone();
            let bodySnippet = '';
            try {
                const text = await clone.text();
                bodySnippet = text.slice(0, 400);
            } catch (error) {
                bodySnippet = `[failed to read body: ${error}]`;
            }
            // eslint-disable-next-line no-console
            console.error('[QualiFile][fetch]', {
                url: response.url,
                status: response.status,
                statusText: response.statusText,
                body: bodySnippet,
            });
        }
        return response;
    };
})();
