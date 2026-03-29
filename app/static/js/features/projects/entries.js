/** Utilities for managing project-scoped tasks/notes via the API. */
import { requestJson } from '../../shared/api.js';

function entriesUrl(projectId, entryId = null, params = '') {
    const base = `/api/projects/${encodeURIComponent(projectId)}/entries`;
    const suffix = entryId ? `/${encodeURIComponent(entryId)}` : '';
    const query = params ? `?${params}` : '';
    return `${base}${suffix}${query}`;
}

export async function fetchProjectEntries(projectId, type = null) {
    const params = type ? `type=${encodeURIComponent(type)}` : '';
    return requestJson(entriesUrl(projectId, null, params));
}

export async function createProjectEntry(projectId, payload = {}) {
    const params = payload.type ? `type=${encodeURIComponent(payload.type)}` : '';
    return requestJson(entriesUrl(projectId, null, params), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

export async function updateProjectEntry(projectId, entryId, payload = {}) {
    const params = payload.type ? `type=${encodeURIComponent(payload.type)}` : '';
    return requestJson(entriesUrl(projectId, entryId, params), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

export async function deleteProjectEntry(projectId, entryId, type = null) {
    const params = type ? `type=${encodeURIComponent(type)}` : '';
    return requestJson(entriesUrl(projectId, entryId, params), { method: 'DELETE' });
}

export async function updateProjectEntryMode(projectId, entryMode) {
    return requestJson(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_mode: entryMode }),
    });
}
