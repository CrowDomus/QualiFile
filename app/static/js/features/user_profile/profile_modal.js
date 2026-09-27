import { requestJson } from '../../shared/api.js';
import { setStatus, showToast } from '../../shared/ui.js';
import { initProfileHeaderAvatar } from './header_avatar.js';
import { applyAvatarDisplay, getProfileAvatarMode } from './avatar_display.js';
import { dispatchProfileChange } from './profile_controller.js';

const PROFILE_ENDPOINT = '/api/profile';
const EXPORT_ENDPOINT = '/api/profile/export';
const IMPORT_ENDPOINT = '/api/profile/import';
const DISCONNECT_ENDPOINT = '/api/profile/disconnect';
const AVATAR_ENDPOINT = '/api/profile/avatar';
const ENABLED_MODE = 'on';
const AVATAR_ENABLED_MODE = 'on';

let initialized = false;
let currentProfile = null;

function formatExportTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function getProfileMode() {
  const root = document.documentElement;
  const raw = root?.dataset?.profileMode || document.body?.dataset?.profileMode || '';
  return String(raw || '')
    .trim()
    .toLowerCase();
}

function updateToggleState(mode) {
  const enabled = mode === ENABLED_MODE;
  document.querySelectorAll('[data-profile-modal-toggle]').forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) return;
    button.disabled = false;
    button.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    button.dataset.profileDisabled = enabled ? 'false' : 'true';
  });
  document.querySelectorAll('[data-profile-settings-note]').forEach((note) => {
    note.hidden = enabled;
  });
}

function resolveElements(modal) {
  const form = modal.querySelector('#form-profile');
  const displayName = modal.querySelector('#profile-display-name');
  const displayNameFeedback = modal.querySelector('#profile-display-name-feedback');
  const email = modal.querySelector('#profile-email');
  const error = modal.querySelector('#profile-error');
  const avatarPreview = modal.querySelector('[data-profile-avatar-preview]');
  const avatarInput = modal.querySelector('#profile-avatar-upload');
  const avatarUploadButton = modal.querySelector('#profile-avatar-upload-btn');
  const avatarError = modal.querySelector('#profile-avatar-error');
  const avatarNote = modal.querySelector('[data-profile-avatar-note]');
  const exportButton = modal.querySelector('#profile-export');
  const importInput = modal.querySelector('#profile-import-file');
  const importButton = modal.querySelector('#profile-import-btn');
  const displayLabel = modal.querySelector('[data-profile-display-label]');
  const guestNote = modal.querySelector('[data-profile-guest-note]');
  const disconnectButton = modal.querySelector('#profile-disconnect');
  const saveButton = modal.querySelector('#profile-save');
  if (!form || !displayName || !email || !disconnectButton || !saveButton) {
    return null;
  }
  return {
    form,
    displayName,
    displayNameFeedback,
    email,
    error,
    avatarPreview,
    avatarInput,
    avatarUploadButton,
    avatarError,
    avatarNote,
    exportButton,
    importInput,
    importButton,
    displayLabel,
    guestNote,
    disconnectButton,
    saveButton,
  };
}

function clearErrors(elements) {
  if (elements.displayNameFeedback) {
    elements.displayNameFeedback.textContent = '';
  }
  elements.displayName.classList.remove('is-invalid');
  if (elements.error) {
    elements.error.textContent = '';
    elements.error.classList.add('d-none');
  }
  if (elements.avatarError) {
    elements.avatarError.textContent = '';
    elements.avatarError.classList.add('d-none');
  }
}

function updateAvatarControls(elements) {
  if (!elements.avatarInput && !elements.avatarUploadButton && !elements.avatarNote) {
    return;
  }
  const avatarEnabled = getProfileAvatarMode() === AVATAR_ENABLED_MODE;
  const hasProfile = Boolean(currentProfile);
  const canUpload = avatarEnabled && hasProfile;
  if (elements.avatarInput instanceof HTMLInputElement) {
    elements.avatarInput.disabled = !canUpload;
  }
  const hasFile =
    elements.avatarInput instanceof HTMLInputElement &&
    elements.avatarInput.files &&
    elements.avatarInput.files.length > 0;
  if (elements.avatarUploadButton instanceof HTMLButtonElement) {
    elements.avatarUploadButton.disabled = !canUpload || !hasFile;
    elements.avatarUploadButton.setAttribute(
      'aria-disabled',
      !canUpload || !hasFile ? 'true' : 'false'
    );
  }
  if (elements.avatarNote) {
    let note = 'PNG/JPEG/WEBP up to 2 MB.';
    if (!avatarEnabled) {
      note = 'Avatar uploads are disabled by configuration.';
    } else if (!hasProfile) {
      note = 'Create a profile to upload an avatar.';
    }
    elements.avatarNote.textContent = note;
    elements.avatarNote.classList.toggle('text-danger', !avatarEnabled);
  }
}

