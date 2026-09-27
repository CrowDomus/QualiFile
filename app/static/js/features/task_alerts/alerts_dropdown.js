import {
  GROUP_DEFINITIONS,
  STATE_LABELS,
  buildMetaLine,
  normalizeAlerts,
} from './alerts_shared.js';

function renderAlertItem(item) {
  const article = document.createElement('article');
  article.className = 'task-alerts-item px-3 py-2';
  article.dataset.alertTaskId = item.task_id;

  const topRow = document.createElement('div');
  topRow.className = 'task-alerts-item-top d-flex align-items-start justify-content-between gap-2';

  const title = document.createElement('div');
  title.className = 'task-alerts-item-title';
  title.textContent = item.title;

  const state = document.createElement('span');
  state.className = `task-alerts-item-state badge rounded-pill text-bg-light border state-${item.state}`;
  state.textContent = STATE_LABELS[item.state] || 'Active';

  const meta = document.createElement('div');
  meta.className = 'task-alerts-item-meta text-muted';
  meta.textContent = buildMetaLine(item);

  topRow.append(title, state);
  article.append(topRow, meta);
  return article;
}

function renderGroup(container, group, items) {
  const section = document.createElement('section');
  section.className = 'task-alerts-group';
  section.dataset.alertGroup = group.id;

  const heading = document.createElement('h3');
  heading.className = 'task-alerts-group-title px-3 pt-2 pb-1';
  heading.textContent = group.title;

  section.appendChild(heading);
  items.forEach((item) => section.appendChild(renderAlertItem(item)));
  container.appendChild(section);
}

export function createTaskAlertsDropdownController({ listElement, emptyElement } = {}) {
  const hasElements = () => !!(listElement && emptyElement);

  const render = (summary) => {
    if (!hasElements()) return;
    const alerts = normalizeAlerts(summary);
    listElement.replaceChildren();

    if (!alerts.length) {
      listElement.classList.add('d-none');
      emptyElement.classList.remove('d-none');
      return;
    }

    emptyElement.classList.add('d-none');
    listElement.classList.remove('d-none');
    for (const group of GROUP_DEFINITIONS) {
      const groupItems = alerts.filter(group.include);
      if (!groupItems.length) continue;
      renderGroup(listElement, group, groupItems);
    }
  };

  const showError = (message) => {
    if (!hasElements()) return;
    emptyElement.textContent = message || 'Unable to load alerts.';
    emptyElement.classList.remove('d-none');
    listElement.classList.add('d-none');
  };

  const setIdleEmptyMessage = () => {
    if (!hasElements()) return;
    emptyElement.textContent = 'No active alerts.';
  };

  return {
    render,
    setIdleEmptyMessage,
    showError,
  };
}
