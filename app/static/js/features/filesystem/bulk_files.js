import { requestJson } from '../../shared/api.js';
import { clearSelection, setSelection } from '../../shared/state.js';
import { requestGlobalRefresh } from '../../shared/refresh.js';
import { showToast } from '../../shared/ui.js';

const post = (path, data) =>
  requestJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function dialog(title) {
  const host = node('div', 'modal');
  host.tabIndex = -1;
  host.setAttribute('aria-label', title);
  const frame = node('div', 'modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable');
  const content = node('div', 'modal-content');
  const header = node('div', 'modal-header');
  const close = node('button', 'btn-close ms-auto flex-shrink-0');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  const body = node('div', 'modal-body');
  const footer = node('div', 'modal-footer');
  const status = node('p', 'small mb-0 me-auto');
  status.setAttribute('role', 'status');
  footer.append(status);
  header.append(node('h2', 'modal-title fs-5', title), close);
  content.append(header, body, footer);
  frame.append(content);
  host.append(frame);
  document.body.append(host);
  const modal = new window.bootstrap.Modal(host);
  let busy = false;
  close.addEventListener('click', () => modal.hide());
  host.addEventListener('hide.bs.modal', (event) => {
    if (busy) event.preventDefault();
  });
  host.addEventListener('hidden.bs.modal', () => {
    modal.dispose();
    host.remove();
  });
  modal.show();
  return {
    host,
    body,
    footer,
    status,
    close: () => modal.hide(),
    busy(value) {
      busy = value;
      close.disabled = value;
      host.setAttribute('aria-busy', String(value));
    },
  };
}

let fieldSequence = 0;
function field(labelText, input) {
  const wrapper = node('div', 'mb-2');
  const label = node('label', 'form-label d-block mb-0', labelText);
  input.id = `file-operation-field-${++fieldSequence}`;
  label.htmlFor = input.id;
  wrapper.append(label, input);
  return wrapper;
}

function input(value = '', type = 'text') {
  const control = node('input', 'form-control mt-1');
  control.type = type;
  control.value = value;
  if (type === 'text') control.maxLength = 255;
  return control;
}

function previewTable(rows, restore = false) {
  const wrapper = node('div', 'table-responsive border rounded mt-3');
  const table = node('table', 'table table-sm align-middle mb-0');
  const head = node('thead');
  const headings = node('tr');
  headings.append(
    node('th', '', 'Current name'),
    node('th', '', restore ? 'Original name' : 'New name')
  );
  head.append(headings);
  const body = node('tbody');
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const line = node('tr', row.error ? 'table-danger' : '');
    const current = node('td', 'text-break', restore ? row.new : row.old);
    const proposed = node('td', 'text-break', restore ? row.old : row.new);
    if (row.error) proposed.append(node('div', 'small text-danger', row.error));
    line.append(current, proposed);
    fragment.append(line);
  }
  body.append(fragment);
  table.append(head, body);
  wrapper.append(table);
  return wrapper;
}

async function refresh(paths = []) {
  clearSelection();
  if (paths.length) setSelection(paths);
  await requestGlobalRefresh({ reason: 'file-operation', immediate: true });
}