function updateImportControls(elements) {
  const input = elements.importInput;
  if (!(elements.importButton instanceof HTMLButtonElement)) {
    return;
  }
  const hasFile = input instanceof HTMLInputElement && input.files && input.files.length > 0;
  elements.importButton.disabled = !hasFile;
  elements.importButton.setAttribute('aria-disabled', hasFile ? 'false' : 'true');
}

function setProfileState(elements, profile) {
  currentProfile = profile || null;
  const displayName = profile?.display_name || '';
  const email = profile?.email || '';
  elements.displayName.value = displayName;
  elements.email.value = email;

  const labelText = displayName || email || 'Guest';
  if (elements.displayLabel) {
    elements.displayLabel.textContent = labelText;
  }
  if (elements.avatarPreview) {
    applyAvatarDisplay(elements.avatarPreview, profile, { label: labelText });
  }
  if (elements.guestNote) {
    elements.guestNote.textContent = profile
      ? 'Profile connected. Update your identity details below.'
      : 'Guest mode: create a profile to store portable preferences.';
  }
  const hasProfile = Boolean(profile);
  elements.disconnectButton.disabled = !hasProfile;
  elements.disconnectButton.classList.toggle('d-none', !hasProfile);
  elements.saveButton.textContent = hasProfile ? 'Save profile' : 'Create profile';
  if (elements.exportButton instanceof HTMLButtonElement) {
    elements.exportButton.disabled = !hasProfile;
    elements.exportButton.setAttribute('aria-disabled', hasProfile ? 'false' : 'true');
  }
  if (elements.avatarInput instanceof HTMLInputElement) {
    elements.avatarInput.value = '';
  }
  updateAvatarControls(elements);
  updateImportControls(elements);
}

async function loadProfile(elements) {
  try {
    setStatus('Loading profile...');
    const response = await requestJson(PROFILE_ENDPOINT);
    setProfileState(elements, response?.profile || null);
  } catch (error) {
    if (elements.error) {
      elements.error.textContent = error.message || 'Unable to load profile.';
      elements.error.classList.remove('d-none');
    }
    setProfileState(elements, null);
  } finally {
    setStatus('Saved/Idle');
  }
}

async function submitProfile(elements) {
  clearErrors(elements);
  const displayName = elements.displayName.value.trim();
  if (!displayName) {
    elements.displayName.classList.add('is-invalid');
    if (elements.displayNameFeedback) {
      elements.displayNameFeedback.textContent = 'Display name is required.';
    }
    return;
  }
  const emailText = elements.email.value.trim();
  const payload = {
    profile: {
      display_name: displayName,
      email: emailText ? emailText : null,
    },
  };
  const method = currentProfile ? 'PATCH' : 'PUT';
  try {
    setStatus('Saving profile...');
    const response = await requestJson(PROFILE_ENDPOINT, {
      method,
      body: JSON.stringify(payload),
    });
    setProfileState(elements, response?.profile || null);
    dispatchProfileChange(response);
    showToast('Profile saved');
    bootstrap.Modal.getInstance(elements.form.closest('.modal'))?.hide();
    void initProfileHeaderAvatar();
  } catch (error) {
    if (elements.error) {
      elements.error.textContent = error.message || 'Unable to save profile.';
      elements.error.classList.remove('d-none');
    }
  } finally {
    setStatus('Saved/Idle');
  }
}

async function uploadAvatar(elements) {
  if (getProfileAvatarMode() !== AVATAR_ENABLED_MODE) {
    return;
  }
  clearErrors(elements);
  if (!currentProfile) {
    if (elements.avatarError) {
      elements.avatarError.textContent = 'Create a profile before uploading an avatar.';
      elements.avatarError.classList.remove('d-none');
    }
    return;
  }
  const input = elements.avatarInput;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const file = input.files && input.files[0];
  if (!file) {
    if (elements.avatarError) {
      elements.avatarError.textContent = 'Select an image file to upload.';
      elements.avatarError.classList.remove('d-none');
    }
    return;
  }
  const form = new FormData();
  form.append('avatar', file, file.name || 'avatar');
  try {
    setStatus('Uploading avatar...');
    const response = await requestJson(AVATAR_ENDPOINT, { method: 'POST', body: form });
    setProfileState(elements, response?.profile || null);
    dispatchProfileChange(response);
    showToast('Avatar updated');
    void initProfileHeaderAvatar();
  } catch (error) {
    if (elements.avatarError) {
      elements.avatarError.textContent = error.message || 'Unable to upload avatar.';
      elements.avatarError.classList.remove('d-none');
    }
  } finally {
    setStatus('Saved/Idle');
    if (input) {
      input.value = '';
    }
    updateAvatarControls(elements);
  }
}

