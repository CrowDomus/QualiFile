import { fetchProjectEntries } from '../projects/entries.js';

function extractTasks(payload) {
  const entries = payload?.entries || payload || {};
  if (Array.isArray(entries.tasks)) return entries.tasks;
  if (Array.isArray(entries.task)) return entries.task;
  return [];
}

export class TimelineDataSource {
  constructor(options = {}) {
    this.fetchEntries = options.fetchEntries || fetchProjectEntries;
    this.cache = new Map();
  }

  setCache(projectId, tasks = []) {
    if (!projectId) return;
    this.cache.set(projectId, Array.isArray(tasks) ? tasks : []);
  }

  clearCache(projectId = null) {
    if (projectId) {
      this.cache.delete(projectId);
      return;
    }
    this.cache.clear();
  }

  async loadTasks(projectIds, { forceReload = false } = {}) {
    const ids = Array.from(new Set((projectIds || []).filter(Boolean)));
    if (!ids.length) return [];
    const results = [];
    const errors = [];
    await Promise.all(
      ids.map(async (projectId) => {
        try {
          if (!forceReload && this.cache.has(projectId)) {
            const cached = this.cache.get(projectId) || [];
            cached.forEach((task) => results.push({ projectId, task }));
            return;
          }
          const payload = await this.fetchEntries(projectId);
          const tasks = extractTasks(payload);
          this.cache.set(projectId, tasks);
          tasks.forEach((task) => results.push({ projectId, task }));
        } catch (error) {
          errors.push({ projectId, error });
        }
      })
    );
    if (errors.length) {
      const message = errors
        .map((item) => `${item.projectId}: ${item.error?.message || 'Failed to load tasks'}`)
        .join('; ');
      const err = new Error(message);
      err.details = errors;
      throw err;
    }
    return results;
  }
}
