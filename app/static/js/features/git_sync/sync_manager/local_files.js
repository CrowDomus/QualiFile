const DEFAULT_LOCAL_FILES_COUNTS = Object.freeze({
  modified: 0,
  added: 0,
  deleted: 0,
  untracked: 0,
});

const LOCAL_FILE_CHIP_DEFINITIONS = Object.freeze([
  {
    key: 'modified',
    singular: 'modified file',
    plural: 'modified files',
    tone: 'modified',
  },
  {
    key: 'added',
    singular: 'added file',
    plural: 'added files',
    tone: 'added',
  },
  {
    key: 'deleted',
    singular: 'deleted file',
    plural: 'deleted files',
    tone: 'deleted',
  },
  {
    key: 'untracked',
    singular: 'untracked file',
    plural: 'untracked files',
    tone: 'untracked',
  },
]);

function normalizeCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.round(parsed);
}

export function normalizeLocalFilesCounts(rawCounts) {
  if (!rawCounts || typeof rawCounts !== 'object') {
    return null;
  }
  return {
    modified: normalizeCount(rawCounts.modified),
    added: normalizeCount(rawCounts.added),
    deleted: normalizeCount(rawCounts.deleted),
    untracked: normalizeCount(rawCounts.untracked),
  };
}

export function formatLocalFilesCounts(rawCounts) {
  const counts = normalizeLocalFilesCounts(rawCounts) || DEFAULT_LOCAL_FILES_COUNTS;
  return `Modified ${counts.modified}, Added ${counts.added}, Deleted ${counts.deleted}, Untracked ${counts.untracked}`;
}

function buildLocalFileChipLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function countTotalLocalFileChanges(counts) {
  return counts.modified + counts.added + counts.deleted + counts.untracked;
}

export function resolveLocalFilesSummary(row) {
  const counts = normalizeLocalFilesCounts(row?.git_status?.local_files);
  if (counts) {
    const total = countTotalLocalFileChanges(counts);
    const chips = LOCAL_FILE_CHIP_DEFINITIONS.map((definition) => {
      const count = counts[definition.key];
      if (!count) {
        return null;
      }
      return {
        key: definition.key,
        tone: definition.tone,
        label: buildLocalFileChipLabel(count, definition.singular, definition.plural),
      };
    }).filter((chip) => chip !== null);
    if (!chips.length) {
      return {
        kind: 'chips',
        title: 'No local workspace file changes (internal paths excluded).',
        chips: [
          {
            key: 'clean',
            tone: 'clean',
            label: 'No local file changes',
          },
        ],
      };
    }
    return {
      kind: 'chips',
      title: `${total} local file change${total === 1 ? '' : 's'} (internal paths excluded).`,
      chips,
    };
  }
  const gitState = String(row?.states?.git || '').trim();
  if (gitState === 'not-initialized') {
    return {
      kind: 'placeholder',
      label: 'Not initialized',
      title: 'Local file counts are available after repository initialization.',
    };
  }
  return {
    kind: 'placeholder',
    label: 'Unavailable',
    title: 'Local file counts are unavailable for this project state.',
  };
}
