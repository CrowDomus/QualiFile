const AVATAR_ENDPOINT = '/api/profile/avatar';
const ENABLED_MODE = 'on';

export function getProfileAvatarMode() {
  const root = document.documentElement;
  const raw = root?.dataset?.profileAvatarMode || document.body?.dataset?.profileAvatarMode || '';
  return String(raw || '')
    .trim()
    .toLowerCase();
}

export function deriveInitial(value) {
  if (!value) return '?';
  const trimmed = String(value).trim();
  if (!trimmed) return '?';
  return trimmed[0].toUpperCase();
}

function buildAvatarUrl(avatarRef) {
  const encoded = encodeURIComponent(String(avatarRef));
  return `${AVATAR_ENDPOINT}/${encoded}`;
}

export function applyAvatarDisplay(element, profile, options = {}) {
  if (!element) return;
  const label = options.label || profile?.display_name || profile?.email || '';
  const avatarRef = profile?.avatar || profile?.avatar_ref;
  if (element instanceof HTMLImageElement) {
    const fallback = element.dataset.avatarDefault || element.getAttribute('src') || '';
    element.alt = label ? `Avatar for ${label}` : 'Profile avatar';
    element.dataset.avatarImage = 'false';
    if (getProfileAvatarMode() !== ENABLED_MODE || !avatarRef) {
      if (fallback) {
        element.src = fallback;
      }
      return;
    }
    const url = buildAvatarUrl(avatarRef);
    element.dataset.avatarImage = 'true';
    element.src = url;
    element.onerror = () => {
      element.dataset.avatarImage = 'false';
      if (fallback) {
        element.src = fallback;
      }
    };
    return;
  }
  const initial = deriveInitial(label);
  element.textContent = initial;
  element.dataset.avatarImage = 'false';
  element.style.backgroundImage = '';
  if (getProfileAvatarMode() !== ENABLED_MODE || !avatarRef) {
    return;
  }
  const url = buildAvatarUrl(avatarRef);
  const img = new Image();
  img.onload = () => {
    element.style.backgroundImage = `url("${url}")`;
    element.dataset.avatarImage = 'true';
    element.textContent = '';
  };
  img.onerror = () => {
    element.style.backgroundImage = '';
    element.dataset.avatarImage = 'false';
    element.textContent = initial;
  };
  img.src = url;
}
