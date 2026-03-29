import { state } from '../../shared/state.js';
import { showToast, setStatus } from '../../shared/ui.js';
import { launchGreenshot, handleError } from '../../shared/api.js';

export async function openWithGreenshot(path, { notify = true } = {}) {
    const config = state.settings.greenshot || {};
    const enabled = typeof config.enabled === 'boolean' ? config.enabled : Boolean((config.path || '').trim());
    if (!enabled) {
        showToast('Enable Greenshot integration in Settings to use this.', true);
        throw new Error('Greenshot integration disabled');
    }
    if (!config.path) {
        showToast('Configure the Greenshot executable in Settings first.', true);
        throw new Error('Greenshot not configured');
    }
    try {
        setStatus('Opening in Greenshot…');
        const payload = await launchGreenshot({
            executable: config.path,
            delay: config.delay,
            file: path,
        });
        if (notify) {
            showToast('Sent to Greenshot');
        }
        return payload;
    } catch (error) {
        handleError(error);
        return null;
    } finally {
        setStatus('Saved/Idle');
    }
}
