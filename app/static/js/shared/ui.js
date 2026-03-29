let toastInstance = null;

/** Initialise the toast notification component. */
export function initToast() {
    const toastElement = document.getElementById('toast');
    if (!toastElement) return;
    toastInstance = bootstrap.Toast.getOrCreateInstance(toastElement, { delay: 2500 });
}

/** Display a toast notification with optional error styling. */
export function showToast(message, isError = false) {
    const toastElement = document.getElementById('toast');
    if (!toastElement) return;
    toastElement.classList.toggle('text-bg-error', isError);
    toastElement.classList.toggle('text-bg-primary', !isError);
    const body = document.getElementById('toast-body');
    body.textContent = message;
    toastInstance?.show();
}

/** Update the global status pill displayed in the header. */
export function setStatus(text) {
    const pill = document.getElementById('status-pill');
    if (pill) {
        pill.textContent = text;
    }
}

/** Render the breadcrumb navigation trail. */
export function updateBreadcrumb(parts, onNavigate) {
    const list = document.getElementById('breadcrumb-list');
    if (!list) return;
    list.innerHTML = '';
    const rootItem = document.createElement('li');
    rootItem.className = 'breadcrumb-item';
    const rootButton = document.createElement('button');
    rootButton.type = 'button';
    rootButton.textContent = 'Root';
    rootButton.addEventListener('click', () => onNavigate('.'));
    rootItem.appendChild(rootButton);
    list.appendChild(rootItem);
    let current = '.';
    for (const part of parts) {
        current = current === '.' ? part : `${current}/${part}`;
        const item = document.createElement('li');
        item.className = 'breadcrumb-item';
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = part;
        button.addEventListener('click', () => onNavigate(current));
        item.appendChild(button);
        list.appendChild(item);
    }
}

/** Update the center-pane title with the active folder name. */
export function updateFolderTitle(path) {
    const label = document.getElementById('current-folder-label');
    if (!label) return;
    const normalized = !path || path === '.' ? '' : String(path);
    const segments = normalized ? normalized.split('/') : [];
    const displayName = segments.length ? segments[segments.length - 1] : 'Root';
    const fullPath = normalized || 'Root';
    label.textContent = displayName;
    label.title = fullPath;
    const heading = document.getElementById('list-pane-title');
    if (heading) {
        heading.title = `Files in ${fullPath}`;
    }
}
