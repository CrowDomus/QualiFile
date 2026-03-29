"""Service-layer Git Sync actions used by Sync Manager API routes."""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from ...shared.version import get_version
from .git_remote_url import RemoteUrlValidationError, validate_remote_url_policy
from .git_repo_init import (
    GitHelperWarningAckStore,
    ensure_repo_init_defaults,
    evaluate_repo_helper_warning_state,
)
from .git_runner import (
    DEFAULT_GIT_TIMEOUT_SECONDS,
    GitCommandConfigurationError,
    run_git_command,
)
from .git_trust import GitBinaryTrustStore, resolve_trusted_git_binary_path
from .git_workflow import (
    GitWorkflowError,
    RepoSyncStatus,
    export_local_metadata_snapshot,
    run_commit_push_workflow,
    run_import_workflow,
    run_pull_import_workflow,
)
from .lss_store import LocalSyncStateStore
from .pps_import_plan import DEFAULT_LARGE_DELETE_THRESHOLD

_REMOTE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")


class SyncManagerActionError(RuntimeError):
    """Structured action failure surfaced to API routes/UI."""

    def __init__(self, code: str, message: str, *, details: Sequence[str] | None = None):
        super().__init__(message)
        self.code = str(code).strip() or "git-sync-action-failed"
        self.details = tuple(str(item) for item in (details or ()) if str(item).strip())


@dataclass(frozen=True)
class ProjectSyncContext:
    project_id: str
    project_name: str
    root_id: str
    root_path: str
    root_dir: Path


def _normalize_optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        return normalized in {"1", "true", "yes", "on"}
    return bool(value)


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


def _map_git_trust_code(code: str | None) -> str:
    if code == "git-trust-binary-missing":
        return "git-missing"
    if code == "git-trust-reject-relative-path":
        return "git-path-invalid"
    return "git-not-trusted"


def _resolve_trusted_git_binary(conn: sqlite3.Connection, *, project_root: Path) -> str:
    trust_store = GitBinaryTrustStore(conn)
    decision = resolve_trusted_git_binary_path(
        trust_store=trust_store,
        project_root=project_root,
        workspace_roots=_workspace_roots_from_projects(conn),
    )
    resolved = _normalize_optional_text(decision.resolved_path)
    if not decision.allowed or resolved is None:
        mapped = _map_git_trust_code(decision.code)
        if mapped == "git-missing":
            raise SyncManagerActionError(
                mapped,
                "Git executable is unavailable. Install Git and confirm trusted binary configuration.",
            )
        raise SyncManagerActionError(
            mapped,
            "Git executable is unavailable. Configure a trusted absolute Git binary path before running Git Sync.",
        )
    candidate = Path(resolved).expanduser()
    if not candidate.is_absolute():
        raise SyncManagerActionError(
            "git-path-invalid",
            "Git executable path must be absolute.",
        )
    return str(candidate)


def resolve_project_sync_context(conn: sqlite3.Connection, *, project_id: str) -> ProjectSyncContext:
    normalized_project_id = _normalize_optional_text(project_id)
    if normalized_project_id is None:
        raise SyncManagerActionError("invalid", "project_id is required.")

    row = conn.execute(
        """
        SELECT project_id, name, root_id, root_path
        FROM projects
        WHERE project_id = ?
        """,
        (normalized_project_id,),
    ).fetchone()
    if row is None:
        raise SyncManagerActionError("project-not-found", "Project was not found.")

    root_id = _normalize_optional_text(row[2])
    if root_id is None:
        raise SyncManagerActionError("project-root-id-missing", "Project root identity is missing.")

    root_path = _normalize_optional_text(row[3])
    if root_path is None:
        raise SyncManagerActionError("project-no-root", "Project has no linked root folder.")

    root_dir = Path(root_path).expanduser()
    if not root_dir.exists() or not root_dir.is_dir():
        raise SyncManagerActionError("root-unavailable", "Project root folder is unavailable.")

    project_name = _normalize_optional_text(row[1]) or normalized_project_id
    return ProjectSyncContext(
        project_id=normalized_project_id,
        project_name=project_name,
        root_id=root_id,
        root_path=root_path,
        root_dir=root_dir.resolve(),
    )


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
    }


