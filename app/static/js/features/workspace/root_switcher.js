import { requestJson } from '../../shared/api.js';
import { pickReadableTextColor } from '../../shared/color-utils.js';
import { normalizePath } from '../../shared/paths.js';
import { state } from '../../shared/state.js';
import { showToast } from '../../shared/ui.js';
import { warnDiagnostic } from '../../shared/diagnostics.js';

const MENU_EMPTY_MESSAGE = 'No projects with root configured.';
const MENU_ERROR_MESSAGE = 'Unable to load projects.';
const MENU_LOADING_MESSAGE = 'Loading projects...';

function normalizeWorkspaceRoot(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (!raw || raw === '.') return '';
  const normalized = normalizePath(raw);
  if (!normalized) return '';
  const isUnc = raw.startsWith('\\\\') || raw.startsWith('//');
  if (/^[A-Za-z]:/.test(normalized) || isUnc) {
    return normalized.toLowerCase();
  }
  return normalized;
}

function normalizeProjectColor(value) {
  if (!value) return '';
  let text = String(value).trim();
  if (!text) return '';
  if (text.startsWith('#')) text = text.slice(1);
  if (text.length === 3) {
    text = text
      .split('')
      .map((ch) => ch + ch)
      .join('');
  }
  if (text.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(text)) {
    return '';
  }
  return `#${text.toLowerCase()}`;
}

function projectHasRoot(project) {
  return Boolean(normalizeWorkspaceRoot(project?.root_path));
}

function renderMenuMessage(container, message) {
  if (!container) return;
  container.innerHTML = '';
  const text = document.createElement('div');
  text.className = 'workspace-root-switcher-empty';
  text.textContent = message;
  text.setAttribute('role', 'status');
  container.appendChild(text);
}

function applyProjectPill(toggle, project) {
  if (!toggle) return;
  const label = toggle.querySelector('.workspace-root-switcher-label');
  if (!label) return;
  if (!project) {
    label.textContent = '';
    toggle.removeAttribute('title');
    toggle.style.removeProperty('--project-color');
    toggle.style.removeProperty('--project-pill-text');
    return;
  }

  label.textContent = project.name || project.id || '';
  toggle.title = label.textContent;
  const normalizedColor = normalizeProjectColor(project.color);
  if (normalizedColor) {
    toggle.style.setProperty('--project-color', normalizedColor);
    toggle.style.setProperty('--project-pill-text', pickReadableTextColor(normalizedColor));
  } else {
    toggle.style.removeProperty('--project-color');
    toggle.style.removeProperty('--project-pill-text');
  }
}

