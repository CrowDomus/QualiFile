const ROOT_STATES_WITHOUT_RECOMMENDATION = new Set([
  'no-root',
  'root-unavailable',
  'root-id-missing',
]);

function normalizeState(value) {
  return String(value || '').trim();
}

function normalizeNumber(value) {
  const nextValue = Number(value);
  return Number.isFinite(nextValue) ? nextValue : 0;
}

function resolveActionEnabled(row, actionKey, resolveActionState) {
  if (actionKey === 'settings') {
    return Boolean(resolveActionState(row, 'set_remote')?.enabled);
  }
  return Boolean(resolveActionState(row, actionKey)?.enabled);
}

function hasRemoteGuidanceFailure(row) {
  const failureCodes = Array.isArray(row?.failure_codes) ? row.failure_codes : [];
  return failureCodes.some((code) => {
    const text = String(code || '').trim();
    return text === 'git-remote-ambiguous' || text.startsWith('remote-url-');
  });
}

function shouldSkipRecommendation(row) {
  if (!row || typeof row !== 'object') {
    return true;
  }
  if (row?.pre_sync?.blocked) {
    return true;
  }
  const rootState = normalizeState(row?.states?.root);
  return ROOT_STATES_WITHOUT_RECOMMENDATION.has(rootState);
}

export function resolveRecommendedActionKey(row, resolveActionState) {
  if (shouldSkipRecommendation(row)) {
    return '';
  }

  const gitState = normalizeState(row?.states?.git);
  const localState = normalizeState(row?.states?.local_metadata);
  const upstream = normalizeState(row?.git_status?.upstream);
  const behind = normalizeNumber(row?.git_status?.behind);
  const ahead = normalizeNumber(row?.git_status?.ahead);
  const hasDirtyWorkingTree = Boolean(row?.git_status?.is_dirty);

  if (gitState !== 'ready' && resolveActionEnabled(row, 'init_repo', resolveActionState)) {
    return 'init_repo';
  }

  if (
    gitState === 'ready' &&
    (!upstream || hasRemoteGuidanceFailure(row)) &&
    resolveActionEnabled(row, 'settings', resolveActionState)
  ) {
    return 'settings';
  }

  if (
    (localState === 'dirty' || hasDirtyWorkingTree || ahead > 0) &&
    resolveActionEnabled(row, 'commit_push', resolveActionState)
  ) {
    return 'commit_push';
  }

  if (behind > 0 && resolveActionEnabled(row, 'pull_import', resolveActionState)) {
    return 'pull_import';
  }

  if (resolveActionEnabled(row, 'status', resolveActionState)) {
    return 'status';
  }

  const fallbackOrder = [
    'commit_push',
    'pull_import',
    'export_metadata',
    'import_metadata',
    'open_folder',
    'settings',
    'status',
  ];
  return (
    fallbackOrder.find((actionKey) => resolveActionEnabled(row, actionKey, resolveActionState)) ||
    ''
  );
}

export function resolveVisiblePrimaryActionKey(row, visibleActionKeys, resolveActionState) {
  if (!Array.isArray(visibleActionKeys) || !visibleActionKeys.length) {
    return '';
  }
  if (shouldSkipRecommendation(row)) {
    return '';
  }

  const recommendation = resolveRecommendedActionKey(row, resolveActionState);
  if (
    recommendation &&
    visibleActionKeys.includes(recommendation) &&
    resolveActionEnabled(row, recommendation, resolveActionState)
  ) {
    return recommendation;
  }

  return (
    visibleActionKeys.find((actionKey) =>
      resolveActionEnabled(row, actionKey, resolveActionState)
    ) || ''
  );
}
