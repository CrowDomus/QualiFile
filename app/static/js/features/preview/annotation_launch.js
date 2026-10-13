import { supportedImage } from './image_history.js';

export function canAnnotatePreview(path, type) {
  return (type === 'image' && supportedImage(path)) || (type === 'pdf' && /\.pdf$/i.test(path));
}

/** Switch between fullscreen viewers and the editor without stacking focus traps. */
export async function launchPreviewAnnotation(options, { viewer = null, onReturn = null } = {}) {
  const editor = document.getElementById('modal-annotate');
  if (!editor) throw new Error('Annotation workspace is unavailable.');
  const wasOpen = viewer?.classList.contains('show');
  if (wasOpen) {
    await new Promise((resolve) => {
      viewer.addEventListener('hidden.bs.modal', resolve, { once: true });
      bootstrap.Modal.getOrCreateInstance(viewer).hide();
    });
  }
  let returned = false;
  let opened = false;
  const opening = () => {
    opened = true;
  };
  const restore = async () => {
    if (returned) return;
    returned = true;
    editor.removeEventListener('hidden.bs.modal', closed);
    editor.removeEventListener('show.bs.modal', opening);
    if (wasOpen && onReturn) await onReturn();
  };
  const closed = () => {
    if (!opened) return;
    // Let the editor finish releasing its stage before restoring viewer focus.
    queueMicrotask(() => void restore());
  };
  editor.addEventListener('show.bs.modal', opening, { once: true });
  editor.addEventListener('hidden.bs.modal', closed);
  try {
    const { openAnnotationModal } = await import('./annotator.js');
    await openAnnotationModal(options);
    if (!opened) await restore();
  } catch (error) {
    await restore();
    throw error;
  }
}
