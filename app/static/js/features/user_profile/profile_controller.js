import { hydratePortablePreferences } from './preference_hydration.js';

const PROFILE_CHANGE_EVENT = 'qualifile:profile-change';
const ENABLED_MODE = 'on';

let initialized = false;

function getProfileMode() {
  const root = document.documentElement;
  const raw = root?.dataset?.profileMode || document.body?.dataset?.profileMode || '';
  return String(raw || '')
    .trim()
    .toLowerCase();
}

function handleProfileChange(detail) {
  if (!detail || typeof detail !== 'object') {
    return;
  }
  const portable = detail.portable_preferences;
  if (!portable || typeof portable !== 'object') {
    return;
  }
  hydratePortablePreferences(portable);
}

export function dispatchProfileChange(payload) {
  if (typeof document === 'undefined' || !payload || typeof payload !== 'object') {
    return;
  }
  document.dispatchEvent(new CustomEvent(PROFILE_CHANGE_EVENT, { detail: payload }));
}

export function initProfileController() {
  if (initialized) return;
  initialized = true;
  if (getProfileMode() !== ENABLED_MODE) {
    return;
  }
  document.addEventListener(PROFILE_CHANGE_EVENT, (event) => {
    handleProfileChange(event.detail);
  });
}
