/** Keep multiple annotation canvases visible while one shared toolbar edits the active file. */
export function createAnnotationPanels({ area, wrapper, entries, activate }) {
  const original = Array.from(area.childNodes);
  const grid = document.createElement('div');
  grid.className = 'annotation-panels';
  grid.setAttribute('aria-label', 'Annotation files');
  const panels = new Map();
  for (const entry of entries) {
    if (panels.has(entry.path)) continue;
    const card = document.createElement('section');
    card.className = 'annotation-panel';
    card.dataset.path = entry.path;
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'annotation-panel-heading';
    header.textContent = entry.displayName;
    const status = document.createElement('span');
    status.className = 'annotation-panel-status';
    header.appendChild(status);
    card.appendChild(header);
    const body = wrapper.cloneNode(true);
    body.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
    body.removeAttribute('id');
    body.querySelector('.annotate-stage').replaceChildren();
    const panel = {
      entry,
      card,
      header,
      status,
      wrapper: body,
      stageHost: body.querySelector('.annotate-stage'),
      stageOverlay: body.querySelector('.annotate-stage-overlay'),
      stageMessage: body.querySelector('.annotate-stage-overlay .text-center > div:last-child'),
      snapshot: null,
      dirty: false,
    };
    if (entry.readOnly) {
      status.textContent = 'Read only';
      header.disabled = true;
      body.replaceChildren(entry.preview);
      body.classList.add('annotation-panel-readonly');
    } else {
      status.textContent = 'Loading...';
      header.addEventListener('click', () => activate(entry.path));
      card.addEventListener(
        'pointerdown',
        (event) => {
          if (!activate(entry.path)) {
            event.preventDefault();
            event.stopPropagation();
          }
        },
        true
      );
    }
    card.appendChild(body);
    grid.appendChild(card);
    panels.set(entry.path, panel);
  }
  area.replaceChildren(grid);
  grid.classList.toggle('annotation-panels-scroll', panels.size > 4);
  let resizeObserver = null;
  const controller = {
    panels,
    grid,
    active: null,
    busy: false,
    setActive(path) {
      this.active = path;
      for (const [key, panel] of panels) {
        const selected = key === path;
        panel.card.classList.toggle('is-active', selected);
        panel.header.setAttribute('aria-pressed', String(selected));
        for (const [node, id] of [
          [panel.wrapper, 'annotate-stage-wrapper'],
          [panel.stageHost, 'annotate-stage'],
          [panel.stageOverlay, 'annotate-stage-overlay'],
          [panel.stageMessage, 'annotate-stage-message'],
        ]) {
          if (selected) node.id = id;
          else node.removeAttribute('id');
        }
      }
    },
    status(path, dirty, message = '') {
      const panel = panels.get(path);
      if (!panel || panel.entry.readOnly) return;
      panel.dirty = dirty;
      panel.status.textContent = message || (dirty ? 'Unsaved' : 'Saved');
      panel.card.classList.toggle('has-changes', dirty);
    },
    destroy() {
      resizeObserver?.disconnect();
      for (const panel of panels.values()) {
        panel.snapshot?.resizeObserver?.disconnect();
        panel.snapshot?.pdf?.destroy();
        panel.snapshot?.stage?.destroy();
      }
      area.replaceChildren(...original);
    },
  };
  if (window.ResizeObserver) {
    resizeObserver = new ResizeObserver(() => {
      for (const [path, panel] of panels) {
        const snapshot = panel.snapshot;
        if (!snapshot?.stage || controller.active === path) continue;
        const { stage, contentGroup, imageSize, zoom } = snapshot;
        const rect = panel.wrapper.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const center = contentGroup
          .getAbsoluteTransform()
          .copy()
          .invert()
          .point({
            x: stage.width() / 2,
            y: stage.height() / 2,
          });
        stage.size({ width: rect.width, height: rect.height });
        snapshot.baseScale = Math.max(
          0.01,
          Math.min(rect.width / imageSize.width, rect.height / imageSize.height)
        );
        const scale = snapshot.baseScale * zoom;
        contentGroup.scale({ x: scale, y: scale });
        contentGroup.position({
          x: rect.width / 2 - center.x * scale,
          y: rect.height / 2 - center.y * scale,
        });
        stage.batchDraw();
      }
    });
    panels.forEach((panel) => resizeObserver.observe(panel.wrapper));
  }
  return controller;
}
