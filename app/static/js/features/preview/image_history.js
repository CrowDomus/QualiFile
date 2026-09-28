import { requestJson, fetchList, fetchFileUrl, handleError } from '../../shared/api.js';
import { state } from '../../shared/state.js';
import { showToast } from '../../shared/ui.js';
import { requestGlobalRefresh } from '../../shared/refresh.js';

export const supportedImage = (path) => /\.(png|jpe?g|webp)$/i.test(path);
const endpoint = '/api/image-history';
const post = (url, payload) =>
  requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

export const loadAnnotationDocument = (path) =>
  requestJson(`${endpoint}/document?path=${encodeURIComponent(path)}`);
export const annotationBaseUrl = (path) =>
  `${endpoint}/document?path=${encodeURIComponent(path)}&asset=base&t=${Date.now()}`;
const annotationOverlayUrl = (path) =>
  `${endpoint}/document?path=${encodeURIComponent(path)}&asset=overlay&t=${Date.now()}`;

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function button(text, action, className = 'btn btn-outline-secondary') {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try {
      await action();
    } catch (error) {
      handleError(error);
    } finally {
      node.disabled = false;
    }
  });
  return node;
}

function modal(title) {
  const host = element('div', 'modal');
  host.tabIndex = -1;
  host.setAttribute('aria-label', title);
  const dialog = element(
    'div',
    'modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable'
  );
  const content = element('div', 'modal-content');
  const header = element('div', 'modal-header');
  const body = element('div', 'modal-body');
  const footer = element('div', 'modal-footer');
  let instance;
  const close = button('', () => instance.hide(), 'btn-close ms-auto flex-shrink-0');
  close.setAttribute('aria-label', 'Close');
  close.title = 'Close';
  header.append(element('h2', 'modal-title fs-5 text-break flex-grow-1', title), close);
  content.append(header, body, footer);
  dialog.append(content);
  host.append(dialog);
  document.body.append(host);
  instance = new window.bootstrap.Modal(host);
  host.addEventListener(
    'hidden.bs.modal',
    () => {
      instance.dispose();
      host.remove();
    },
    { once: true }
  );
  instance.show();
  return { host, body, footer, close: () => instance.hide() };
}

