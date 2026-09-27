import { initProfilePreferencesBridge } from '../features/user_profile/profile_bridge.js';
import { initProfileHeaderAvatar } from '../features/user_profile/header_avatar.js';
import { initProfileModal } from '../features/user_profile/profile_modal.js';
import { initProfileController } from '../features/user_profile/profile_controller.js';
import { initTaskAlertsHeader } from '../features/task_alerts/header_alert_icon.js';
import { initModalStacking } from '../shared/modal_stack.js';
import { initModalBackdropGuard } from '../shared/modal_backdrop_guard.js';
import { initToast } from '../shared/ui.js';
import { initSyncManagerPage } from '../features/git_sync/sync_manager_page.js';

async function bootstrap() {
  initToast();
  initModalStacking();
  initModalBackdropGuard();
  await initProfilePreferencesBridge();
  void initProfileHeaderAvatar();
  initProfileModal();
  initProfileController();
  initTaskAlertsHeader();
  initSyncManagerPage();
}

bootstrap();
