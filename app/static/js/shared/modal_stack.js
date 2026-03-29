const MODAL_BASE_Z = 1055;
const MODAL_STEP = 20;
const BACKDROP_OFFSET = 5;
let stackingInitialised = false;

function nextZIndex() {
    const open = document.querySelectorAll('.modal.show').length;
    return MODAL_BASE_Z + (open * MODAL_STEP);
}

function restackOpenModals() {
    const openModals = Array.from(document.querySelectorAll('.modal.show'));
    openModals.forEach((modal, index) => {
        const zIndex = MODAL_BASE_Z + (index * MODAL_STEP);
        modal.style.zIndex = String(zIndex);
    });
    syncBackdrops(openModals);
    if (openModals.length > 0) {
        document.body.classList.add('modal-open');
    } else {
        document.body.classList.remove('modal-open');
    }
}

function syncBackdrops(openModals) {
    const backdrops = Array.from(document.querySelectorAll('.modal-backdrop'));
    // Remove any orphaned backdrops that can leave the UI frozen.
    while (backdrops.length > openModals.length) {
        const extra = backdrops.shift();
        if (extra?.parentNode) extra.parentNode.removeChild(extra);
    }
    backdrops.forEach((backdrop, index) => {
        const relatedModal = openModals[index];
        if (!relatedModal) {
            backdrop.remove();
            return;
        }
        const modalZ = Number.parseInt(relatedModal.style.zIndex || `${MODAL_BASE_Z}`, 10);
        backdrop.style.zIndex = String(modalZ - BACKDROP_OFFSET);
        backdrop.dataset.stackedFor = relatedModal.id || `modal-${index}`;
    });
}

export function initModalStacking() {
    if (stackingInitialised) return;
    stackingInitialised = true;

    document.addEventListener('show.bs.modal', (event) => {
        const modal = event.target;
        if (!(modal instanceof HTMLElement)) return;
        modal.style.zIndex = String(nextZIndex());
    });

    document.addEventListener('shown.bs.modal', (event) => {
        const modal = event.target;
        if (!(modal instanceof HTMLElement)) return;
        const modalZ = Number.parseInt(modal.style.zIndex || `${MODAL_BASE_Z}`, 10);
        const backdrop = Array.from(document.querySelectorAll('.modal-backdrop'))
            .filter((element) => !element.dataset.stackedFor)
            .pop();
        if (backdrop) {
            backdrop.style.zIndex = String(modalZ - BACKDROP_OFFSET);
            backdrop.dataset.stackedFor = modal.id || `modal-${Date.now()}`;
        }
    });

    document.addEventListener('hidden.bs.modal', () => {
        // Allow Bootstrap to remove backdrops before re-stacking the remainder.
        window.setTimeout(restackOpenModals, 0);
    });
}
