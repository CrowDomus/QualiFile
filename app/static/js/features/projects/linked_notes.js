import { requestJson } from '../../shared/api.js';

const linkedNotesCache = new Map();

function linkedNotesUrl(projectId) {
  return `/api/projects/${encodeURIComponent(projectId)}/linked-notes`;
}

function normalizeLinkedNotesResponse(payload) {
  const linkedNotes = Array.isArray(payload?.linked_notes) ? payload.linked_notes : [];
  const limit = Number.isFinite(payload?.limit) ? payload.limit : linkedNotes.length;
  return {
    linked_notes: linkedNotes,
    capped: Boolean(payload?.capped),
    limit,
    source: typeof payload?.source === 'string' ? payload.source : 'unknown',
  };
}

export async function fetchLinkedNotes(projectId) {
  return requestJson(linkedNotesUrl(projectId));
}

export async function createLinkedNote(projectId, payload = {}) {
  if (!projectId) {
    throw new Error('Project is required.');
  }
  return requestJson(linkedNotesUrl(projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function ensureLinkedNotes(projectId, { force = false } = {}) {
  if (!projectId) return null;
  if (!force && linkedNotesCache.has(projectId)) {
    return linkedNotesCache.get(projectId);
  }
  const payload = await fetchLinkedNotes(projectId);
  const normalized = normalizeLinkedNotesResponse(payload);
  linkedNotesCache.set(projectId, normalized);
  return normalized;
}

export function getLinkedNotesCache(projectId) {
  return linkedNotesCache.get(projectId) || null;
}

export function clearLinkedNotesCache(projectId = null) {
  if (projectId) {
    linkedNotesCache.delete(projectId);
    return;
  }
  linkedNotesCache.clear();
}
