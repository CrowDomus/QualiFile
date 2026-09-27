import { errorDiagnostic } from './diagnostics.js';

/** Privacy-bounded runtime diagnostics for explicitly enabled debug sessions. */

(() => {
  if (window.__QUALIFILE_DEBUG_ACTIVE__) return;
  window.__QUALIFILE_DEBUG_ACTIVE__ = true;
  if (window.__QUALIFILE__?.debugDiagnostics !== true) return;

  window.addEventListener('error', (event) => {
    errorDiagnostic('UnhandledWindowError', event.error);
  });

  window.addEventListener('unhandledrejection', (event) => {
    errorDiagnostic('UnhandledPromiseRejection', event.reason);
  });

  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (!response.ok) {
      errorDiagnostic('FetchResponseFailure', {
        status: response.status,
        requestId: response.headers.get('X-Request-ID') || null,
      });
    }
    return response;
  };
})();