export function chooseAnnotationReference() {
  const view = modal('Choose reference image');
  const pathLabel = element('p', 'text-break');
  const list = element('div', 'list-group');
  const status = element('p', 'mt-3');
  const preserveOption = element('div', 'form-check mt-3');
  const preserve = element('input', 'form-check-input');
  preserve.type = 'checkbox';
  preserve.id = 'annotation-reference-preserve-existing';
  const preserveLabel = element('label', 'form-check-label', 'Keep existing annotations');
  preserveLabel.htmlFor = preserve.id;
  preserveOption.append(preserve, preserveLabel);
  let selected = null;
  let current = state.currentPath || '.';
  let settled = false;
  let generation = 0;
  let selectedRow = null;
  let resolveChoice;
  const promise = new Promise((resolve) => {
    resolveChoice = resolve;
  });
  const apply = button(
    'Use reference',
    () => {
      settled = true;
      resolveChoice({ ...selected, preserveExisting: preserve.checked });
      view.close();
    },
    'btn btn-primary'
  );
  apply.disabled = true;
  view.body.append(pathLabel, list, status, preserveOption);
  view.footer.append(apply);
  view.host.addEventListener('hidden.bs.modal', () => {
    if (!settled) resolveChoice(null);
  });
  async function browse(path) {
    path = path.replace(/\\/g, '/');
    const ticket = ++generation;
    current = path;
    selected = null;
    selectedRow = null;
    apply.disabled = true;
    pathLabel.textContent = path;
    status.textContent = 'Loading...';
    list.replaceChildren();
    const data = await fetchList(path, false);
    if (ticket !== generation) return;
    async function selectImage(item, row, nameButton) {
      const selectionTicket = ++generation;
      selected = null;
      apply.disabled = true;
      selectedRow?.classList.remove('list-group-item-primary');
      selectedRow?.querySelector('[aria-pressed]')?.setAttribute('aria-pressed', 'false');
      selectedRow = null;
      status.textContent = 'Loading annotations...';
      const reference = await loadAnnotationDocument(item.path);
      if (selectionTicket !== generation) return null;
      if (!reference.document.nodes.length) {
        status.textContent = 'The reference image does not have annotations.';
        return reference;
      }
      selected = { path: item.path, ...reference };
      selectedRow = row;
      row.classList.add('list-group-item-primary');
      nameButton.setAttribute('aria-pressed', 'true');
      status.textContent = `${reference.document.nodes.length} annotations`;
      apply.disabled = false;
      return reference;
    }
    if (path !== '.')
      list.append(
        button(
          'Parent folder',
          () => browse(path.split('/').slice(0, -1).join('/') || '.'),
          'list-group-item list-group-item-action'
        )
      );
    for (const item of data.items || []) {
      if (!item.is_dir && !supportedImage(item.path)) continue;
      const row = element('div', 'list-group-item d-flex align-items-center gap-2');
      const nameButton = button(
        `${item.is_dir ? 'Folder: ' : ''}${item.name}`,
        () => (item.is_dir ? browse(item.path) : selectImage(item, row, nameButton)),
        'btn btn-link text-start flex-grow-1 text-break'
      );
      if (!item.is_dir) nameButton.setAttribute('aria-pressed', 'false');
      row.append(nameButton);
      if (!item.is_dir) {
        row.append(
          button(
            'Show',
            async () => {
              const reference = await selectImage(item, row, nameButton);
              if (!reference) return;
              const preview = modal(`Reference: ${item.name}`);
              const frame = element('div', 'annotation-reference-preview mx-auto');
              const image = element('img', 'annotation-reference-preview-base');
              image.alt = item.name;
              image.src = reference.document.nodes.length
                ? annotationBaseUrl(item.path)
                : `${fetchFileUrl(item.path)}&t=${Date.now()}`;
              image.addEventListener('error', () => {
                preview.body.replaceChildren(
                  element('p', 'text-danger', 'Unable to show this image.')
                );
              });
              frame.append(image);
              if (reference.document.nodes.length) {
                const overlay = element('img', 'annotation-reference-preview-overlay');
                overlay.alt = `Annotations for ${item.name}`;
                overlay.src = annotationOverlayUrl(item.path);
                overlay.addEventListener('error', () => {
                  preview.body.replaceChildren(
                    element('p', 'text-danger', 'Unable to show annotations for this image.')
                  );
                });
                frame.append(overlay);
              }
              preview.body.append(frame);
            },
            'btn btn-outline-secondary btn-sm'
          )
        );
      }
      list.append(row);
    }
    status.textContent = 'Select an image with saved annotations.';
  }
  browse(current).catch(handleError);
  return promise;
}

