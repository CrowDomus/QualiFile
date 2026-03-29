export function initTimelineHeaderControls(options = {}) {
    const {
        columnCheckboxes = {},
        settingsToggles = {},
        initialPrefs = {},
        onChange = null,
    } = options;

    const prefs = {
        visibleColumns: {
            project: true,
            start: true,
            end: true,
            duration: true,
            ...(initialPrefs.visibleColumns || {}),
        },
        showBarLabels: !!initialPrefs.showBarLabels,
        highlightRows: !!initialPrefs.highlightRows,
    };

    const emitChange = () => {
        if (typeof onChange === 'function') {
            onChange({
                visibleColumns: { ...prefs.visibleColumns },
                showBarLabels: prefs.showBarLabels,
                highlightRows: prefs.highlightRows,
            });
        }
    };

    const setCheckboxState = (box, checked) => {
        if (!box) return;
        box.checked = !!checked;
    };

    const syncUI = () => {
        setCheckboxState(columnCheckboxes.project, prefs.visibleColumns.project);
        setCheckboxState(columnCheckboxes.start, prefs.visibleColumns.start);
        setCheckboxState(columnCheckboxes.end, prefs.visibleColumns.end);
        setCheckboxState(columnCheckboxes.duration, prefs.visibleColumns.duration);
        setCheckboxState(settingsToggles.showBarLabels, prefs.showBarLabels);
        setCheckboxState(settingsToggles.highlightRows, prefs.highlightRows);
    };

    const bindColumn = (key, input) => {
        if (!input) return;
        input.addEventListener('change', () => {
            prefs.visibleColumns[key] = !!input.checked;
            emitChange();
        });
    };

    const bindToggle = (key, input) => {
        if (!input) return;
        input.addEventListener('change', () => {
            prefs[key] = !!input.checked;
            emitChange();
        });
    };

    bindColumn('project', columnCheckboxes.project);
    bindColumn('start', columnCheckboxes.start);
    bindColumn('end', columnCheckboxes.end);
    bindColumn('duration', columnCheckboxes.duration);
    bindToggle('showBarLabels', settingsToggles.showBarLabels);
    bindToggle('highlightRows', settingsToggles.highlightRows);

    syncUI();
    emitChange();

    return {
        update(nextPrefs = {}) {
            if (nextPrefs.visibleColumns) {
                prefs.visibleColumns = { ...prefs.visibleColumns, ...nextPrefs.visibleColumns };
            }
            if (typeof nextPrefs.showBarLabels === 'boolean') {
                prefs.showBarLabels = nextPrefs.showBarLabels;
            }
            if (typeof nextPrefs.highlightRows === 'boolean') {
                prefs.highlightRows = nextPrefs.highlightRows;
            }
            syncUI();
        },
    };
}