def _serialize_confirmation_context(context: Any) -> Mapping[str, Any] | None:
    if context is None:
        return None
    return {
        "action": context.action,
        "root_id": context.root_id,
        "project_id": context.project_id,
        "local_dirty": context.local_dirty,
        "delete_count": context.delete_count,
        "delete_threshold": context.delete_threshold,
        "requires_large_delete_confirmation": context.requires_large_delete_confirmation,
        "requires_force_import_phrase": context.requires_force_import_phrase,
        "required_force_import_phrase": context.required_force_import_phrase,
        "destructive_labels": list(context.destructive_labels),
        "destructive_reasons": list(context.destructive_reasons),
    }


def _serialize_confirmation_audit(event: Any) -> Mapping[str, Any]:
    return {
        "timestamp_utc": event.timestamp_utc,
        "actor": event.actor,
        "outcome": event.outcome,
        "confirm_apply": event.confirm_apply,
        "confirm_large_delete": event.confirm_large_delete,
        "force_phrase_matched": event.force_phrase_matched,
        "context": _serialize_confirmation_context(event.context),
    }


def export_project_metadata_action(
    conn: sqlite3.Connection,
    *,
    project_id: str,
) -> Mapping[str, Any]:
    context = resolve_project_sync_context(conn, project_id=project_id)
    warnings: list[str] = []
    try:
        manifest = export_local_metadata_snapshot(
            conn,
            root_dir=context.root_dir,
            root_id=context.root_id,
            project_id=context.project_id,
            app_min_version=get_version(),
            on_warning=warnings.append,
        )
    except GitWorkflowError as exc:
        raise SyncManagerActionError(exc.code, str(exc), details=exc.details) from exc

    fingerprint = _normalize_optional_text(manifest.get("snapshot_fingerprint"))
    if fingerprint is not None:
        LocalSyncStateStore(conn).record_export_success(
            context.root_id,
            snapshot_fingerprint=fingerprint,
        )

    return {
        "project_id": context.project_id,
        "root_id": context.root_id,
        "snapshot_fingerprint": fingerprint,
        "entity_counts": dict(manifest.get("entity_counts") or {}),
        "warnings": [str(item) for item in warnings],
    }


def import_project_metadata_action(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    confirm_apply: bool,
    confirm_large_delete: bool = False,
    delete_threshold: int = DEFAULT_LARGE_DELETE_THRESHOLD,
    allow_force_import: bool = False,
    force_import_typed_phrase: str | None = None,
    audit_actor: str | None = None,
) -> Mapping[str, Any]:
    context = resolve_project_sync_context(conn, project_id=project_id)
    git_binary = _resolve_trusted_git_binary(conn, project_root=context.root_dir)
    lss_store = LocalSyncStateStore(conn)
    try:
        result = run_import_workflow(
            conn,
            root_dir=context.root_dir,
            root_id=context.root_id,
            project_id=context.project_id,
            confirm_apply=bool(confirm_apply),
            confirm_large_delete=bool(confirm_large_delete),
            delete_threshold=int(delete_threshold),
            allow_force_import=bool(allow_force_import),
            force_import_typed_phrase=_normalize_optional_text(force_import_typed_phrase),
            lss_store=lss_store,
            git_binary=git_binary,
            audit_actor=_normalize_optional_text(audit_actor),
        )
    except GitWorkflowError as exc:
        raise SyncManagerActionError(exc.code, str(exc), details=exc.details) from exc

    return {
        "project_id": context.project_id,
        "imported": result.imported,
        "local_dirty_before_import": result.local_dirty_before_import,
        "plan_summary": result.plan_summary,
        "warnings": list(result.warnings),
        "marker_conflict_candidates": list(result.marker_conflict_candidates),
        "confirmation_context": _serialize_confirmation_context(result.confirmation_context),
        "confirmation_audit": [_serialize_confirmation_audit(item) for item in result.confirmation_audit],
        "git_status": _serialize_repo_status(result.status),
    }


