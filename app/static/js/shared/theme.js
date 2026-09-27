/**
 * Theme initialisation utilities responsible for toggling between
 * the light and dark colour schemes across the application.
 */
import { state, persistPreferences } from './state.js';

/**
 * Bind the theme toggle to the stored preference and reflect the
 * current state in the DOM so that the UI loads with the right scheme.
 */
const SUPPORTED_THEMES = new Set(['light', 'dark', 'light+', 'dark+']);
const DARK_THEMES = new Set(['dark', 'dark+']);

function coerceTheme(value) {
  if (SUPPORTED_THEMES.has(value)) return value;
  return 'light';
}

function themeLabel(theme) {
  switch (theme) {
    case 'dark':
      return 'Dark';
    case 'light+':
      return 'Light+';
    case 'dark+':
      return 'Dark+';
    default:
      return 'Light';
  }
}

/**
 * Apply the requested theme to the document and persist the preference.
 *
 * @param {('light'|'dark'|'light+'|'dark+')} theme - The theme to apply to the interface.
 */
export function applyTheme(theme) {
  const next = coerceTheme(theme);
  state.theme = next;
  const bsTheme = DARK_THEMES.has(next) ? 'dark' : 'light';
  document.documentElement.setAttribute('data-bs-theme', bsTheme);
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = bsTheme;
  if (document.body) {
    document.body.dataset.theme = next;
    document.body.setAttribute('data-bs-theme', bsTheme);
    document.body.style.colorScheme = bsTheme;
  }
  const toggle = document.getElementById('theme-toggle');
  const label = document.getElementById('theme-toggle-label');
  if (toggle) {
    const isDark = DARK_THEMES.has(next);
    toggle.checked = isDark;
    toggle.setAttribute('aria-checked', isDark ? 'true' : 'false');
  }
  if (label) {
    label.textContent = themeLabel(next);
  }
  persistPreferences();
  document.dispatchEvent(new CustomEvent('qualifile:theme-change', { detail: { theme: next } }));
}

/**
 * Bind the theme toggle to the stored preference and reflect the
 * current state in the DOM so that the UI loads with the right scheme.
 */
export function initTheme() {
  applyTheme(state.theme);
  const toggle = document.getElementById('theme-toggle');
  if (!toggle) return;
  toggle.checked = DARK_THEMES.has(state.theme);
  toggle.addEventListener('change', () => {
    const wantsDark = toggle.checked;
    const next = wantsDark
      ? state.theme === 'light+'
        ? 'dark+'
        : 'dark'
      : state.theme === 'dark+'
        ? 'light+'
        : 'light';
    applyTheme(next);
  });
}
