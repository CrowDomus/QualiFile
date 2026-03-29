const DEFAULT_DELAY_MS = 1500;
const HIDE_FALLBACK_MS = 400;
const operations = new Map();

let modalElement = null;
let modalInstance = null;
let messageElement = null;
let detailElement = null;
let cancelButton = null;
let activeOperationId = null;
let idSeed = 0;
let modalVisible = false;
let hideFallbackTimer = null;

/** Initialise the loading modal references and wiring. */
export function initLoadingModal() {
    modalElement = document.getElementById('modal-loading');
    messageElement = document.getElementById('loading-modal-message');
    detailElement = document.getElementById('loading-modal-detail');
    cancelButton = document.getElementById('loading-modal-cancel');
    if (!modalElement || !cancelButton) return;
    modalInstance = bootstrap.Modal.getOrCreateInstance(modalElement, { backdrop: 'static', keyboard: false });
    cancelButton.addEventListener('click', () => cancelActiveOperation());
    modalElement.addEventListener('hidden.bs.modal', () => {
        finalizeHideState();
    });
}

/** Create a cancellable operation that shows a modal after a delay. */
export function createLoadingOperation(options = {}) {
    const controller = options.controller || new AbortController();
    const id = `loading-op-${Date.now()}-${idSeed++}`;
    const operation = {
        id,
        controller,
        message: options.message || 'Loading...',
        detail: options.detail || 'This may take a moment.',
        delayMs: Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : DEFAULT_DELAY_MS,
        onCancel: typeof options.onCancel === 'function' ? options.onCancel : null,
        visible: false,
        completed: false,
        cancelledByUser: false,
        startedAt: Date.now(),
        timer: null,
    };

    operation.timer = window.setTimeout(() => {
        operation.visible = true;
        activateOperation(operation);
    }, operation.delayMs);

    operations.set(id, operation);

    return {
        id,
        signal: controller.signal,
        cancel: (cancelOptions = {}) => cancelOperation(id, cancelOptions),
        finish: () => finalizeOperation(id),
        isAborted: () => controller.signal?.aborted || false,
        wasCancelled: () => operation.completed && operation.cancelledByUser,
    };
}

export function isAbortError(error) {
    return error?.name === 'AbortError';
}

function activateOperation(operation) {
    if (operation.completed) return;
    if (activeOperationId && activeOperationId !== operation.id) {
        return;
    }
    showModalForOperation(operation);
}

function showModalForOperation(operation) {
    if (!modalElement || !cancelButton) {
        activeOperationId = operation.id;
        return;
    }
    if (!modalInstance) {
        modalInstance = bootstrap.Modal.getOrCreateInstance(modalElement, { backdrop: 'static', keyboard: false });
    }
    if (messageElement) {
        messageElement.textContent = operation.message || 'Loading...';
    }
    if (detailElement) {
        detailElement.textContent = operation.detail || '';
    }
    activeOperationId = operation.id;
    setCancelDisabled(false);
    modalInstance.show();
    modalVisible = true;
}

function hideModal() {
    if (!modalElement) {
        modalVisible = false;
        return;
    }
    if (!modalInstance) {
        modalInstance = bootstrap.Modal.getOrCreateInstance(modalElement, { backdrop: 'static', keyboard: false });
    }
    modalInstance?.hide();
    scheduleHideFallback();
}

function cancelActiveOperation() {
    if (activeOperationId) {
        cancelOperation(activeOperationId);
        return;
    }
    const fallback = findNextVisibleOperation();
    if (fallback) {
        cancelOperation(fallback.id);
        return;
    }
    if (isLoadingModalVisible()) {
        forceCloseLoadingModal();
    }
}

function cancelOperation(id, options = {}) {
    const operation = operations.get(id);
    if (!operation || operation.completed) return;
    operation.cancelledByUser = !options.silent;
    if (!operation.controller.signal.aborted) {
        operation.controller.abort();
    }
    if (!options.silent && operation.onCancel) {
        operation.onCancel();
    }
    finalizeOperation(id);
}

function finalizeOperation(id) {
    const operation = operations.get(id);
    if (!operation) return;
    if (operation.completed) {
        operations.delete(id);
        return;
    }
    operation.completed = true;
    if (operation.timer) {
        window.clearTimeout(operation.timer);
    }
    operations.delete(id);
    if (activeOperationId !== id) {
        return;
    }
    const next = findNextVisibleOperation();
    if (next) {
        showModalForOperation(next);
    } else {
        activeOperationId = null;
        hideModal();
    }
}

export function ensureLoadingModalClosed() {
    const next = findNextVisibleOperation();
    if (next) {
        showModalForOperation(next);
        return;
    }
    activeOperationId = null;
    if (modalVisible || (modalElement && modalElement.classList.contains('show'))) {
        hideModal();
    }
}

function findNextVisibleOperation() {
    let candidate = null;
    operations.forEach((operation) => {
        if (!operation.visible || operation.completed) {
            return;
        }
        if (!candidate || operation.startedAt < candidate.startedAt) {
            candidate = operation;
        }
    });
    return candidate;
}

function setCancelDisabled(disabled) {
    if (!cancelButton) return;
    cancelButton.disabled = !!disabled;
}

function finalizeHideState() {
    if (hideFallbackTimer) {
        window.clearTimeout(hideFallbackTimer);
        hideFallbackTimer = null;
    }
    if (isLoadingModalVisible()) {
        setCancelDisabled(false);
        return;
    }
    modalVisible = false;
    setCancelDisabled(true);
}

function scheduleHideFallback() {
    if (hideFallbackTimer) {
        window.clearTimeout(hideFallbackTimer);
    }
    hideFallbackTimer = window.setTimeout(() => {
        hideFallbackTimer = null;
        const next = findNextVisibleOperation();
        if (next) {
            showModalForOperation(next);
            return;
        }
        if (isLoadingModalVisible()) {
            forceCloseLoadingModal();
        } else {
            finalizeHideState();
        }
    }, HIDE_FALLBACK_MS);
}

function isLoadingModalVisible() {
    if (!modalElement) return false;
    if (modalElement.classList.contains('show')) return true;
    return modalElement.style.display === 'block';
}

function hasOtherOpenModals() {
    if (!modalElement) return false;
    return Array.from(document.querySelectorAll('.modal.show')).some((el) => el !== modalElement);
}

function forceCloseLoadingModal() {
    if (!modalElement) return;
    modalElement.classList.remove('show');
    modalElement.style.display = 'none';
    modalElement.setAttribute('aria-hidden', 'true');
    if (!hasOtherOpenModals()) {
        document.body.classList.remove('modal-open');
        document.body.style.removeProperty('padding-right');
        document.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.remove());
    }
    finalizeHideState();
}
