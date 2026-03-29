import {
    acknowledgeTaskAlerts,
    dismissTaskAlert,
    fetchTaskAlertsSummary,
    requestJson,
    snoozeTaskAlert,
} from '../../shared/api.js';
import {
    GROUP_DEFINITIONS,
    STATE_LABELS,
    buildMetaLine,
    buildOpenTaskUrl,
    normalizeAlerts,
} from './alerts_shared.js';

const PAGE_LIMIT = 500;

function createSnoozeMenu(item) {
    const wrap = document.createElement('div');
    wrap.className = 'btn-group btn-group-sm dropdown position-relative';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-outline-secondary dropdown-toggle';
    toggle.dataset.bsToggle = 'dropdown';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = 'Snooze';

    const menu = document.createElement('ul');
    menu.className = 'dropdown-menu dropdown-menu-end';

    const options = [
        { preset: '1h', label: '1 hour' },
        { preset: '4h', label: '4 hours' },
        { preset: 'tomorrow_0800', label: 'Tomorrow 08:00' },
    ];

    for (const option of options) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dropdown-item';
        button.dataset.alertAction = 'snooze';
        button.dataset.alertTaskId = item.task_id;
        button.dataset.alertPreset = option.preset;
        button.textContent = option.label;
        li.appendChild(button);
        menu.appendChild(li);
    }

    if (item.is_snoozed) {
        const divider = document.createElement('li');
        divider.innerHTML = '<hr class="dropdown-divider">';
        menu.appendChild(divider);

        const clearRow = document.createElement('li');
        const clearButton = document.createElement('button');
        clearButton.type = 'button';
        clearButton.className = 'dropdown-item';
        clearButton.dataset.alertAction = 'snooze';
        clearButton.dataset.alertTaskId = item.task_id;
        clearButton.dataset.alertPreset = 'clear';
        clearButton.textContent = 'Clear snooze';
        clearRow.appendChild(clearButton);
        menu.appendChild(clearRow);
    }

    wrap.append(toggle, menu);
    return wrap;
}

function renderPageItem(item) {
    const article = document.createElement('article');
    article.className = 'task-alerts-page-item border rounded p-3';
    article.dataset.alertTaskId = item.task_id;

    const topRow = document.createElement('div');
    topRow.className = 'd-flex align-items-start justify-content-between gap-2 flex-wrap';

    const title = document.createElement('h3');
    title.className = 'h6 mb-1 task-alerts-page-item-title';
    title.textContent = item.title;

    const state = document.createElement('span');
    state.className = `task-alerts-item-state badge rounded-pill text-bg-light border state-${item.state}`;
    state.textContent = STATE_LABELS[item.state] || 'Active';

    const meta = document.createElement('p');
    meta.className = 'small text-muted mb-2';
    meta.textContent = buildMetaLine(item);

    const actions = document.createElement('div');
    actions.className = 'task-alerts-page-item-actions d-flex flex-wrap gap-2';

    const openTask = document.createElement('a');
    openTask.className = 'btn btn-outline-primary btn-sm';
    openTask.href = buildOpenTaskUrl(item);
    openTask.textContent = 'Open task';

    const markCompleted = document.createElement('button');
    markCompleted.type = 'button';
    markCompleted.className = 'btn btn-outline-success btn-sm';
    markCompleted.dataset.alertAction = 'complete';
    markCompleted.dataset.alertTaskId = item.task_id;
    markCompleted.textContent = 'Mark completed';

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'btn btn-outline-secondary btn-sm';
    dismiss.dataset.alertAction = 'dismiss';
    dismiss.dataset.alertTaskId = item.task_id;
    dismiss.dataset.alertDismissed = item.dismissed ? 'false' : 'true';
    dismiss.textContent = item.dismissed ? 'Undismiss' : 'Dismiss';

    actions.append(openTask, markCompleted, createSnoozeMenu(item), dismiss);

    topRow.append(title, state);
    article.append(topRow, meta, actions);
    return article;
}

