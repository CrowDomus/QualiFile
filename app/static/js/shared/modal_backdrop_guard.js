const CONTROL_SELECTOR =
  'input:not([type="hidden"]), textarea, select, [contenteditable]:not([contenteditable="false"])';
const modalStates = new WeakMap();
let guardInitialised = false;

function readControlValue(element) {
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox' || element.type === 'radio') {
      return element.checked;
    }
    return element.value;
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return element.value;
  }
  if (element.isContentEditable) {
    return element.textContent || '';
  }
  return '';
}

function captureBaseline(modal) {
  const baseline = new Map();
  const controls = Array.from(modal.querySelectorAll(CONTROL_SELECTOR));
  controls.forEach((control) => {
    if ('disabled' in control && control.disabled) return;
    baseline.set(control, readControlValue(control));
  });
  return baseline;
}

function isModalDirty(modal, baseline) {
  for (const [control, initialValue] of baseline.entries()) {
    if (!modal.contains(control)) continue;
    if (readControlValue(control) !== initialValue) {
      return true;
    }
  }
  return false;
}

function teardownModal(modal) {
  const state = modalStates.get(modal);
  if (!state) return;
  modal.removeEventListener('input', state.onInput, true);
  modal.removeEventListener('change', state.onInput, true);
  modal.removeEventListener('mousedown', state.onMouseDown);
  modal.removeEventListener('hide.bs.modal', state.onHide);
  modal.removeEventListener('hidden.bs.modal', state.onHidden);
  delete modal.dataset.qfDirty;
  delete modal.dataset.qfBackdropClick;
  modalStates.delete(modal);
}

function setupModal(modal) {
  if (modalStates.has(modal)) {
    teardownModal(modal);
  }
  const baseline = captureBaseline(modal);
  modal.dataset.qfDirty = '0';
  modal.dataset.qfBackdropClick = '0';

  const onInput = () => {
    const dirty = isModalDirty(modal, baseline);
    modal.dataset.qfDirty = dirty ? '1' : '0';
  };
  const onMouseDown = (event) => {
    modal.dataset.qfBackdropClick = event.target === modal ? '1' : '0';
  };
  const onHide = (event) => {
    if (modal.dataset.qfDirty === '1' && modal.dataset.qfBackdropClick === '1') {
      event.preventDefault();
      modal.dataset.qfBackdropClick = '0';
    }
  };
  const onHidden = () => {
    teardownModal(modal);
  };

  modal.addEventListener('input', onInput, true);
  modal.addEventListener('change', onInput, true);
  modal.addEventListener('mousedown', onMouseDown);
  modal.addEventListener('hide.bs.modal', onHide);
  modal.addEventListener('hidden.bs.modal', onHidden);

  modalStates.set(modal, { baseline, onInput, onMouseDown, onHide, onHidden });
}

export function initModalBackdropGuard() {
  if (guardInitialised) return;
  guardInitialised = true;

  document.addEventListener('shown.bs.modal', (event) => {
    const modal = event.target;
    if (!(modal instanceof HTMLElement)) return;
    if (!modal.classList.contains('modal')) return;
    setupModal(modal);
  });
}