def init_project_repo_action(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    include_json_eol_rule: bool = True,
    acknowledge_warnings: bool = False,
    warning_codes: Sequence[str] | None = None,
) -> Mapping[str, Any]:
    context = resolve_project_sync_context(conn, project_id=project_id)
    git_binary = _resolve_trusted_git_binary(conn, project_root=context.root_dir)

    try:
        result = run_git_command(
            context.root_dir,
            ("init",),
            git_binary=git_binary,
            timeout_seconds=DEFAULT_GIT_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        raise SyncManagerActionError(
            "git-missing",
            "Git executable is unavailable. Install Git and confirm trusted binary configuration.",
        ) from exc
    except GitCommandConfigurationError as exc:
        code = "git-not-trusted" if exc.kind == "git_not_trusted" else "git-path-invalid"
        raise SyncManagerActionError(
            code,
            "Git executable is unavailable. Configure a trusted absolute Git binary path before running Git Sync.",
        ) from exc

    if not result.ok:
        raise SyncManagerActionError("git-init-failed", "Git repository initialization failed.")

    defaults_result = ensure_repo_init_defaults(
        context.root_dir,
        include_json_eol_rule=_normalize_bool(include_json_eol_rule),
    )

    ack_store = GitHelperWarningAckStore(conn)
    warning_state = evaluate_repo_helper_warning_state(
        context.root_dir,
        ack_store=ack_store,
    )
    if _normalize_bool(acknowledge_warnings):
        requested = [str(item).strip() for item in (warning_codes or warning_state.unacknowledged) if str(item).strip()]
        if requested:
            ack_store.acknowledge(context.root_dir, requested)
        warning_state = evaluate_repo_helper_warning_state(
            context.root_dir,
            ack_store=ack_store,
        )

    return {
        "project_id": context.project_id,
        "repo_initialized": True,
        "gitignore_changed": defaults_result.gitignore_changed,
        "gitattributes_changed": defaults_result.gitattributes_changed,
        "gitattributes_enabled": defaults_result.gitattributes_enabled,
        "helper_warnings": list(warning_state.warnings),
        "helper_warnings_unacknowledged": list(warning_state.unacknowledged),
        "helper_warnings_requires_acknowledgement": warning_state.requires_acknowledgement,
    }


def set_project_remote_action(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    remote_url: str,
    remote_name: str = "origin",
) -> Mapping[str, Any]:
    context = resolve_project_sync_context(conn, project_id=project_id)
    normalized_remote_name = _normalize_optional_text(remote_name) or "origin"
    if not _REMOTE_NAME_RE.fullmatch(normalized_remote_name):
        raise SyncManagerActionError("invalid", "remote_name is invalid.")

    try:
        remote_validation = validate_remote_url_policy(remote_url)
    except RemoteUrlValidationError as exc:
        raise SyncManagerActionError(exc.code, str(exc)) from exc

    if not (context.root_dir / ".git").exists():
        raise SyncManagerActionError("git-repo-not-initialized", "Git repository is not initialized for this root.")

    git_binary = _resolve_trusted_git_binary(conn, project_root=context.root_dir)

    try:
        listed = run_git_command(
            context.root_dir,
            ("remote",),
            git_binary=git_binary,
            timeout_seconds=DEFAULT_GIT_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        raise SyncManagerActionError(
            "git-missing",
            "Git executable is unavailable. Install Git and confirm trusted binary configuration.",
        ) from exc
    except GitCommandConfigurationError as exc:
        code = "git-not-trusted" if exc.kind == "git_not_trusted" else "git-path-invalid"
        raise SyncManagerActionError(
            code,
            "Git executable is unavailable. Configure a trusted absolute Git binary path before running Git Sync.",
        ) from exc

    if not listed.ok:
        raise SyncManagerActionError("git-remote-query-failed", "Unable to inspect Git remotes for this project.")

    existing_remotes = {line.strip() for line in listed.stdout.splitlines() if line.strip()}
    if normalized_remote_name in existing_remotes:
        command = ("remote", "set-url", normalized_remote_name, remote_validation.normalized_url)
    else:
        command = ("remote", "add", normalized_remote_name, remote_validation.normalized_url)

    try:
        applied = run_git_command(
            context.root_dir,
            command,
            git_binary=git_binary,
            timeout_seconds=DEFAULT_GIT_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        raise SyncManagerActionError(
            "git-missing",
            "Git executable is unavailable. Install Git and confirm trusted binary configuration.",
        ) from exc
    except GitCommandConfigurationError as exc:
        code = "git-not-trusted" if exc.kind == "git_not_trusted" else "git-path-invalid"
        raise SyncManagerActionError(
            code,
            "Git executable is unavailable. Configure a trusted absolute Git binary path before running Git Sync.",
        ) from exc
    if not applied.ok:
        raise SyncManagerActionError("git-remote-set-failed", "Failed to configure Git remote for this project.")

    return {
        "project_id": context.project_id,
        "remote_name": normalized_remote_name,
        "remote_url_redacted": remote_validation.redacted_url,
        "has_embedded_credentials": remote_validation.has_embedded_credentials,
    }


def commit_push_project_action(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    commit_message: str,
) -> Mapping[str, Any]:
    context = resolve_project_sync_context(conn, project_id=project_id)
    normalized_commit_message = _normalize_optional_text(commit_message) or "Sync metadata"
    git_binary = _resolve_trusted_git_binary(conn, project_root=context.root_dir)
    lss_store = LocalSyncStateStore(conn)
    try:
        result = run_commit_push_workflow(
            conn,
            root_dir=context.root_dir,
            root_id=context.root_id,
            project_id=context.project_id,
            commit_message=normalized_commit_message,
            app_min_version=get_version(),
            lss_store=lss_store,
            git_binary=git_binary,
        )
    except GitWorkflowError as exc:
        raise SyncManagerActionError(exc.code, str(exc), details=exc.details) from exc

    return {
        "project_id": context.project_id,
        "export_fingerprint": result.export_fingerprint,
        "commit_created": result.commit_created,
        "push_performed": result.push_performed,
        "git_status": _serialize_repo_status(result.status),
    }


def pull_import_project_action(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    confirm_apply: bool,
    confirm_large_delete: bool = False,
    delete_threshold: int = DEFAULT_LARGE_DELETE_THRESHOLD,
    allow_force_import: bool = False,
    force_import_typed_phrase: str | None = None,
    audit_actor: str | None = None,
) -> Mapping[str, Any]:
    context = resolve_project_sync_context(conn, project_id=project_id)
    git_binary = _resolve_trusted_git_binary(conn, project_root=context.root_dir)
    lss_store = LocalSyncStateStore(conn)
    try:
        result = run_pull_import_workflow(
            conn,
            root_dir=context.root_dir,
            root_id=context.root_id,
            project_id=context.project_id,
            confirm_apply=bool(confirm_apply),
            confirm_large_delete=bool(confirm_large_delete),
            delete_threshold=int(delete_threshold),
            allow_force_import=bool(allow_force_import),
            force_import_typed_phrase=_normalize_optional_text(force_import_typed_phrase),
            lss_store=lss_store,
            git_binary=git_binary,
            audit_actor=_normalize_optional_text(audit_actor),
        )
    except GitWorkflowError as exc:
        raise SyncManagerActionError(exc.code, str(exc), details=exc.details) from exc

    return {
        "project_id": context.project_id,
        "pulled": result.pulled,
        "pps_changed": result.pps_changed,
        "imported": result.imported,
        "local_dirty_before_import": result.local_dirty_before_import,
        "pre_pull_fingerprint": result.pre_pull_fingerprint,
        "post_pull_fingerprint": result.post_pull_fingerprint,
        "plan_summary": result.plan_summary,
        "warnings": list(result.warnings),
        "marker_conflict_candidates": list(result.marker_conflict_candidates),
        "confirmation_context": _serialize_confirmation_context(result.confirmation_context),
        "confirmation_audit": [_serialize_confirmation_audit(item) for item in result.confirmation_audit],
        "git_status": _serialize_repo_status(result.status),
    }


__all__ = [
    "ProjectSyncContext",
    "SyncManagerActionError",
    "commit_push_project_action",
    "export_project_metadata_action",
    "import_project_metadata_action",
    "init_project_repo_action",
    "pull_import_project_action",
    "resolve_project_sync_context",
    "set_project_remote_action",
]
