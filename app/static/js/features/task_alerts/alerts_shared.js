const VALID_STATES = new Set(['new', 'active', 'snoozed', 'dismissed']);

export const STATE_LABELS = {
    active: 'Active',
    new: 'New',
    snoozed: 'Snoozed',
    dismissed: 'Dismissed',
};

export const GROUP_DEFINITIONS = [
    { id: 'new', title: 'New', include: (item) => item.state === 'new' },
    { id: 'active', title: 'Active', include: (item) => item.state === 'active' },
    { id: 'snoozed', title: 'Snoozed', include: (item) => item.state === 'snoozed' },
    { id: 'dismissed', title: 'Dismissed', include: (item) => item.state === 'dismissed' },
];

export function reminderSummary(item) {
    if (item?.reminder_mode === 'days_before_end_date') {
        const days = Number(item?.reminder_days_before);
        if (Number.isInteger(days) && days > 0) {
            return `${days} days before end date`;
        }
    }
    return 'On end date';
}

export function buildMetaLine(item) {
    const parts = [];
    if (item?.end_date) {
        parts.push(`End ${item.end_date}`);
    } else {
        parts.push('No end date');
    }
    parts.push(reminderSummary(item));
    return parts.join(' | ');
}

function normalizeState(value) {
    const candidate = String(value || '').trim().toLowerCase();
    if (VALID_STATES.has(candidate)) {
        return candidate;
    }
    return 'active';
}

export function normalizeAlerts(summary) {
    const raw = Array.isArray(summary?.alerts) ? summary.alerts : [];
    return raw
        .map((item) => ({
            task_id: item?.task_id ? String(item.task_id) : '',
            project_id: item?.project_id ? String(item.project_id) : '',
            title: String(item?.title || '(Untitled task)'),
            end_date: item?.end_date ? String(item.end_date) : null,
            reminder_mode: item?.reminder_mode ? String(item.reminder_mode) : 'on_end_date',
            reminder_days_before: Number.isInteger(item?.reminder_days_before) ? item.reminder_days_before : null,
            state: normalizeState(item?.state),
            dismissed: Boolean(item?.dismissed),
            is_snoozed: Boolean(item?.is_snoozed),
        }))
        .filter((item) => item.task_id);
}

export function buildOpenTaskUrl(item) {
    const taskId = item?.task_id ? String(item.task_id) : '';
    if (!taskId) return '/projects';
    const params = new URLSearchParams();
    if (item?.project_id) {
        params.set('project', String(item.project_id));
    }
    params.set('task', taskId);
    return `/projects?${params.toString()}`;
}
