export function initHeaderAddNoteProjects() {
  const button = document.getElementById('header-add-note-projects');
  if (!button) return;
  button.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('qualifile:projects-add-note'));
  });
}
