"""Sync Manager status/action baseline aggregation for Git Sync."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Mapping, Sequence

from .failure_messages import map_failure_codes_to_guidance
from .git_runner import DEFAULT_GIT_TIMEOUT_SECONDS
from .git_trust import GitBinaryTrustStore, resolve_trusted_git_binary_path
from .git_workflow import GitRunner, GitWorkflowError, RepoSyncStatus, get_repo_sync_status
from .lss_dirty_gate import DirtyStateError, evaluate_local_metadata_dirty
from .lss_store import LocalSyncStateStore
from .pps_export_swap import ACTIVE_DIRNAME
from .pps_manifest import ManifestValidationError, load_manifest_with_integrity
from .pre_sync_resolver import PreSyncConflict, detect_pre_sync_conflict

_ACTION_KEYS = (
    "status",
    "export_metadata",
    "import_metadata",
    "init_repo",
    "set_remote",
    "commit_push",
    "pull_import",
    "open_folder",
)

_ROOT_BLOCK_REASON = {
    "no-root": "project-no-root",
    "root-id-missing": "project-root-id-missing",
    "root-unavailable": "root-unavailable",
    "unknown": "root-unavailable",
}

_PPS_IMPORT_REASON = {
    "missing": "git-sync-incomplete-pps",
    "incomplete": "git-sync-incomplete-pps",
    "invalid": "git-sync-incomplete-pps",
    "conflicted": "git-sync-conflict",
    "unavailable": "git-sync-incomplete-pps",
}


def _normalize_optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _parse_root_state(*, root_path: str | None, root_id: str | None) -> tuple[str, Path | None]:
    normalized_path = _normalize_optional_text(root_path)
    normalized_root_id = _normalize_optional_text(root_id)
    if normalized_path is None:
        return "no-root", None
    root = Path(normalized_path).expanduser()
    if not root.exists() or not root.is_dir():
        return "root-unavailable", root
    if normalized_root_id is None:
        return "root-id-missing", root
    return "ready", root.resolve()


def _git_repo_marker_exists(root: Path | None) -> bool:
    if root is None:
        return False
    return (root / ".git").exists()


def _workspace_roots_from_projects(conn: sqlite3.Connection) -> tuple[Path, ...]:
    rows = conn.execute(
        "SELECT DISTINCT root_path FROM projects WHERE root_path IS NOT NULL AND trim(root_path) <> ''"
    ).fetchall()
    roots: list[Path] = []
    for (raw_path,) in rows:
        normalized = _normalize_optional_text(raw_path)
        if normalized is None:
            continue
        roots.append(Path(normalized).expanduser())
    return tuple(roots)


def _resolve_trusted_git_binary_for_sync_manager(conn: sqlite3.Connection) -> str | None:
    trust_store = GitBinaryTrustStore(conn)
    decision = resolve_trusted_git_binary_path(
        trust_store=trust_store,
        workspace_roots=_workspace_roots_from_projects(conn),
    )
    if not decision.allowed:
        return None
    return _normalize_optional_text(decision.resolved_path)


def _evaluate_git_state(
    root: Path | None,
    *,
    run_git: GitRunner | None,
    git_binary: Path | str | None,
    timeout_seconds: float,
) -> tuple[str, RepoSyncStatus | None, str | None]:
    if root is None:
        return "unavailable", None, None
    if not _git_repo_marker_exists(root):
        return "not-initialized", None, None
    normalized_git_binary = _normalize_optional_text(git_binary)
    try:
        status = get_repo_sync_status(
            root,
            run_git=run_git,
            git_binary=normalized_git_binary,
            timeout_seconds=timeout_seconds,
        )
    except GitWorkflowError as exc:
        if exc.code in {"git-missing", "git-path-invalid", "git-not-trusted"}:
            return "git-missing", None, exc.code
        return "error", None, exc.code
    return "ready", status, None


def _evaluate_pps_state(root: Path | None, *, status: RepoSyncStatus | None) -> tuple[str, str | None]:
    if root is None:
        return "unavailable", None
    if status is not None and status.unmerged_pps_paths:
        return "conflicted", "git-sync-pps-unmerged"
    snapshot_dir = root / ACTIVE_DIRNAME
    if not snapshot_dir.exists() or not snapshot_dir.is_dir():
        return "missing", None
    try:
        load_manifest_with_integrity(snapshot_dir, verify_fingerprint=True)
    except ManifestValidationError as exc:
        if exc.code in {"manifest-missing", "manifest-fingerprint-mismatch"}:
            return "incomplete", exc.code
        return "invalid", exc.code
    return "valid", None


def _evaluate_local_metadata_state(
    conn: sqlite3.Connection,
    *,
    root_id: str | None,
    project_id: str,
    lss_store: LocalSyncStateStore,
) -> tuple[str, str | None]:
    normalized_root_id = _normalize_optional_text(root_id)
    if normalized_root_id is None:
        return "unknown", "project-root-id-missing"
    try:
        dirty_state = evaluate_local_metadata_dirty(
            conn,
            root_id=normalized_root_id,
            project_id=project_id,
            lss_store=lss_store,
        )
    except DirtyStateError as exc:
        return "unknown", exc.code
    if dirty_state.is_dirty:
        return "dirty", dirty_state.reason_code
    return "clean", dirty_state.reason_code


def _project_conflict_for_row(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    root_id: str | None,
    root_path: str | None,
) -> PreSyncConflict | None:
    normalized_root_id = _normalize_optional_text(root_id)
    if normalized_root_id is None:
        return None
    conflict = detect_pre_sync_conflict(
        conn,
        root_id=normalized_root_id,
        root_path=root_path,
    )
    if conflict is None:
        return None
    if project_id not in conflict.project_ids:
        return None
    return conflict


def _first_reason(reasons: Sequence[str | None]) -> str | None:
    for reason in reasons:
        normalized = _normalize_optional_text(reason)
        if normalized is not None:
            return normalized
    return None


def _action(reason: str | None) -> dict[str, Any]:
    return {
        "enabled": reason is None,
        "reason": reason,
    }


def _build_actions(
    *,
    root_state: str,
    git_state: str,
    pps_state: str,
    local_state: str,
    pre_sync_conflict: PreSyncConflict | None,
) -> Mapping[str, Mapping[str, Any]]:
    root_reason = _ROOT_BLOCK_REASON.get(root_state)
    pre_sync_reason = "pre-sync-resolver-required" if pre_sync_conflict is not None else None

    repo_required_reason = _first_reason(
        (
            root_reason,
            pre_sync_reason,
            "git-repo-not-initialized" if git_state == "not-initialized" else None,
            "git-missing" if git_state == "git-missing" else None,
            "git-status-error" if git_state == "error" else None,
        )
    )

    status_reason = _first_reason((root_reason,))
    open_folder_reason = _first_reason(
        (
            "project-no-root" if root_state == "no-root" else None,
            "root-unavailable" if root_state == "root-unavailable" else None,
        )
    )
    init_repo_reason = _first_reason(
        (
            root_reason,
            pre_sync_reason,
            "git-repo-already-initialized" if git_state in {"ready", "error", "git-missing"} else None,
        )
    )
    export_reason = _first_reason((root_reason, pre_sync_reason))
    import_reason = _first_reason((root_reason, pre_sync_reason, _PPS_IMPORT_REASON.get(pps_state)))
    pull_reason = _first_reason(
        (
            repo_required_reason,
            "git-sync-conflict" if pps_state == "conflicted" else None,
            "git-sync-dirty-local" if local_state == "dirty" else None,
        )
    )

    actions: dict[str, Mapping[str, Any]] = {
        "status": _action(status_reason),
        "export_metadata": _action(export_reason),
        "import_metadata": _action(import_reason),
        "init_repo": _action(init_repo_reason),
        "set_remote": _action(repo_required_reason),
        "commit_push": _action(repo_required_reason),
        "pull_import": _action(pull_reason),
        "open_folder": _action(open_folder_reason),
    }
    # Keep all baseline action keys stable for UI wiring.
    for key in _ACTION_KEYS:
        actions.setdefault(key, _action("unsupported"))
    return actions


def _recommended_actions(
    *,
    root_state: str,
    git_state: str,
    pps_state: str,
    local_state: str,
    pre_sync_conflict: PreSyncConflict | None,
    actions: Mapping[str, Mapping[str, Any]],
) -> tuple[str, ...]:
    if pre_sync_conflict is not None:
        return ("resolve_pre_sync_conflict",)
    if root_state == "no-root":
        return ("configure_root",)
    if root_state == "root-unavailable":
        return ("open_folder",)
    if root_state == "root-id-missing":
        return ("refresh_root_marker",)
    if bool(actions["init_repo"]["enabled"]):
        return ("init_repo",)
    if pps_state in {"missing", "incomplete", "invalid"} and bool(actions["export_metadata"]["enabled"]):
        return ("export_metadata",)
    if local_state == "dirty" and bool(actions["commit_push"]["enabled"]):
        return ("commit_push",)
    if git_state == "ready":
        return ("status",)
    return tuple()


def _serialize_repo_status(status: RepoSyncStatus | None) -> Mapping[str, Any] | None:
    if status is None:
        return None
    return {
        "branch": status.branch,
        "upstream": status.upstream,
        "ahead": status.ahead,
        "behind": status.behind,
        "is_dirty": status.is_dirty,
        "pps_dirty": status.pps_dirty,
        "unmerged_pps_paths": list(status.unmerged_pps_paths),
        "local_files": {
            "modified": int(status.local_files.modified),
            "added": int(status.local_files.added),
            "deleted": int(status.local_files.deleted),
            "untracked": int(status.local_files.untracked),
        },
    }


def _collect_failure_codes(
    *,
    git_state: str,
    pps_state: str,
    local_state: str,
    warnings: Sequence[str],
) -> tuple[str, ...]:
    codes: list[str] = []
    if git_state == "git-missing":
        codes.append("git-missing")
    if pps_state == "conflicted":
        codes.append("git-sync-conflict")
    if pps_state in {"missing", "incomplete", "invalid", "unavailable"}:
        codes.append("git-sync-incomplete-pps")
    if local_state == "dirty":
        codes.append("git-sync-dirty-local")
    for warning in warnings:
        normalized = _normalize_optional_text(warning)
        if normalized is not None:
            codes.append(normalized)
    deduped: list[str] = []
    seen: set[str] = set()
    for code in codes:
        if code in seen:
            continue
        seen.add(code)
        deduped.append(code)
    return tuple(deduped)


def list_sync_manager_project_statuses(
    conn: sqlite3.Connection,
    *,
    lss_store: LocalSyncStateStore | None = None,
    run_git: GitRunner | None = None,
    git_binary: Path | str | None = None,
    timeout_seconds: float = DEFAULT_GIT_TIMEOUT_SECONDS,
) -> list[dict[str, Any]]:
    """Build per-project status/action rows for Sync Manager."""

    rows = conn.execute(
        """
        SELECT project_id, name, root_id, root_path
        FROM projects
        ORDER BY lower(name) ASC, project_id ASC
        """
    ).fetchall()

    resolved_lss_store = lss_store or LocalSyncStateStore(conn)
    resolved_git_binary = _normalize_optional_text(git_binary)
    if run_git is None and resolved_git_binary is None:
        resolved_git_binary = _resolve_trusted_git_binary_for_sync_manager(conn)

    project_rows: list[dict[str, Any]] = []
    for project_id_raw, name_raw, root_id_raw, root_path_raw in rows:
        project_id = _normalize_optional_text(project_id_raw)
        if project_id is None:
            continue
        project_name = _normalize_optional_text(name_raw) or project_id
        root_id = _normalize_optional_text(root_id_raw)
        root_path = _normalize_optional_text(root_path_raw)

        root_state, root_dir = _parse_root_state(root_path=root_path, root_id=root_id)
        pre_sync_conflict = _project_conflict_for_row(
            conn,
            project_id=project_id,
            root_id=root_id,
            root_path=root_path,
        )
        git_state, repo_status, git_error_code = _evaluate_git_state(
            root_dir,
            run_git=run_git,
            git_binary=resolved_git_binary,
            timeout_seconds=timeout_seconds,
        )
        pps_state, pps_error_code = _evaluate_pps_state(root_dir, status=repo_status)
        local_state, local_reason_code = _evaluate_local_metadata_state(
            conn,
            root_id=root_id,
            project_id=project_id,
            lss_store=resolved_lss_store,
        )
        actions = _build_actions(
            root_state=root_state,
            git_state=git_state,
            pps_state=pps_state,
            local_state=local_state,
            pre_sync_conflict=pre_sync_conflict,
        )
        recommended = _recommended_actions(
            root_state=root_state,
            git_state=git_state,
            pps_state=pps_state,
            local_state=local_state,
            pre_sync_conflict=pre_sync_conflict,
            actions=actions,
        )

        warnings: list[str] = []
        if git_error_code is not None:
            warnings.append(git_error_code)
        if pps_error_code is not None:
            warnings.append(pps_error_code)
        if local_reason_code is not None and local_state == "unknown":
            warnings.append(local_reason_code)
        failure_codes = _collect_failure_codes(
            git_state=git_state,
            pps_state=pps_state,
            local_state=local_state,
            warnings=warnings,
        )
        failure_guidance = map_failure_codes_to_guidance(failure_codes)

        project_rows.append(
            {
                "project_id": project_id,
                "project_name": project_name,
                "root_id": root_id,
                "root_path": root_path,
                "states": {
                    "root": root_state,
                    "git": git_state,
                    "pps": pps_state,
                    "local_metadata": local_state,
                    "local_reason": local_reason_code,
                },
                "pre_sync": {
                    "blocked": pre_sync_conflict is not None,
                    "project_ids": list(pre_sync_conflict.project_ids) if pre_sync_conflict is not None else [],
                },
                "git_status": _serialize_repo_status(repo_status),
                "actions": actions,
                "recommended_actions": list(recommended),
                "warnings": warnings,
                "failure_codes": list(failure_codes),
                "failure_guidance": failure_guidance,
            }
        )
    return project_rows


__all__ = [
    "list_sync_manager_project_statuses",
]
