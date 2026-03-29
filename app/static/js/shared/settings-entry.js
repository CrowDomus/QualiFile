import { initModals, openSettingsModal } from '../features/modals/modals.js';

const SETTINGS_FLAG = '__qfSettingsNavBound__';

function bindSettingsNav() {
    if (window[SETTINGS_FLAG]) return;
    const links = document.querySelectorAll('[data-nav-settings]');
    if (!links.length) return;
    window[SETTINGS_FLAG] = true;
    links.forEach((link) => {
        link.addEventListener('click', (event) => {
            event.preventDefault();
            openSettingsModal();
        });
    });
}

function maybeOpenSettingsFromLocation() {
    const hash = window.location.hash.toLowerCase();
    const params = new URLSearchParams(window.location.search);
    if (hash === '#settings' || params.get('settings') === '1') {
        setTimeout(() => openSettingsModal(), 0);
    }
}

function boot() {
    initModals();
    bindSettingsNav();
    maybeOpenSettingsFromLocation();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
