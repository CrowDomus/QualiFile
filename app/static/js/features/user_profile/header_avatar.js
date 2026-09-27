import { requestJson } from '../../shared/api.js';
import { applyAvatarDisplay } from './avatar_display.js';
import { warnDiagnostic } from '../../shared/diagnostics.js';

const PROFILE_ENDPOINT = '/api/profile';
const ENABLED_MODE = 'on';

function getProfileMode() {
  const root = document.documentElement;
  const raw = root?.dataset?.profileMode || document.body?.dataset?.profileMode || '';
  return String(raw || '')
    .trim()
    .toLowerCase();
}

export async function initProfileHeaderAvatar() {
  const slot = document.querySelector('[data-profile-avatar-slot]');
  if (!slot) return;
  const mode = getProfileMode();
  const button = slot.querySelector('[data-profile-avatar-button]');
  const avatarEl = slot.querySelector('[data-profile-avatar-image]');
  if (mode !== ENABLED_MODE) {
    if (avatarEl) {
      applyAvatarDisplay(avatarEl, null, { label: 'Profile' });
    }
    if (button) {
      button.setAttribute('aria-label', 'Profile (disabled)');
      button.setAttribute('title', 'Profile (disabled)');
    }
    slot.hidden = false;
    return;
  }
  let profile = null;
  try {
    const response = await requestJson(PROFILE_ENDPOINT);
    profile = response?.profile || null;
  } catch (error) {
    warnDiagnostic('ProfileHeaderAvatarLoadFailure', error);
  }
  const displayName = profile?.display_name || profile?.email || 'Guest';
  if (avatarEl) {
    applyAvatarDisplay(avatarEl, profile, { label: displayName });
  }
  if (button) {
    const label = displayName ? `Profile: ${displayName}` : 'Profile';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  }
  slot.hidden = false;
}
