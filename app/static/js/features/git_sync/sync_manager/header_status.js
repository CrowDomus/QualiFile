const DEFAULT_STATUS_MESSAGE = 'Loading project sync status...';

function getHeaderStatusNodes() {
  return {
    container: document.getElementById('sync-manager-header-status'),
    text: document.getElementById('sync-manager-header-status-text'),
  };
}

export function setHeaderStatus(loading, message = '') {
  const nodes = getHeaderStatusNodes();
  if (!nodes.container || !nodes.text) {
    return;
  }
  if (!loading) {
    nodes.container.classList.add('d-none');
    nodes.container.setAttribute('aria-hidden', 'true');
    return;
  }
  nodes.text.textContent = String(message || DEFAULT_STATUS_MESSAGE);
  nodes.container.classList.remove('d-none');
  nodes.container.setAttribute('aria-hidden', 'false');
}
