import { warnDiagnostic } from '../../shared/diagnostics.js';

const STORAGE_KEY = 'qualifile-preferences';

function loadLocalPreferences() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    warnDiagnostic('ProfilePreferencesCacheLoadFailure', error);
    return {};
  }
}

function saveLocalPreferences(payload) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    warnDiagnostic('ProfilePreferencesCachePersistFailure', error);
  }
}

export function mergePortablePreferences(portable) {
  if (!portable || typeof portable !== 'object') {
    return;
  }
  const current = loadLocalPreferences();
  const merged = { ...current };
  for (const [key, value] of Object.entries(portable)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const base =
        current && typeof current[key] === 'object' && !Array.isArray(current[key])
          ? current[key]
          : {};
      merged[key] = { ...base, ...value };
    } else {
      merged[key] = value;
    }
  }
  saveLocalPreferences(merged);
}
