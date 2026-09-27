import { selectionArray } from '../../shared/state.js';
import { normalizePath } from '../../shared/paths.js';

function labelFromPath(path) {
  const normalized = normalizePath(path);
  if (!normalized) return 'Root';
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

export function initHeaderAddNoteWorkspace() {
  const button = document.getElementById('header-add-note-workspace');
  if (!button) return;
  button.addEventListener('click', () => {
    const selected = selectionArray();
    if (selected.length === 1) {
      const targetPath = selected[0];
      document.dispatchEvent(
        new CustomEvent('qualifile:workspace-add-note', {
          detail: { path: targetPath, label: labelFromPath(targetPath) },
        })
      );
      return;
    }
    document.dispatchEvent(
      new CustomEvent('qualifile:workspace-add-note', {
        detail: { path: '.', label: 'Root' },
      })
    );
  });
}