export function openBulkRename(items) {
  const view = dialog('Rename files');
  const mode = node('select', 'form-select mt-1');
  for (const [value, label] of [
    ['affix', 'Add prefix or suffix'],
    ['sequence', 'Sequential numbering'],
  ]) {
    const option = node('option', '', label);
    option.value = value;
    mode.append(option);
  }
  const prefix = input();
  const suffix = input();
  const base = input();
  const start = input('1', 'number');
  start.min = '0';
  start.step = '1';
  const digits = input('3', 'number');
  digits.min = '1';
  digits.max = '12';
  digits.step = '1';
  const affix = node('div', 'row g-3');
  const sequence = node('div', 'row g-3');
  for (const [container, label, control, size] of [
    [affix, 'Prefix', prefix, 'col-sm-6'],
    [affix, 'Suffix', suffix, 'col-sm-6'],
    [sequence, 'Base name', base, 'col-sm-6'],
    [sequence, 'Start at', start, 'col-sm-3'],
    [sequence, 'Digits', digits, 'col-sm-3'],
  ]) {
    const column = node('div', size);
    column.append(field(label, control));
    container.append(column);
  }
  sequence.hidden = true;
  const table = node('div');
  const apply = node('button', 'btn btn-primary', 'Rename');
  apply.type = 'button';
  apply.disabled = true;
  view.body.append(
    field('Naming', mode),
    affix,
    sequence,
    node(
      'p',
      'small text-muted mt-2 mb-0',
      'Extensions are preserved. Files are numbered in folder and name order.'
    ),
    table
  );
  view.footer.append(apply);
  let generation = 0;
  let timer;
  let plan;
  let options;
  let busy = false;
  async function preview() {
    const ticket = ++generation;
    plan = null;
    apply.disabled = true;
    view.status.textContent = 'Checking names...';
    const selected = {
      mode: mode.value,
      prefix: prefix.value,
      suffix: suffix.value,
      base: base.value,
      start: Number(start.value),
      digits: Number(digits.value),
    };
    try {
      const result = await post('/api/files/bulk-rename', { items, options: selected });
      if (ticket !== generation || !view.host.isConnected) return;
      plan = result;
      options = selected;
      table.replaceChildren(previewTable(result.rows));
      view.status.textContent = result.valid
        ? `${result.changed} files will be renamed`
        : result.changed
          ? 'Resolve the highlighted conflicts.'
          : 'Enter a prefix, suffix or base name.';
      apply.disabled = !result.valid || busy;
    } catch (error) {
      if (ticket !== generation) return;
      table.replaceChildren();
      view.status.textContent = error.message;
    }
  }
  function schedule() {
    ++generation;
    apply.disabled = true;
    clearTimeout(timer);
    affix.hidden = mode.value !== 'affix';
    sequence.hidden = mode.value !== 'sequence';
    timer = setTimeout(preview, 250);
  }
  for (const control of [mode, prefix, suffix, base, start, digits]) {
    control.addEventListener('input', schedule);
  }
  view.host.addEventListener('hidden.bs.modal', () => {
    ++generation;
    clearTimeout(timer);
  });
  apply.addEventListener('click', async () => {
    if (!plan?.valid || busy) return;
    busy = true;
    view.busy(true);
    apply.disabled = true;
    for (const control of [mode, prefix, suffix, base, start, digits]) control.disabled = true;
    view.status.textContent = 'Renaming files...';
    try {
      const result = await post('/api/files/bulk-rename', {
        action: 'apply',
        items,
        options,
        token: plan.token,
      });
      await refresh(result.rows.map((row) => row.new));
      showToast(`${result.renamed} files renamed. Original names are available in Rename history.`);
      view.busy(false);
      view.close();
    } catch (error) {
      view.status.textContent = error.message;
      await refresh();
    } finally {
      busy = false;
      view.busy(false);
      for (const control of [mode, prefix, suffix, base, start, digits]) control.disabled = false;
      plan = null;
    }
  });
  preview();
}

export async function openRenameHistory() {
  const view = dialog('Rename history');
  const select = node('select', 'form-select mt-1');
  const table = node('div');
  const restore = node('button', 'btn btn-primary', 'Restore names');
  restore.type = 'button';
  restore.disabled = true;
  view.body.append(field('Rename operation', select), table);
  view.footer.append(restore);
  view.status.textContent = 'Loading...';
  let batches = [];
  function choose() {
    const selected = batches.find((batch) => batch.id === select.value);
    table.replaceChildren(...(selected ? [previewTable(selected.rows, true)] : []));
    restore.disabled = !selected;
    view.status.textContent =
      selected?.status === 'applied'
        ? 'Changed files and occupied names are protected.'
        : selected
          ? 'Interrupted rename. Restore the original names.'
          : 'No renames to restore.';
  }
  try {
    const data = await requestJson('/api/files/rename-history');
    if (!view.host.isConnected) return;
    batches = data.batches;
    for (const batch of batches) {
      const date = new Date(batch.created_at).toLocaleString();
      const option = node(
        'option',
        '',
        `${date} - ${batch.rows.length} files${batch.status === 'applied' ? '' : ' - Interrupted'}`
      );
      option.value = batch.id;
      select.append(option);
    }
    select.disabled = !batches.length;
    choose();
  } catch (error) {
    view.status.textContent = error.message;
  }
  select.addEventListener('change', choose);
  restore.addEventListener('click', async () => {
    view.busy(true);
    restore.disabled = true;
    select.disabled = true;
    view.status.textContent = 'Restoring names...';
    try {
      const result = await post('/api/files/rename-history', { id: select.value });
      await refresh(result.rows.map((row) => row.old));
      showToast(`${result.restored} original names restored.`);
      view.busy(false);
      view.close();
    } catch (error) {
      view.status.textContent = error.message;
      await refresh();
    } finally {
      view.busy(false);
      restore.disabled = false;
      select.disabled = false;
    }
  });
}

export async function duplicateFiles(items) {
  const view = dialog('Duplicate files');
  view.busy(true);
  view.body.append(
    node('p', 'mb-0', `Creating ${items.length} ${items.length === 1 ? 'copy' : 'copies'}...`)
  );
  try {
    const data = await post('/api/files/duplicate', { items });
    const copied = data.results.filter((row) => row.status === 'copied');
    const failed = data.results.filter((row) => row.status === 'failed');
    await refresh(copied.map((row) => row.destination));
    if (failed.length) {
      view.body.replaceChildren(
        node('p', '', `${copied.length} created, ${failed.length} failed.`)
      );
      for (const row of failed)
        view.body.append(node('p', 'small text-break', `${row.path}: ${row.error}`));
    } else {
      showToast(`${copied.length} ${copied.length === 1 ? 'copy' : 'copies'} created.`);
      view.busy(false);
      view.close();
    }
  } catch (error) {
    view.status.textContent = error.message;
    await refresh();
  } finally {
    view.busy(false);
  }
}
