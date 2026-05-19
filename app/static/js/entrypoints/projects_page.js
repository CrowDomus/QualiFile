// Entrypoint for projects page.
import { initProfilePreferencesBridge } from '../features/user_profile/profile_bridge.js';
import { initProfileHeaderAvatar } from '../features/user_profile/header_avatar.js';
import { initProfileModal } from '../features/user_profile/profile_modal.js';
import { initProfileController } from '../features/user_profile/profile_controller.js';
import { initHeaderAddNoteProjects } from '../features/projects/header_add_note_projects.js';
import { initTaskAlertsHeader } from '../features/task_alerts/header_alert_icon.js';
import { initModalStacking } from '../shared/modal_stack.js';
import { initModalBackdropGuard } from '../shared/modal_backdrop_guard.js';
import { initNoteFormattingToolbars } from '../features/notes/note_formatting_toolbar.js';

async function bootstrap() {
    initModalStacking();
    initModalBackdropGuard();
    await initProfilePreferencesBridge();
    void initProfileHeaderAvatar();
    initProfileModal();
    initProfileController();
    initTaskAlertsHeader();
    await import('../features/projects/index.js');
    initNoteFormattingToolbars();
    initHeaderAddNoteProjects();
}

bootstrap();
