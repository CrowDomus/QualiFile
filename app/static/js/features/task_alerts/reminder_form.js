const REMINDER_MODE_ON_END_DATE = 'on_end_date';
const REMINDER_MODE_DAYS_BEFORE_END_DATE = 'days_before_end_date';
const MIN_DAYS_BEFORE = 1;
const MAX_DAYS_BEFORE = 365;

const REMINDER_REQUIRES_END_DATE_MESSAGE = 'Add an end date to use reminders.';
const REMINDER_DISABLED_MISSING_END_DATE_MESSAGE = 'Reminder disabled because end date was removed.';
const REMINDER_DAYS_REQUIRED_MESSAGE = 'Reminder days before is required for days-before reminders.';
const REMINDER_DAYS_INVALID_MESSAGE = 'Reminder days before must be an integer between 1 and 365.';
const ACTIVE_ALERT_CHOICE_REQUIRED_CODE = 'active-alert-disable-choice-required';
const DISABLE_ACTIVE_ALERT_ACTION_KEEP = 'disable_future_only';
const DISABLE_ACTIVE_ALERT_ACTION_CLEAR = 'disable_and_clear_active';
const ACTIVE_ALERT_DISABLE_PROMPT_MESSAGE = [
    'This task currently has an active alert.',
    'Select OK to disable reminders and clear this active alert now.',
    'Select Cancel to disable future reminders only and keep the active alert until the task is closed.',
].join('\n\n');

function normalizeMode(value) {
    return value === REMINDER_MODE_DAYS_BEFORE_END_DATE
        ? REMINDER_MODE_DAYS_BEFORE_END_DATE
        : REMINDER_MODE_ON_END_DATE;
}

function parseDaysBefore(value) {
    if (typeof value === 'number' && Number.isInteger(value)) {
        return value;
    }
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (!/^\d+$/.test(raw)) return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed)) return null;
    return parsed;
}

