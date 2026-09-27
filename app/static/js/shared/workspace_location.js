/** Keep each tab's folder in its URL, with a workspace-scoped fallback. */
export function readLocation(rootId, storage, href) {
  const url = new URL(href);
  if (url.searchParams.get('workspace') === rootId && url.searchParams.has('folder')) {
    return url.searchParams.get('folder') || '.';
  }
  try {
    return storage.getItem(`qualifile.folder.${rootId}`) || '.';
  } catch {
    return '.';
  }
}

export function rememberLocation(rootId, path, storage, browserHistory, href) {
  try {
    storage.setItem(`qualifile.folder.${rootId}`, path);
  } catch {
    // The URL still preserves refresh behavior when storage is unavailable.
  }
  const url = new URL(href);
  url.searchParams.set('workspace', rootId);
  url.searchParams.set('folder', path);
  browserHistory.replaceState(browserHistory.state, '', url);
}
