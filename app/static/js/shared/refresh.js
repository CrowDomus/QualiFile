export const GLOBAL_REFRESH_EVENT = 'qualifile:global-refresh-request';

export function requestGlobalRefresh(detail = {}) {
  document.dispatchEvent(new CustomEvent(GLOBAL_REFRESH_EVENT, { detail }));
}