function makeProjectOption(project, { isCurrent = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dropdown-item workspace-root-switcher-option ws-root-item';
  button.dataset.projectId = String(project?.id || '');
  button.setAttribute('role', 'menuitem');
  button.setAttribute('aria-current', isCurrent ? 'true' : 'false');
  button.setAttribute('title', project?.name || project?.id || 'Project');
  if (isCurrent) {
    button.classList.add('active', 'workspace-root-switcher-option--current');
  }
  const label = document.createElement('span');
  label.className = 'ws-root-item-label';
  label.textContent = project?.name || project?.id || 'Unnamed project';
  button.appendChild(label);
  if (isCurrent) {
    const check = document.createElement('span');
    check.className = 'ws-root-item-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '\u2713';
    button.appendChild(check);
  }
  return button;
}

export function initWorkspaceRootSwitcher() {
  const wrapper = document.getElementById('workspace-linked-project-wrap');
  const toggle = document.getElementById('workspace-linked-project-pill');
  const menu = document.getElementById('workspace-root-switcher-menu');
  const list = document.getElementById('workspace-root-switcher-list');
  const appShell = document.getElementById('app');
  if (!wrapper || !toggle || !menu || !list || !appShell) {
    return null;
  }

  const dropdown = globalThis.bootstrap?.Dropdown
    ? globalThis.bootstrap.Dropdown.getOrCreateInstance(toggle)
    : null;

  let projectsCache = null;
  let projectsPromise = null;
  let updateToken = 0;
  let activeProjectId = '';
  let switching = false;
  let currentRoot = appShell.dataset.root || state.root || '.';

  const setMenuDisabled = (disabled) => {
    list.querySelectorAll('button[data-project-id]').forEach((element) => {
      element.disabled = disabled;
    });
    toggle.setAttribute('aria-busy', disabled ? 'true' : 'false');
  };

  const loadProjects = async ({ force = false } = {}) => {
    if (!force && Array.isArray(projectsCache)) {
      return projectsCache;
    }
    if (projectsPromise) {
      return projectsPromise;
    }

    projectsPromise = requestJson('/api/projects')
      .then((payload) => {
        const allProjects = Array.isArray(payload?.projects) ? payload.projects : [];
        const rootProjects = allProjects.filter(projectHasRoot);
        projectsCache = rootProjects;
        return rootProjects;
      })
      .finally(() => {
        projectsPromise = null;
      });

    return projectsPromise;
  };

  const renderProjectOptions = (projects, currentProject) => {
    list.innerHTML = '';
    if (!Array.isArray(projects) || !projects.length) {
      renderMenuMessage(list, MENU_EMPTY_MESSAGE);
      return;
    }
    projects.forEach((project) => {
      const option = makeProjectOption(project, { isCurrent: project?.id === currentProject?.id });
      list.appendChild(option);
    });
  };

  const applyHeaderState = (project) => {
    if (!project) {
      wrapper.hidden = true;
      activeProjectId = '';
      applyProjectPill(toggle, null);
      return;
    }
    wrapper.hidden = false;
    activeProjectId = String(project.id || '');
    applyProjectPill(toggle, project);
    toggle.setAttribute(
      'aria-label',
      `Current workspace root: ${project.name || project.id || 'Project'}`
    );
  };

  const refresh = async ({ force = false } = {}) => {
    const token = ++updateToken;
    const normalizedRoot = normalizeWorkspaceRoot(currentRoot);
    if (!normalizedRoot) {
      applyHeaderState(null);
      renderMenuMessage(list, MENU_EMPTY_MESSAGE);
      return;
    }

    renderMenuMessage(list, MENU_LOADING_MESSAGE);

    try {
      const projects = await loadProjects({ force });
      if (token !== updateToken) return;

      const currentProject =
        projects.find((project) => {
          const projectRoot = normalizeWorkspaceRoot(project?.root_path);
          return projectRoot && projectRoot === normalizedRoot;
        }) || null;

      applyHeaderState(currentProject);
      renderProjectOptions(projects, currentProject);
    } catch (error) {
      if (token !== updateToken) return;
      applyHeaderState(null);
      renderMenuMessage(list, MENU_ERROR_MESSAGE);
      warnDiagnostic('WorkspaceRootSwitcherLoadFailure', error);
    }
  };

  const switchProjectRoot = async (projectId) => {
    const normalizedId = String(projectId || '').trim();
    if (!normalizedId) return;
    if (normalizedId === activeProjectId) {
      dropdown?.hide();
      return;
    }
    if (switching) return;

    switching = true;
    setMenuDisabled(true);
    try {
      await requestJson(`/api/projects/${encodeURIComponent(normalizedId)}/activate`, {
        method: 'POST',
      });
      window.location.assign('/workspace');
    } catch (error) {
      switching = false;
      setMenuDisabled(false);
      warnDiagnostic('WorkspaceRootSwitcherSwitchFailure', error);
      showToast(error?.message || 'Unable to switch workspace root.', true);
    }
  };

  const onMenuClick = (event) => {
    const trigger =
      event.target instanceof Element ? event.target.closest('button[data-project-id]') : null;
    if (!trigger || trigger.disabled) return;
    event.preventDefault();
    void switchProjectRoot(trigger.dataset.projectId);
  };

  const onMenuKeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dropdown?.hide();
      toggle.focus();
      return;
    }
    const trigger =
      event.target instanceof Element ? event.target.closest('button[data-project-id]') : null;
    if (!trigger || trigger.disabled) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void switchProjectRoot(trigger.dataset.projectId);
    }
  };

  const onDropdownShown = () => {
    toggle.setAttribute('aria-expanded', 'true');
    void refresh({ force: true });
  };

  const onDropdownHidden = () => {
    toggle.setAttribute('aria-expanded', 'false');
  };

  list.addEventListener('click', onMenuClick);
  list.addEventListener('keydown', onMenuKeydown);
  toggle.addEventListener('shown.bs.dropdown', onDropdownShown);
  toggle.addEventListener('hidden.bs.dropdown', onDropdownHidden);

  const observer = new MutationObserver(() => {
    const nextRoot = appShell.dataset.root || state.root || '.';
    if (nextRoot === currentRoot) return;
    currentRoot = nextRoot;
    void refresh();
  });
  observer.observe(appShell, { attributes: true, attributeFilter: ['data-root'] });

  void refresh();

  return {
    refresh: () => refresh({ force: true }),
    destroy() {
      observer.disconnect();
      list.removeEventListener('click', onMenuClick);
      list.removeEventListener('keydown', onMenuKeydown);
      toggle.removeEventListener('shown.bs.dropdown', onDropdownShown);
      toggle.removeEventListener('hidden.bs.dropdown', onDropdownHidden);
      dropdown?.hide();
    },
  };
}