async function disconnectProfile(elements) {
  if (!currentProfile) {
    return;
  }
  clearErrors(elements);
  try {
    setStatus('Disconnecting...');
    const response = await requestJson(DISCONNECT_ENDPOINT, { method: 'POST' });
    setProfileState(elements, null);
    dispatchProfileChange(response);
    showToast('Profile disconnected');
    bootstrap.Modal.getInstance(elements.form.closest('.modal'))?.hide();
    void initProfileHeaderAvatar();
  } catch (error) {
    if (elements.error) {
      elements.error.textContent = error.message || 'Unable to disconnect profile.';
      elements.error.classList.remove('d-none');
    }
  } finally {
    setStatus('Saved/Idle');
  }
}

async function exportProfile(elements) {
  if (!currentProfile) {
    showToast('Create a profile before exporting.', true);
    return;
  }
  try {
    setStatus('Exporting profile...');
    const payload = await requestJson(EXPORT_ENDPOINT);
    const timestamp = formatExportTimestamp(new Date());
    const filename = `qualifile_profile_${timestamp}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Profile export ready');
  } catch (error) {
    showToast(error.message || 'Unable to export profile.', true);
  } finally {
    setStatus('Saved/Idle');
  }
}

async function importProfile(elements) {
  const input = elements.importInput;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const file = input.files && input.files[0];
  if (!file) {
    showToast('Select a JSON file to import.', true);
    return;
  }
  const form = new FormData();
  form.append('payload', file, file.name || 'profile.json');
  try {
    setStatus('Importing profile...');
    const response = await requestJson(IMPORT_ENDPOINT, { method: 'POST', body: form });
    setProfileState(elements, response?.profile || null);
    dispatchProfileChange(response);
    showToast('Profile imported');
    void initProfileHeaderAvatar();
  } catch (error) {
    showToast(error.message || 'Unable to import profile.', true);
  } finally {
    setStatus('Saved/Idle');
    input.value = '';
    updateImportControls(elements);
  }
}

export function initProfileModal() {
  if (initialized) return;
  initialized = true;
  const mode = getProfileMode();
  updateToggleState(mode);
  const modal = document.getElementById('modal-profile');
  document.querySelectorAll('[data-profile-modal-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      if (getProfileMode() !== ENABLED_MODE) {
        showToast('Profile mode is disabled by configuration.', true);
        return;
      }
      if (!modal) return;
      bootstrap.Modal.getOrCreateInstance(modal).show();
    });
  });
  if (!modal || mode !== ENABLED_MODE) {
    return;
  }
  const elements = resolveElements(modal);
  if (!elements) return;
  updateAvatarControls(elements);
  updateImportControls(elements);

  modal.addEventListener('show.bs.modal', () => {
    clearErrors(elements);
    void loadProfile(elements);
  });
  modal.addEventListener('hidden.bs.modal', () => {
    clearErrors(elements);
    if (elements.importInput instanceof HTMLInputElement) {
      elements.importInput.value = '';
    }
    updateImportControls(elements);
  });
  elements.form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitProfile(elements);
  });
  elements.disconnectButton.addEventListener('click', () => {
    void disconnectProfile(elements);
  });
  if (elements.avatarInput instanceof HTMLInputElement) {
    elements.avatarInput.addEventListener('change', () => {
      updateAvatarControls(elements);
    });
  }
  if (elements.avatarUploadButton instanceof HTMLButtonElement) {
    elements.avatarUploadButton.addEventListener('click', () => {
      void uploadAvatar(elements);
    });
  }
  if (elements.exportButton instanceof HTMLButtonElement) {
    elements.exportButton.addEventListener('click', () => {
      void exportProfile(elements);
    });
  }
  if (elements.importInput instanceof HTMLInputElement) {
    elements.importInput.addEventListener('change', () => {
      updateImportControls(elements);
    });
  }
  if (elements.importButton instanceof HTMLButtonElement) {
    elements.importButton.addEventListener('click', () => {
      void importProfile(elements);
    });
  }
}