export function createTaskReminderFormController({
    container,
    enabledInput,
    modeSelect,
    daysWrap,
    daysInput,
    endDateInput,
    showAlert,
} = {}) {
    let initialized = false;
    let reminderWasEnabledOnOpen = false;
    let pendingDisableNotice = false;

    const hasRequiredElements = () => !!(container && enabledInput && modeSelect && daysWrap && daysInput && endDateInput);

    const hasEndDate = () => Boolean(String(endDateInput?.value ?? '').trim());

    const currentMode = () => normalizeMode(modeSelect?.value);

    const clearDaysField = () => {
        if (daysInput) {
            daysInput.value = '';
            daysInput.classList.remove('is-invalid');
        }
    };

    const setDaysFieldVisible = (visible) => {
        daysWrap?.classList.toggle('d-none', !visible);
    };

    const syncControls = () => {
        if (!hasRequiredElements()) return;
        const enabled = Boolean(enabledInput.checked);
        const mode = currentMode();
        modeSelect.disabled = !enabled;
        const showDays = enabled && mode === REMINDER_MODE_DAYS_BEFORE_END_DATE;
        setDaysFieldVisible(showDays);
        daysInput.disabled = !showDays;
        if (!showDays) {
            clearDaysField();
        }
    };

    const disableReminderDueToMissingEndDate = () => {
        if (!hasRequiredElements()) return;
        if (!enabledInput.checked) return;
        enabledInput.checked = false;
        pendingDisableNotice = reminderWasEnabledOnOpen;
        syncControls();
    };

    const handleReminderEnabledChange = () => {
        if (!hasRequiredElements()) return;
        if (enabledInput.checked && !hasEndDate()) {
            enabledInput.checked = false;
            showAlert?.(REMINDER_REQUIRES_END_DATE_MESSAGE, true);
        }
        if (enabledInput.checked) {
            pendingDisableNotice = false;
        }
        syncControls();
    };

    const handleReminderModeChange = () => {
        syncControls();
    };

    const handleEndDateChange = () => {
        if (!hasRequiredElements()) return;
        if (!hasEndDate()) {
            disableReminderDueToMissingEndDate();
            return;
        }
        pendingDisableNotice = false;
        syncControls();
    };

    const attach = () => {
        if (!hasRequiredElements() || initialized) return;
        initialized = true;
        enabledInput.addEventListener('change', handleReminderEnabledChange);
        modeSelect.addEventListener('change', handleReminderModeChange);
        endDateInput.addEventListener('change', handleEndDateChange);
        daysInput.addEventListener('input', () => {
            daysInput.classList.remove('is-invalid');
        });
    };

    const reset = () => {
        if (!hasRequiredElements()) return;
        reminderWasEnabledOnOpen = false;
        pendingDisableNotice = false;
        enabledInput.checked = false;
        modeSelect.value = REMINDER_MODE_ON_END_DATE;
        clearDaysField();
        syncControls();
    };

    const loadFromTask = (entry = null) => {
        if (!hasRequiredElements()) return;
        const reminderEnabled = Boolean(entry?.reminder_enabled);
        reminderWasEnabledOnOpen = reminderEnabled;
        pendingDisableNotice = false;
        enabledInput.checked = reminderEnabled;
        modeSelect.value = normalizeMode(entry?.reminder_mode);
        if (entry?.reminder_mode === REMINDER_MODE_DAYS_BEFORE_END_DATE && entry?.reminder_days_before != null) {
            daysInput.value = String(entry.reminder_days_before);
        } else {
            clearDaysField();
        }
        syncControls();
    };

    const syncMode = (entryMode) => {
        const isTaskMode = entryMode === 'task';
        container?.classList.toggle('d-none', !isTaskMode);
        if (!isTaskMode) {
            reset();
            return;
        }
        syncControls();
    };

    const buildPayload = ({ entryMode } = {}) => {
        if (!hasRequiredElements() || entryMode !== 'task') {
            return {
                ok: true,
                payload: {
                    reminder_enabled: false,
                    reminder_mode: REMINDER_MODE_ON_END_DATE,
                    reminder_days_before: null,
                },
                notice: null,
            };
        }

        const enabled = Boolean(enabledInput.checked);
        const mode = currentMode();
        let daysBefore = null;
        let notice = null;

        if (enabled && !hasEndDate()) {
            return { ok: false, error: REMINDER_REQUIRES_END_DATE_MESSAGE };
        }

        if (!enabled && pendingDisableNotice) {
            notice = REMINDER_DISABLED_MISSING_END_DATE_MESSAGE;
            pendingDisableNotice = false;
        }

        if (enabled && mode === REMINDER_MODE_DAYS_BEFORE_END_DATE) {
            const parsed = parseDaysBefore(daysInput.value);
            if (parsed == null) {
                daysInput.classList.add('is-invalid');
                return { ok: false, error: REMINDER_DAYS_REQUIRED_MESSAGE };
            }
            if (parsed < MIN_DAYS_BEFORE || parsed > MAX_DAYS_BEFORE) {
                daysInput.classList.add('is-invalid');
                return { ok: false, error: REMINDER_DAYS_INVALID_MESSAGE };
            }
            daysBefore = parsed;
        }

        return {
            ok: true,
            payload: {
                reminder_enabled: enabled,
                reminder_mode: mode,
                reminder_days_before: mode === REMINDER_MODE_DAYS_BEFORE_END_DATE ? daysBefore : null,
            },
            notice,
        };
    };

    return {
        attach,
        buildPayload,
        loadFromTask,
        reset,
        syncMode,
    };
}

export function isDisableChoiceRequiredError(error) {
    const code = String(error?.payload?.code || error?.code || '').trim().toLowerCase();
    return code === ACTIVE_ALERT_CHOICE_REQUIRED_CODE;
}

export async function chooseDisableActiveAlertAction({ confirmFn } = {}) {
    const ask = typeof confirmFn === 'function'
        ? confirmFn
        : (message) => Promise.resolve(window.confirm(message));
    const shouldClearActive = await ask(ACTIVE_ALERT_DISABLE_PROMPT_MESSAGE);
    return shouldClearActive
        ? DISABLE_ACTIVE_ALERT_ACTION_CLEAR
        : DISABLE_ACTIVE_ALERT_ACTION_KEEP;
}

export const TASK_REMINDER_COPY = {
    REMINDER_DISABLED_MISSING_END_DATE_MESSAGE,
    REMINDER_REQUIRES_END_DATE_MESSAGE,
};
