const CONTEXT_MENU_MARGIN_PX = 8;

export function getSyncManagerContextMenuNodes() {
  const menu = document.getElementById('sync-manager-context-menu');
  return {
    menu,
    actionButtons: menu ? Array.from(menu.querySelectorAll('[data-context-action]')) : [],
  };
}

export function isSyncManagerContextMenuVisible(menuNode) {
  if (!(menuNode instanceof HTMLElement)) {
    return false;
  }
  return menuNode.classList.contains('visible');
}

export function closeSyncManagerContextMenu(menuNode) {
  if (!(menuNode instanceof HTMLElement)) {
    return;
  }
  menuNode.classList.remove('visible');
  menuNode.style.left = '-9999px';
  menuNode.style.top = '-9999px';
  menuNode.setAttribute('aria-hidden', 'true');
}

export function positionSyncManagerContextMenu(menuNode, x, y) {
  if (!(menuNode instanceof HTMLElement)) {
    return;
  }
  const requestedX = Number.isFinite(Number(x)) ? Number(x) : CONTEXT_MENU_MARGIN_PX;
  const requestedY = Number.isFinite(Number(y)) ? Number(y) : CONTEXT_MENU_MARGIN_PX;

  menuNode.classList.remove('visible');
  menuNode.style.left = `${Math.max(CONTEXT_MENU_MARGIN_PX, Math.round(requestedX))}px`;
  menuNode.style.top = `${Math.max(CONTEXT_MENU_MARGIN_PX, Math.round(requestedY))}px`;

  const rect = menuNode.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const nextLeft = Math.min(
    Math.max(CONTEXT_MENU_MARGIN_PX, requestedX),
    Math.max(CONTEXT_MENU_MARGIN_PX, viewportWidth - rect.width - CONTEXT_MENU_MARGIN_PX)
  );
  const nextTop = Math.min(
    Math.max(CONTEXT_MENU_MARGIN_PX, requestedY),
    Math.max(CONTEXT_MENU_MARGIN_PX, viewportHeight - rect.height - CONTEXT_MENU_MARGIN_PX)
  );
  menuNode.style.left = `${Math.round(nextLeft)}px`;
  menuNode.style.top = `${Math.round(nextTop)}px`;
  menuNode.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    menuNode.classList.add('visible');
  });
}

export function shouldIgnoreSyncManagerContextMenuTarget(targetNode) {
  if (!(targetNode instanceof HTMLElement)) {
    return false;
  }
  return Boolean(
    targetNode.closest(
      'button, a, input, select, textarea, summary, [role="button"], [contenteditable="true"]'
    )
  );
}