function renderGroup(container, group, items) {
    const section = document.createElement('section');
    section.className = 'task-alerts-page-group mb-3';
    section.dataset.alertGroup = group.id;

    const heading = document.createElement('h2');
    heading.className = 'h6 text-uppercase text-muted mb-2';
    heading.textContent = group.title;

    const list = document.createElement('div');
    list.className = 'task-alerts-page-group-list d-flex flex-column gap-2';
    items.forEach((item) => list.appendChild(renderPageItem(item)));

    section.append(heading, list);
    container.appendChild(section);
}

export function initTaskAlertsPage() {
    const root = document.getElementById('task-alerts-page-root');
    const loadingElement = document.getElementById('alerts-page-loading');
    const errorElement = document.getElementById('alerts-page-error');
    const emptyElement = document.getElementById('alerts-page-empty');
    const listElement = document.getElementById('alerts-page-list');
    const refreshButton = document.getElementById('alerts-page-refresh');

    if (!root || !loadingElement || !errorElement || !emptyElement || !listElement || !refreshButton) {
        return null;
    }

    const itemsByTaskId = new Map();
    let inflight = null;

    const showLoading = (isLoading) => {
        loadingElement.classList.toggle('d-none', !isLoading);
    };

    const showError = (message) => {
        errorElement.textContent = message || 'Unable to load alerts.';
        errorElement.classList.remove('d-none');
    };

    const clearError = () => {
        errorElement.textContent = '';
        errorElement.classList.add('d-none');
    };

    const render = (summary) => {
        clearError();
        listElement.replaceChildren();
        itemsByTaskId.clear();

        const alerts = normalizeAlerts(summary);
        alerts.forEach((item) => itemsByTaskId.set(item.task_id, item));

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

    const refresh = async ({ acknowledge = false } = {}) => {
        if (inflight) {
            await inflight;
            return;
        }

        showLoading(true);
        inflight = (acknowledge
            ? acknowledgeTaskAlerts({ limit: PAGE_LIMIT })
            : fetchTaskAlertsSummary({ limit: PAGE_LIMIT }))
            .then((summary) => {
                render(summary);
                document.dispatchEvent(new CustomEvent('qualifile:task-alerts-refresh'));
            })
            .catch((error) => {
                showError(error?.message || 'Unable to load alerts.');
                listElement.classList.add('d-none');
                emptyElement.classList.add('d-none');
            })
            .finally(() => {
                inflight = null;
                showLoading(false);
            });

        await inflight;
    };

    const markTaskCompleted = async (item) => {
        if (!item?.project_id || !item?.task_id) {
            throw new Error('Task identifiers are missing.');
        }
        await requestJson(`/api/projects/${encodeURIComponent(item.project_id)}/entries/${encodeURIComponent(item.task_id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ type: 'task', status: 'closed' }),
        });
        await refresh();
    };

    const onActionClick = async (event) => {
        const trigger = event.target.closest('[data-alert-action]');
        if (!trigger) return;
        event.preventDefault();

        const action = trigger.dataset.alertAction;
        const taskId = trigger.dataset.alertTaskId;
        const item = itemsByTaskId.get(taskId || '');
        if (!item) return;

        try {
            if (action === 'complete') {
                await markTaskCompleted(item);
                return;
            }
            if (action === 'dismiss') {
                const dismissed = trigger.dataset.alertDismissed === 'true';
                const summary = await dismissTaskAlert(taskId, { dismissed, limit: PAGE_LIMIT });
                render(summary);
                document.dispatchEvent(new CustomEvent('qualifile:task-alerts-refresh'));
                return;
            }
            if (action === 'snooze') {
                const preset = trigger.dataset.alertPreset || '';
                const summary = await snoozeTaskAlert(taskId, { preset, limit: PAGE_LIMIT });
                render(summary);
                document.dispatchEvent(new CustomEvent('qualifile:task-alerts-refresh'));
            }
        } catch (error) {
            showError(error?.message || 'Unable to update alert.');
        }
    };

    refreshButton.addEventListener('click', () => {
        void refresh();
    });
    listElement.addEventListener('click', (event) => {
        void onActionClick(event);
    });

    void refresh({ acknowledge: true });

    return {
        refresh,
    };
}