export async function applyReferenceToImages(paths) {
  const reference = await chooseAnnotationReference();
  if (!reference) return;
  const targets = [...new Set(paths)];
  const view = modal('Apply annotations');
  view.body.append(element('p', 'text-break mb-2', reference.path.split('/').pop()));
  const status = element(
    'p',
    'text-muted small',
    `${targets.length} images · ${reference.preserveExisting ? 'Keep existing annotations' : 'Replace annotations'}`
  );
  status.setAttribute('aria-live', 'polite');
  const progress = element('progress', 'w-100 d-none');
  progress.max = targets.length;
  progress.value = 0;
  progress.setAttribute('aria-label', 'Images processed');
  const failures = element('details', 'mt-2 d-none');
  failures.append(element('summary', '', 'Details'));
  view.body.append(status, progress, failures);
  let running = false;
  view.host.addEventListener('hide.bs.modal', (event) => {
    if (running) event.preventDefault();
  });
  const apply = button(
    'Apply',
    async () => {
      running = true;
      apply.disabled = true;
      progress.classList.remove('d-none');
      status.textContent = `0 of ${targets.length} processed`;
      try {
        const result = await requestJson(`${endpoint}/duplicate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
          body: JSON.stringify({
            reference: reference.path,
            targets,
            preserve_existing: reference.preserveExisting,
          }),
          onProgress: (row, count) => {
            progress.value = count;
            status.textContent = `${count} of ${targets.length} processed`;
            if (row.status === 'failed') {
              failures.classList.remove('d-none');
              failures.append(
                element('p', 'small text-danger text-break', `${row.path}: ${row.error}`)
              );
            }
          },
        });
        const count = (kind) => result.results.filter((row) => row.status === kind).length;
        status.textContent = `${count('saved')} saved · ${count('skipped')} skipped · ${count('failed')} failed`;
      } catch (error) {
        status.textContent = error.message;
      } finally {
        running = false;
        apply.remove();
        view.footer.append(button('Done', () => view.close(), 'btn btn-primary'));
        refreshImages();
      }
    },
    'btn btn-primary'
  );
  view.footer.append(apply);
}

function refreshImages(path) {
  requestGlobalRefresh({ refreshList: true, refreshTree: false });
  for (const imagePath of path ? [path] : Array.from(state.selection || [])) {
    document.dispatchEvent(
      new CustomEvent('qualifile:preview-refresh', { detail: { path: imagePath } })
    );
  }
}

export async function restoreImage(path) {
  const data = await requestJson(`${endpoint}/versions?path=${encodeURIComponent(path)}`);
  if (!data.versions.length) {
    showToast('This image has no previous versions.');
    return;
  }
  async function restore(version) {
    await post(`${endpoint}/versions`, { path, version_id: version.id, hash: data.hash });
    showToast('Previous version restored. Current tags were preserved.');
    refreshImages(path);
  }
  if (data.versions.length === 1) {
    await restore(data.versions[0]);
    return;
  }
  const view = modal('Restore previous version');
  const list = element('div', 'd-grid gap-3');
  const mode = element('select', 'form-select mb-3');
  mode.setAttribute('aria-label', 'Version display mode');
  for (const [value, label] of [
    ['list', 'List'],
    ['thumbnails', 'Thumbnails'],
  ]) {
    const option = element('option', '', label);
    option.value = value;
    mode.append(option);
  }
  const images = [];
  for (const version of data.versions) {
    const row = element('div', 'border rounded p-3');
    const url = `${endpoint}/versions?${new URLSearchParams({ path, version_id: version.id })}`;
    const image = element('img', 'd-none mb-2');
    image.src = url;
    image.alt = `Version from ${version.created_at}`;
    image.loading = 'lazy';
    image.style.cssText = 'width:160px;height:120px;object-fit:contain';
    images.push(image);
    row.append(
      image,
      element(
        'p',
        '',
        `${new Date(version.created_at).toLocaleString()} - ${version.reason} - ${version.width} × ${version.height}`
      )
    );
    const actions = element('div', 'd-flex gap-2');
    actions.append(
      button('Show', () => {
        const preview = modal('Previous version preview');
        const full = element('img');
        full.src = url;
        full.alt = image.alt;
        full.style.cssText = 'max-width:100%;height:auto';
        const zoom = element('input', 'form-range');
        zoom.type = 'range';
        zoom.min = '25';
        zoom.max = '200';
        zoom.value = '100';
        zoom.setAttribute('aria-label', 'Preview zoom');
        zoom.addEventListener('input', () => {
          full.style.maxWidth = 'none';
          full.style.width = `${zoom.value}%`;
        });
        preview.body.append(zoom, full);
      }),
      button(
        'Restore this version',
        async () => {
          await restore(version);
          view.close();
        },
        'btn btn-primary'
      )
    );
    row.append(actions);
    list.append(row);
  }
  mode.addEventListener('change', () =>
    images.forEach((image) => image.classList.toggle('d-none', mode.value !== 'thumbnails'))
  );
  view.body.append(mode, list);
}

export async function initImageHistory() {
  const path = document.getElementById('image-history-path');
  const legacy = document.getElementById('image-history-legacy');
  if (!path || !legacy) return;
  async function load() {
    const settings = await requestJson(`${endpoint}/settings`);
    path.textContent = settings.archive_path;
    legacy.textContent = settings.legacy_archive_path
      ? `Earlier archives may still be stored at ${settings.legacy_archive_path}.`
      : '';
    legacy.classList.toggle('d-none', !settings.legacy_archive_path);
  }
  document
    .getElementById('modal-settings')
    ?.addEventListener('show.bs.modal', () => load().catch(handleError));
  await load();
}
