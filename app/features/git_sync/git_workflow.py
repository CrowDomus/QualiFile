"""Git Sync workflow orchestration for status, commit/push, and pull/import."""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .git_runner import (
    DEFAULT_GIT_TIMEOUT_SECONDS,
    GitCommandConfigurationError,
    GitCommandResult,
    run_git_command,
    summarize_git_failure,
)
from .identity_anchor import (
    IdentityAnchorError,
    resolve_import_target_project_for_root,
    resolve_local_target_project_for_root,
    validate_import_identity,
)
from .pre_sync_resolver import PreSyncResolverError, enforce_pre_sync_resolver
from .lss_dirty_gate import DirtyStateError, DirtyStateResult, enforce_pull_import_safety_gate
from .lss_store import LocalSyncStateStore
from .pps_export_swap import ACTIVE_DIRNAME, export_pps_snapshot_with_swap
from .pps_import_apply import ImportApplyError, apply_import_plan_transactionally
from .pps_import_gates import ImportGateError, run_import_preflight_gates
from .pps_import_plan import (
    DEFAULT_LARGE_DELETE_THRESHOLD,
    ImportPlanError,
    build_import_plan,
    enforce_import_plan_confirmation,
    is_force_import_phrase_match,
    load_pps_snapshot_entities,
    required_force_import_phrase,
)
from .pps_manifest import MANIFEST_FILENAME, load_manifest

_STATUS_BRANCH_RE = re.compile(
    r"^## (?P<branch>.+?)(?:\.\.\.(?P<upstream>[^\s]+))?(?: \[(?P<divergence>[^\]]+)\])?$"
)
_AHEAD_RE = re.compile(r"ahead (\d+)")
_BEHIND_RE = re.compile(r"behind (\d+)")

_UNMERGED_STATUS_CODES = {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}
_ROOT_MARKER_FILENAMES = {".qualifile_root.json", ".qualifile_meta.json"}

_AUTH_FAILURE_MARKERS = (
    "authentication failed",
    "could not read username",
    "permission denied (publickey)",
    "access denied",
    "authorization failed",
    "credential",
)
_NETWORK_FAILURE_MARKERS = (
    "could not resolve host",
    "failed to connect",
    "network is unreachable",
    "connection timed out",
    "connection reset",
    "couldn't connect",
    "unable to access",
    "tls",
    "ssl",
)
_NOTHING_TO_COMMIT_MARKERS = (
    "nothing to commit",
    "no changes added to commit",
    "working tree clean",
)
_PUSH_UPSTREAM_MISSING_MARKERS = (
    "has no upstream branch",
    "no configured push destination",
    "set-upstream",
    "set upstream",
)
_PULL_TRACKING_MISSING_MARKERS = (
    "there is no tracking information for the current branch",
    "no tracking information for the current branch",
    "please specify which branch you want to merge with",
)
_FF_ONLY_MARKERS = (
    "not possible to fast-forward",
    "not possible to fast forward",
    "cannot fast-forward",
    "cannot fast forward",
    "--ff-only",
)

GitRunner = Callable[[Path, Sequence[str]], GitCommandResult]
WarningCallback = Callable[[str], None]
ConfirmationAuditCallback = Callable[["DestructiveConfirmationAudit"], None]


class GitWorkflowError(RuntimeError):
    """Raised when Git Sync workflow orchestration fails."""

    def __init__(self, code: str, message: str, *, details: Sequence[str] | None = None):
        super().__init__(message)
        self.code = code
        self.details = tuple(details or ())


@dataclass(frozen=True)
class LocalFileChangeCounts:
    modified: int = 0
    added: int = 0
    deleted: int = 0
    untracked: int = 0


@dataclass(frozen=True)
class RepoSyncStatus:
    branch: str | None
    upstream: str | None
    ahead: int
    behind: int
    is_dirty: bool
    pps_dirty: bool
    unmerged_pps_paths: tuple[str, ...]
    local_files: LocalFileChangeCounts = field(default_factory=LocalFileChangeCounts)


@dataclass(frozen=True)
class CommitPushResult:
    export_fingerprint: str
    commit_created: bool
    push_performed: bool
    status: RepoSyncStatus | None


@dataclass(frozen=True)
class PullImportResult:
    pulled: bool
    pps_changed: bool
    imported: bool
    local_dirty_before_import: bool
    pre_pull_fingerprint: str | None
    post_pull_fingerprint: str | None
    plan_summary: Mapping[str, Any] | None
    warnings: tuple[str, ...]
    marker_conflict_candidates: tuple[str, ...]
    confirmation_context: "DestructiveConfirmationContext | None"
    confirmation_audit: tuple["DestructiveConfirmationAudit", ...]
    status: RepoSyncStatus | None


@dataclass(frozen=True)
class ImportResult:
    imported: bool
    local_dirty_before_import: bool
    plan_summary: Mapping[str, Any] | None
    warnings: tuple[str, ...]
    marker_conflict_candidates: tuple[str, ...]
    confirmation_context: "DestructiveConfirmationContext | None"
    confirmation_audit: tuple["DestructiveConfirmationAudit", ...]
    status: RepoSyncStatus | None


@dataclass(frozen=True)
class DestructiveConfirmationContext:
    action: str
    root_id: str
    project_id: str
    local_dirty: bool
    delete_count: int
    delete_threshold: int
    requires_large_delete_confirmation: bool
    requires_force_import_phrase: bool
    required_force_import_phrase: str | None
    destructive_labels: tuple[str, ...]
    destructive_reasons: tuple[str, ...]


@dataclass(frozen=True)
class DestructiveConfirmationAudit:
    timestamp_utc: str
    actor: str | None
    outcome: str
    confirm_apply: bool
    confirm_large_delete: bool
    force_phrase_matched: bool
    context: DestructiveConfirmationContext


def _normalize_required_text(value: Any, *, label: str) -> str:
    text = str(value).strip() if value is not None else ""
    if not text:
        raise ValueError(f"{label} must be a non-empty string.")
    return text


def _normalize_optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _resolve_root_dir(root_dir: Path | str) -> Path:
    resolved = Path(root_dir).expanduser().resolve()
    if not resolved.exists() or not resolved.is_dir():
        raise GitWorkflowError(
            "git-repo-root-invalid",
            f"Git repo root is invalid: {resolved}",
            details=[str(resolved)],
        )
    return resolved


def _default_git_runner(*, git_binary: Path | str, timeout_seconds: float) -> GitRunner:
    def _runner(root: Path, args: Sequence[str]) -> GitCommandResult:
        return run_git_command(
            root,
            args,
            git_binary=git_binary,
            timeout_seconds=timeout_seconds,
        )

    return _runner


def _resolve_git_runner(
    *,
    run_git: GitRunner | None,
    git_binary: Path | str | None,
    timeout_seconds: float,
) -> GitRunner:
    if run_git is not None:
        return run_git
    binary_text = _normalize_optional_text(git_binary)
    if binary_text is None:
        raise GitWorkflowError(
            "git-not-trusted",
            "Git executable is unavailable. Configure a trusted absolute Git binary path before running Git Sync.",
        )
    binary_path = Path(binary_text).expanduser()
    if not binary_path.is_absolute():
        raise GitWorkflowError(
            "git-path-invalid",
            "Git executable path must be absolute.",
        )
    return _default_git_runner(git_binary=str(binary_path), timeout_seconds=timeout_seconds)


def _command_text(args: Sequence[str]) -> str:
    return " ".join(str(item) for item in args)


def _matches_any_marker(text: str, markers: Sequence[str]) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in markers)


def _raise_git_result_error(
    *,
    args: Sequence[str],
    result: GitCommandResult,
    default_code: str,
    default_message: str,
) -> None:
    combined = f"{result.stderr}\n{result.stdout}".strip()
    summary = summarize_git_failure(result)
    details = [
        f"command={_command_text(args)}",
        f"exit_code={result.exit_code}",
        f"summary={summary}",
    ]

    if _matches_any_marker(combined, _FF_ONLY_MARKERS):
        raise GitWorkflowError(
            "git-pull-non-fast-forward",
            "Pull & Import requires a fast-forward pull. Resolve branch divergence in Git, then retry.",
            details=details,
        )
    if _matches_any_marker(combined, _AUTH_FAILURE_MARKERS):
        raise GitWorkflowError(
            "git-auth-failed",
            "Git authentication failed. Configure SSH keys or a system credential helper, then retry.",
            details=details,
        )
    if _matches_any_marker(combined, _NETWORK_FAILURE_MARKERS):
        raise GitWorkflowError(
            "git-network-failed",
            "Git network operation failed. Check connectivity/remote reachability, then retry.",
            details=details,
        )
    raise GitWorkflowError(default_code, default_message, details=details)


def _run_git_or_raise(
    run_git: GitRunner,
    root: Path,
    args: Sequence[str],
    *,
    default_code: str,
    default_message: str,
) -> GitCommandResult:
    result = _invoke_git(
        run_git,
        root,
        args,
        default_code=default_code,
        default_message=default_message,
    )
    if not result.ok:
        _raise_git_result_error(
            args=args,
            result=result,
            default_code=default_code,
            default_message=default_message,
        )
    return result


def _invoke_git(
    run_git: GitRunner,
    root: Path,
    args: Sequence[str],
    *,
    default_code: str,
    default_message: str,
) -> GitCommandResult:
    try:
        result = run_git(root, args)
    except FileNotFoundError as exc:
        raise GitWorkflowError(
            "git-missing",
            "Git executable is unavailable. Install Git and confirm trusted binary configuration.",
            details=[_command_text(args), type(exc).__name__],
        ) from exc
    except GitCommandConfigurationError as exc:
        code = "git-not-trusted" if exc.kind == "git_not_trusted" else "git-path-invalid"
        raise GitWorkflowError(
            code,
            "Git executable is unavailable. Configure a trusted absolute Git binary path before running Git Sync.",
            details=[_command_text(args), exc.kind],
        ) from exc
    except GitWorkflowError:
        raise
    except Exception as exc:  # pragma: no cover - defensive safety net
        raise GitWorkflowError(
            default_code,
            default_message,
            details=[_command_text(args), type(exc).__name__, str(exc)],
        ) from exc
    return result


def _result_combined_text(result: GitCommandResult) -> str:
    return f"{result.stderr}\n{result.stdout}"


def _is_missing_push_upstream(result: GitCommandResult) -> bool:
    return _matches_any_marker(_result_combined_text(result), _PUSH_UPSTREAM_MISSING_MARKERS)


def _is_missing_pull_tracking(result: GitCommandResult) -> bool:
    return _matches_any_marker(_result_combined_text(result), _PULL_TRACKING_MISSING_MARKERS)


def _list_git_remotes(run_git: GitRunner, root: Path) -> tuple[str, ...]:
    result = _invoke_git(
        run_git,
        root,
        ("remote",),
        default_code="git-remote-query-failed",
        default_message="Unable to inspect Git remotes for this project.",
    )
    if not result.ok:
        _raise_git_result_error(
            args=("remote",),
            result=result,
            default_code="git-remote-query-failed",
            default_message="Unable to inspect Git remotes for this project.",
        )
    remotes = {line.strip() for line in result.stdout.splitlines() if line.strip()}
    return tuple(sorted(remotes))


def _select_remote_for_sync(run_git: GitRunner, root: Path, *, action_label: str) -> str:
    remotes = _list_git_remotes(run_git, root)
    if "origin" in remotes:
        return "origin"
    if len(remotes) == 1:
        return remotes[0]
    if not remotes:
        raise GitWorkflowError(
            "git-remote-missing",
            f"{action_label} requires a configured Git remote. Set remote first, then retry.",
            details=["command=remote", "summary=no configured remotes"],
        )
    raise GitWorkflowError(
        "git-remote-ambiguous",
        f"{action_label} found multiple Git remotes. Select/set remote and retry.",
        details=[f"remotes={','.join(remotes)}", "guidance=Select/set remote"],
    )


def _resolve_current_branch_for_pull(run_git: GitRunner, root: Path) -> str:
    status = _safe_repo_status(root, run_git=run_git)
    if status is not None and status.branch is not None:
        return status.branch

    result = _invoke_git(
        run_git,
        root,
        ("rev-parse", "--abbrev-ref", "HEAD"),
        default_code="git-pull-failed",
        default_message="Git pull failed during Pull & Import.",
    )
    if not result.ok:
        _raise_git_result_error(
            args=("rev-parse", "--abbrev-ref", "HEAD"),
            result=result,
            default_code="git-pull-failed",
            default_message="Git pull failed during Pull & Import.",
        )

    branch = _normalize_optional_text(result.stdout.splitlines()[0] if result.stdout.splitlines() else None)
    if branch is None or branch == "HEAD":
        raise GitWorkflowError(
            "git-branch-detached",
            "Pull & Import requires a checked-out branch. Check out a branch and retry.",
            details=["command=rev-parse --abbrev-ref HEAD", "summary=detached HEAD"],
        )
    return branch


def _run_push_with_upstream_retry(run_git: GitRunner, root: Path) -> None:
    push_args = ("push",)
    push_result = _invoke_git(
        run_git,
        root,
        push_args,
        default_code="git-push-failed",
        default_message="Git push failed during Commit & Push.",
    )
    if push_result.ok:
        return
    if _is_missing_push_upstream(push_result):
        remote = _select_remote_for_sync(run_git, root, action_label="Commit & Push")
        retry_args = ("push", "-u", remote, "HEAD")
        retry_result = _invoke_git(
            run_git,
            root,
            retry_args,
            default_code="git-push-failed",
            default_message="Git push failed during Commit & Push.",
        )
        if retry_result.ok:
            return
        _raise_git_result_error(
            args=retry_args,
            result=retry_result,
            default_code="git-push-failed",
            default_message="Git push failed during Commit & Push.",
        )
    _raise_git_result_error(
        args=push_args,
        result=push_result,
        default_code="git-push-failed",
        default_message="Git push failed during Commit & Push.",
    )


def _run_ff_only_pull_with_tracking_retry(run_git: GitRunner, root: Path) -> None:
    pull_args = ("pull", "--ff-only")
    pull_result = _invoke_git(
        run_git,
        root,
        pull_args,
        default_code="git-pull-failed",
        default_message="Git pull failed during Pull & Import.",
    )
    if pull_result.ok:
        return
    if _is_missing_pull_tracking(pull_result):
        remote = _select_remote_for_sync(run_git, root, action_label="Pull & Import")
        branch = _resolve_current_branch_for_pull(run_git, root)
        retry_args = ("pull", "--ff-only", remote, branch)
        retry_result = _invoke_git(
            run_git,
            root,
            retry_args,
            default_code="git-pull-failed",
            default_message="Git pull failed during Pull & Import.",
        )
        if retry_result.ok:
            return
        _raise_git_result_error(
            args=retry_args,
            result=retry_result,
            default_code="git-pull-failed",
            default_message="Git pull failed during Pull & Import.",
        )
    _raise_git_result_error(
        args=pull_args,
        result=pull_result,
        default_code="git-pull-failed",
        default_message="Git pull failed during Pull & Import.",
    )


def _parse_branch_header(line: str) -> tuple[str | None, str | None, int, int]:
    match = _STATUS_BRANCH_RE.match(line.strip())
    if not match:
        return None, None, 0, 0

    branch_raw = _normalize_optional_text(match.group("branch"))
    branch = branch_raw if branch_raw not in {None, "HEAD (no branch)", "HEAD"} else None
    upstream = _normalize_optional_text(match.group("upstream"))

    divergence = _normalize_optional_text(match.group("divergence")) or ""
    ahead_match = _AHEAD_RE.search(divergence)
    behind_match = _BEHIND_RE.search(divergence)
    ahead = int(ahead_match.group(1)) if ahead_match else 0
    behind = int(behind_match.group(1)) if behind_match else 0
    return branch, upstream, ahead, behind


def _normalize_status_path(raw_path: str) -> str:
    normalized = raw_path.strip().replace("\\", "/")
    if " -> " in normalized:
        normalized = normalized.split(" -> ", 1)[1].strip()
    while normalized.startswith("./"):
        normalized = normalized[2:]
    if normalized.startswith("/"):
        normalized = normalized[1:]
    return normalized


def _is_pps_path(path: str) -> bool:
    return path == ACTIVE_DIRNAME or path.startswith(f"{ACTIVE_DIRNAME}/")


def _is_internal_workspace_status_path(path: str) -> bool:
    normalized = path.strip().replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    if normalized.startswith("/"):
        normalized = normalized[1:]
    if not normalized:
        return False
    lowered = normalized.lower()
    if lowered == ".git" or lowered.startswith(".git/"):
        return True
    active_dir = ACTIVE_DIRNAME.lower()
    if lowered == active_dir or lowered.startswith(f"{active_dir}/"):
        return True
    basename = lowered.rsplit("/", 1)[-1]
    if basename in _ROOT_MARKER_FILENAMES:
        return True
    if (basename.startswith(".qualifile_root.json.") or basename.startswith(".qualifile_meta.json.")) and basename.endswith(
        (".tmp", ".bak")
    ):
        return True
    if basename.startswith(".qualifile_sync") and basename.endswith((".tmp", ".bak")):
        return True
    return False


def _workspace_change_bucket(status_code: str) -> str:
    if status_code == "??":
        return "untracked"
    if "D" in status_code:
        return "deleted"
    if "A" in status_code:
        return "added"
    return "modified"


def _parse_repo_status(stdout: str) -> RepoSyncStatus:
    branch: str | None = None
    upstream: str | None = None
    ahead = 0
    behind = 0
    is_dirty = False
    pps_dirty = False
    unmerged_pps_paths: set[str] = set()
    local_modified = 0
    local_added = 0
    local_deleted = 0
    local_untracked = 0

    lines = stdout.splitlines()
    for index, raw_line in enumerate(lines):
        line = raw_line.rstrip()
        if not line:
            continue
        if index == 0 and line.startswith("## "):
            branch, upstream, ahead, behind = _parse_branch_header(line)
            continue
        if len(line) < 3:
            continue

        status_code = line[:2]
        path = _normalize_status_path(line[3:])
        if not path:
            continue

        is_dirty = True
        is_pps = _is_pps_path(path)
        if is_pps:
            pps_dirty = True
        if status_code in _UNMERGED_STATUS_CODES and is_pps:
            unmerged_pps_paths.add(path)
        if not _is_internal_workspace_status_path(path):
            bucket = _workspace_change_bucket(status_code)
            if bucket == "modified":
                local_modified += 1
            elif bucket == "added":
                local_added += 1
            elif bucket == "deleted":
                local_deleted += 1
            elif bucket == "untracked":
                local_untracked += 1

    return RepoSyncStatus(
        branch=branch,
        upstream=upstream,
        ahead=ahead,
        behind=behind,
        is_dirty=is_dirty,
        pps_dirty=pps_dirty,
        unmerged_pps_paths=tuple(sorted(unmerged_pps_paths)),
        local_files=LocalFileChangeCounts(
            modified=local_modified,
            added=local_added,
            deleted=local_deleted,
            untracked=local_untracked,
        ),
    )


def _safe_repo_status(
    root: Path,
    *,
    run_git: GitRunner,
) -> RepoSyncStatus | None:
    try:
        return get_repo_sync_status(root, run_git=run_git)
    except GitWorkflowError:
        return None


def _load_manifest_fingerprint_if_present(root: Path) -> str | None:
    snapshot_dir = root / ACTIVE_DIRNAME
    manifest_path = snapshot_dir / MANIFEST_FILENAME
    if not manifest_path.exists():
        return None
    try:
        manifest = load_manifest(snapshot_dir)
    except Exception:
        return None
    return _normalize_optional_text(manifest.get("snapshot_fingerprint"))


def _extract_required_manifest_fingerprint(manifest: Mapping[str, Any]) -> str:
    fingerprint = _normalize_optional_text(manifest.get("snapshot_fingerprint"))
    if fingerprint is None:
        raise GitWorkflowError(
            "git-sync-export-invalid-manifest",
            "Export completed but manifest is missing snapshot_fingerprint.",
        )
    return fingerprint


def _load_project_payload(conn: sqlite3.Connection, *, project_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT project_id, root_id, name, description, parent_id, root_path,
               status, color, entry_mode, created_at, updated_at
        FROM projects
        WHERE project_id = ?
        """,
        (project_id,),
    ).fetchone()
    if not row:
        return None
    return {
        "project_id": row[0],
        "root_id": row[1],
        "name": row[2],
        "description": row[3],
        "parent_id": row[4],
        "root_path": row[5],
        "status": row[6],
        "color": row[7],
        "entry_mode": row[8],
        "created_at": row[9],
        "updated_at": row[10],
    }


def _load_tag_payloads(conn: sqlite3.Connection, *, root_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT tag_id, root_id, name, color, show_header, parent_id
        FROM tag_definitions
        WHERE root_id = ?
        ORDER BY tag_id ASC
        """,
        (root_id,),
    ).fetchall()
    payloads: list[dict[str, Any]] = []
    for row in rows:
        payloads.append(
            {
                "id": row[0],
                "root_id": row[1],
                "name": row[2],
                "color": row[3],
                "show_header": None if row[4] is None else bool(row[4]),
                "parent_id": row[5],
            }
        )
    return payloads


def _decode_entry_payload(payload_json: Any) -> dict[str, Any]:
    if not isinstance(payload_json, str) or not payload_json.strip():
        return {}
    try:
        payload = json.loads(payload_json)
    except Exception:
        return {}
    return dict(payload) if isinstance(payload, Mapping) else {}


def _load_entry_payloads(conn: sqlite3.Connection, *, project_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT entry_id, project_id, root_id, kind, payload_json, created_at, updated_at
        FROM entries
        WHERE project_id = ?
        ORDER BY entry_id ASC
        """,
        (project_id,),
    ).fetchall()
    payloads: list[dict[str, Any]] = []
    for row in rows:
        payload = _decode_entry_payload(row[4])
        payload.setdefault("id", row[0])
        payload.setdefault("project_id", row[1])
        payload.setdefault("root_id", row[2])
        payload.setdefault("kind", row[3])
        payload.setdefault("created_at", row[5])
        payload.setdefault("updated_at", row[6])
        payloads.append(payload)
    return payloads


def _record_lss_error(
    *,
    lss_store: LocalSyncStateStore | None,
    root_id: str,
    code: str,
    message: str,
) -> None:
    if lss_store is None:
        return
    try:
        lss_store.record_error(root_id, kind=code, message=message)
    except Exception:
        return


def _capture_warning(
    warning: str,
    *,
    sink: list[str],
    on_warning: WarningCallback | None,
) -> None:
    sink.append(str(warning))
    if on_warning is not None:
        on_warning(str(warning))


def _coerce_warning_tuple(items: Sequence[str]) -> tuple[str, ...]:
    deduped: list[str] = []
    for item in items:
        normalized = str(item).strip()
        if not normalized or normalized in deduped:
            continue
        deduped.append(normalized)
    return tuple(deduped)


def _build_destructive_confirmation_context(
    *,
    root_id: str,
    project_id: str,
    local_dirty: bool,
    plan_delete_count: int,
    delete_threshold: int,
) -> DestructiveConfirmationContext:
    large_delete_required = plan_delete_count > delete_threshold
    force_phrase_required = local_dirty or large_delete_required
    destructive_reasons: list[str] = []
    destructive_labels: list[str] = []
    if local_dirty:
        destructive_reasons.append("dirty-local")
        destructive_labels.append("Force Import (destructive)")
    if large_delete_required:
        destructive_reasons.append("large-delete-threshold")
        destructive_labels.append("Large Delete (destructive)")
    return DestructiveConfirmationContext(
        action="pull-import",
        root_id=root_id,
        project_id=project_id,
        local_dirty=local_dirty,
        delete_count=plan_delete_count,
        delete_threshold=delete_threshold,
        requires_large_delete_confirmation=large_delete_required,
        requires_force_import_phrase=force_phrase_required,
        required_force_import_phrase=required_force_import_phrase(project_id) if force_phrase_required else None,
        destructive_labels=tuple(destructive_labels),
        destructive_reasons=tuple(destructive_reasons),
    )


def _build_destructive_confirmation_audit(
    *,
    context: DestructiveConfirmationContext,
    confirm_apply: bool,
    confirm_large_delete: bool,
    force_import_typed_phrase: str | None,
    outcome: str,
    actor: str | None,
) -> DestructiveConfirmationAudit:
    return DestructiveConfirmationAudit(
        timestamp_utc=_utc_now_iso(),
        actor=_normalize_optional_text(actor),
        outcome=outcome,
        confirm_apply=bool(confirm_apply),
        confirm_large_delete=bool(confirm_large_delete),
        force_phrase_matched=is_force_import_phrase_match(
            project_id=context.project_id,
            typed_confirmation=force_import_typed_phrase,
        ),
        context=context,
    )


def _emit_destructive_confirmation_audit(
    event: DestructiveConfirmationAudit,
    *,
    on_confirmation_audit: ConfirmationAuditCallback | None,
) -> None:
    if on_confirmation_audit is None:
        return
    try:
        on_confirmation_audit(event)
    except Exception:
        return


def _map_import_error(exc: Exception) -> GitWorkflowError:
    if isinstance(exc, GitWorkflowError):
        return exc
    if isinstance(exc, PreSyncResolverError):
        return GitWorkflowError(exc.code, str(exc), details=exc.details)
    if isinstance(exc, IdentityAnchorError):
        return GitWorkflowError(exc.code, str(exc), details=exc.details)
    if isinstance(exc, DirtyStateError):
        return GitWorkflowError(exc.code, str(exc), details=exc.details)
    if isinstance(exc, ImportGateError):
        return GitWorkflowError(exc.code, str(exc), details=exc.details)
    if isinstance(exc, ImportPlanError):
        return GitWorkflowError(exc.code, str(exc), details=exc.details)
    if isinstance(exc, ImportApplyError):
        return GitWorkflowError(exc.code, str(exc), details=exc.details)
    return GitWorkflowError("git-sync-pull-import-failed", str(exc))


def _is_nothing_to_commit(result: GitCommandResult) -> bool:
    combined = f"{result.stdout}\n{result.stderr}"
    return _matches_any_marker(combined, _NOTHING_TO_COMMIT_MARKERS)


def get_repo_sync_status(
    root_dir: Path | str,
    *,
    run_git: GitRunner | None = None,
    git_binary: Path | str | None = None,
    timeout_seconds: float = DEFAULT_GIT_TIMEOUT_SECONDS,
) -> RepoSyncStatus:
    """Return per-root Git status summary used by Sync Manager."""

    root = _resolve_root_dir(root_dir)
    runner = _resolve_git_runner(run_git=run_git, git_binary=git_binary, timeout_seconds=timeout_seconds)
    result = _run_git_or_raise(
        runner,
        root,
        ("status", "--porcelain", "--branch"),
        default_code="git-status-failed",
        default_message="Unable to read Git status for this root.",
    )
    return _parse_repo_status(result.stdout)


def export_local_metadata_snapshot(
    conn: sqlite3.Connection,
    *,
    root_dir: Path | str,
    root_id: str,
    project_id: str,
    app_min_version: str,
    nonce: str | None = None,
    on_warning: WarningCallback | None = None,
) -> Mapping[str, Any]:
    """Export local DB project/tag/entry metadata into PPS using swap-safe export."""

    root = _resolve_root_dir(root_dir)
    normalized_root_id = _normalize_required_text(root_id, label="root_id")
    normalized_project_id = _normalize_required_text(project_id, label="project_id")
    min_version = _normalize_required_text(app_min_version, label="app_min_version")
    root_path = str(root)

    try:
        enforce_pre_sync_resolver(
            conn,
            root_id=normalized_root_id,
            root_path=root_path,
        )
    except PreSyncResolverError as exc:
        raise GitWorkflowError(exc.code, str(exc), details=exc.details) from exc

    project = _load_project_payload(conn, project_id=normalized_project_id)
    if project is None:
        raise GitWorkflowError(
            "git-sync-export-project-missing",
            "Cannot export metadata because the target project does not exist locally.",
            details=[f"project_id={normalized_project_id}"],
        )

    project_root_id = _normalize_optional_text(project.get("root_id"))
    if project_root_id is not None and project_root_id != normalized_root_id:
        raise GitWorkflowError(
            "git-sync-export-root-mismatch",
            "Cannot export metadata because project root_id does not match the requested sync root.",
            details=[f"project_root_id={project_root_id}", f"requested_root_id={normalized_root_id}"],
        )

    try:
        return export_pps_snapshot_with_swap(
            root,
            root_id=normalized_root_id,
            project_id=normalized_project_id,
            project=project,
            tag_definitions=_load_tag_payloads(conn, root_id=normalized_root_id),
            entries=_load_entry_payloads(conn, project_id=normalized_project_id),
            app_min_version=min_version,
            nonce=nonce,
            on_warning=on_warning,
        )
    except GitWorkflowError:
        raise
    except Exception as exc:
        raise GitWorkflowError(
            "git-sync-export-failed",
            "Metadata export failed before Git commit/push.",
            details=[type(exc).__name__, str(exc)],
        ) from exc


def run_commit_push_workflow(
    conn: sqlite3.Connection,
    *,
    root_dir: Path | str,
    root_id: str,
    project_id: str,
    commit_message: str,
    app_min_version: str,
    lss_store: LocalSyncStateStore | None = None,
    run_git: GitRunner | None = None,
    git_binary: Path | str | None = None,
    timeout_seconds: float = DEFAULT_GIT_TIMEOUT_SECONDS,
    export_snapshot: Callable[[], Mapping[str, Any]] | None = None,
    on_warning: WarningCallback | None = None,
) -> CommitPushResult:
    """Run Export -> Git add/commit/push orchestration for one sync root."""

    root = _resolve_root_dir(root_dir)
    normalized_root_id = _normalize_required_text(root_id, label="root_id")
    normalized_commit_message = _normalize_required_text(commit_message, label="commit_message")

    warnings: list[str] = []
    capture_warning = lambda msg: _capture_warning(msg, sink=warnings, on_warning=on_warning)
    export_fn = export_snapshot or (
        lambda: export_local_metadata_snapshot(
            conn,
            root_dir=root,
            root_id=normalized_root_id,
            project_id=project_id,
            app_min_version=app_min_version,
            on_warning=capture_warning,
        )
    )

    try:
        runner = _resolve_git_runner(run_git=run_git, git_binary=git_binary, timeout_seconds=timeout_seconds)
        enforce_pre_sync_resolver(
            conn,
            root_id=normalized_root_id,
            root_path=str(root),
        )

        try:
            manifest = export_fn()
        except GitWorkflowError:
            raise
        except Exception as exc:
            raise GitWorkflowError(
                "git-sync-export-failed",
                "Metadata export failed before Git commit/push.",
                details=[type(exc).__name__, str(exc)],
            ) from exc
        export_fingerprint = _extract_required_manifest_fingerprint(manifest)
        if lss_store is not None:
            lss_store.record_export_success(normalized_root_id, snapshot_fingerprint=export_fingerprint)

        _run_git_or_raise(
            runner,
            root,
            ("add", "--all"),
            default_code="git-add-failed",
            default_message="Git add failed during Commit & Push.",
        )

        try:
            commit_result = runner(root, ("commit", "-m", normalized_commit_message))
        except FileNotFoundError as exc:
            raise GitWorkflowError(
                "git-missing",
                "Git executable is unavailable. Install Git and confirm trusted binary configuration.",
                details=["commit", type(exc).__name__],
            ) from exc
        except Exception as exc:  # pragma: no cover - defensive safety net
            raise GitWorkflowError(
                "git-commit-failed",
                "Git commit failed during Commit & Push.",
                details=[type(exc).__name__, str(exc)],
            ) from exc

        if commit_result.ok:
            commit_created = True
        elif _is_nothing_to_commit(commit_result):
            commit_created = False
        else:
            _raise_git_result_error(
                args=("commit", "-m", normalized_commit_message),
                result=commit_result,
                default_code="git-commit-failed",
                default_message="Git commit failed during Commit & Push.",
            )

        _run_push_with_upstream_retry(runner, root)

        return CommitPushResult(
            export_fingerprint=export_fingerprint,
            commit_created=commit_created,
            push_performed=True,
            status=_safe_repo_status(root, run_git=runner),
        )
    except GitWorkflowError as exc:
        _record_lss_error(
            lss_store=lss_store,
            root_id=normalized_root_id,
            code=exc.code,
            message=str(exc),
        )
        raise
    except PreSyncResolverError as exc:
        mapped = GitWorkflowError(exc.code, str(exc), details=exc.details)
        _record_lss_error(
            lss_store=lss_store,
            root_id=normalized_root_id,
            code=mapped.code,
            message=str(mapped),
        )
        raise mapped from exc


def run_import_workflow(
    conn: sqlite3.Connection,
    *,
    root_dir: Path | str,
    root_id: str,
    project_id: str,
    confirm_apply: bool,
    confirm_large_delete: bool = False,
    delete_threshold: int = DEFAULT_LARGE_DELETE_THRESHOLD,
    allow_force_import: bool = False,
    force_import_typed_phrase: str | None = None,
    lss_store: LocalSyncStateStore | None = None,
    run_git: GitRunner | None = None,
    git_binary: Path | str | None = None,
    timeout_seconds: float = DEFAULT_GIT_TIMEOUT_SECONDS,
    on_warning: WarningCallback | None = None,
    on_confirmation_audit: ConfirmationAuditCallback | None = None,
    audit_actor: str | None = None,
) -> ImportResult:
    """Run import-only orchestration with mandatory preflight and safety gates."""

    root = _resolve_root_dir(root_dir)
    normalized_root_id = _normalize_required_text(root_id, label="root_id")
    normalized_project_id = _normalize_required_text(project_id, label="project_id")

    warnings: list[str] = []
    capture_warning = lambda msg: _capture_warning(msg, sink=warnings, on_warning=on_warning)

    try:
        runner = _resolve_git_runner(run_git=run_git, git_binary=git_binary, timeout_seconds=timeout_seconds)
        enforce_pre_sync_resolver(
            conn,
            root_id=normalized_root_id,
            root_path=str(root),
        )
        local_target = resolve_local_target_project_for_root(
            conn,
            root_id=normalized_root_id,
            fallback_project_id=normalized_project_id,
        )
        dirty_state = enforce_pull_import_safety_gate(
            conn,
            root_id=normalized_root_id,
            project_id=local_target.target_project_id,
            lss_store=lss_store,
            allow_force_import=allow_force_import,
            force_import_typed_phrase=force_import_typed_phrase,
        )

        def _gate_runner(repo_root: Path, args: Sequence[str]) -> tuple[int, str, str]:
            try:
                result = runner(repo_root, args)
            except FileNotFoundError as exc:
                raise GitWorkflowError(
                    "git-missing",
                    "Git executable is unavailable. Install Git and confirm trusted binary configuration.",
                    details=[_command_text(args), type(exc).__name__],
                ) from exc
            except GitCommandConfigurationError as exc:
                code = "git-not-trusted" if exc.kind == "git_not_trusted" else "git-path-invalid"
                raise GitWorkflowError(
                    code,
                    "Git executable is unavailable. Configure a trusted absolute Git binary path before running Git Sync.",
                    details=[_command_text(args), exc.kind],
                ) from exc
            except Exception as exc:
                raise GitWorkflowError(
                    "git-conflict-check-failed",
                    "Unable to evaluate PPS conflict state.",
                    details=[_command_text(args), type(exc).__name__, str(exc)],
                ) from exc
            return result.exit_code, result.stdout, result.stderr

        gate_result = run_import_preflight_gates(
            root,
            run_git=_gate_runner,
            on_warning=capture_warning,
        )

        incoming_project, incoming_tags, incoming_entries = load_pps_snapshot_entities(root / ACTIVE_DIRNAME)
        incoming_identity = validate_import_identity(
            expected_root_id=normalized_root_id,
            manifest=gate_result.manifest,
            incoming_project=incoming_project,
        )
        import_target = resolve_import_target_project_for_root(
            conn,
            root_id=incoming_identity.root_id,
            incoming_project_id=incoming_identity.project_id,
        )
        plan = build_import_plan(
            incoming_project=incoming_project,
            incoming_tags=incoming_tags,
            incoming_entries=incoming_entries,
            local_project=_load_project_payload(conn, project_id=import_target.target_project_id),
            local_tags=_load_tag_payloads(conn, root_id=normalized_root_id),
            local_entries=_load_entry_payloads(conn, project_id=import_target.target_project_id),
        )
        confirmation_context = _build_destructive_confirmation_context(
            root_id=normalized_root_id,
            project_id=import_target.target_project_id,
            local_dirty=dirty_state.is_dirty,
            plan_delete_count=plan.total_delete_count,
            delete_threshold=delete_threshold,
        )
        confirmation_audit: list[DestructiveConfirmationAudit] = []
        try:
            enforce_import_plan_confirmation(
                plan,
                confirm_apply=confirm_apply,
                confirm_large_delete=confirm_large_delete,
                delete_threshold=delete_threshold,
                require_force_import_phrase=confirmation_context.requires_force_import_phrase,
                force_import_project_id=import_target.target_project_id,
                force_import_typed_phrase=force_import_typed_phrase,
            )
        except ImportPlanError:
            blocked_event = _build_destructive_confirmation_audit(
                context=confirmation_context,
                confirm_apply=confirm_apply,
                confirm_large_delete=confirm_large_delete,
                force_import_typed_phrase=force_import_typed_phrase,
                outcome="blocked",
                actor=audit_actor,
            )
            confirmation_audit.append(blocked_event)
            _emit_destructive_confirmation_audit(
                blocked_event,
                on_confirmation_audit=on_confirmation_audit,
            )
            raise

        passed_event = _build_destructive_confirmation_audit(
            context=confirmation_context,
            confirm_apply=confirm_apply,
            confirm_large_delete=confirm_large_delete,
            force_import_typed_phrase=force_import_typed_phrase,
            outcome="passed",
            actor=audit_actor,
        )
        confirmation_audit.append(passed_event)
        _emit_destructive_confirmation_audit(
            passed_event,
            on_confirmation_audit=on_confirmation_audit,
        )

        apply_result = apply_import_plan_transactionally(
            conn,
            plan,
            incoming_project=incoming_project,
            incoming_tags=incoming_tags,
            incoming_entries=incoming_entries,
            on_warning=capture_warning,
        )
        warnings.extend(apply_result.warnings)

        imported_fingerprint = _normalize_optional_text(gate_result.manifest.get("snapshot_fingerprint"))
        if imported_fingerprint and lss_store is not None:
            lss_store.record_import_success(normalized_root_id, snapshot_fingerprint=imported_fingerprint)

        return ImportResult(
            imported=True,
            local_dirty_before_import=dirty_state.is_dirty,
            plan_summary=plan.summary(),
            warnings=_coerce_warning_tuple(warnings),
            marker_conflict_candidates=gate_result.marker_conflict_candidates,
            confirmation_context=confirmation_context,
            confirmation_audit=tuple(confirmation_audit),
            status=_safe_repo_status(root, run_git=runner),
        )
    except Exception as exc:
        mapped = _map_import_error(exc)
        _record_lss_error(
            lss_store=lss_store,
            root_id=normalized_root_id,
            code=mapped.code,
            message=str(mapped),
        )
        raise mapped from exc


def run_pull_import_workflow(
    conn: sqlite3.Connection,
    *,
    root_dir: Path | str,
    root_id: str,
    project_id: str,
    confirm_apply: bool,
    confirm_large_delete: bool = False,
    delete_threshold: int = DEFAULT_LARGE_DELETE_THRESHOLD,
    allow_force_import: bool = False,
    force_import_typed_phrase: str | None = None,
    lss_store: LocalSyncStateStore | None = None,
    run_git: GitRunner | None = None,
    git_binary: Path | str | None = None,
    timeout_seconds: float = DEFAULT_GIT_TIMEOUT_SECONDS,
    on_warning: WarningCallback | None = None,
    on_confirmation_audit: ConfirmationAuditCallback | None = None,
    audit_actor: str | None = None,
) -> PullImportResult:
    """Run Pull --ff-only and import orchestration with mandatory safety gates."""

    root = _resolve_root_dir(root_dir)
    normalized_root_id = _normalize_required_text(root_id, label="root_id")
    normalized_project_id = _normalize_required_text(project_id, label="project_id")

    warnings: list[str] = []
    capture_warning = lambda msg: _capture_warning(msg, sink=warnings, on_warning=on_warning)

    try:
        runner = _resolve_git_runner(run_git=run_git, git_binary=git_binary, timeout_seconds=timeout_seconds)
        enforce_pre_sync_resolver(
            conn,
            root_id=normalized_root_id,
            root_path=str(root),
        )
        local_target = resolve_local_target_project_for_root(
            conn,
            root_id=normalized_root_id,
            fallback_project_id=normalized_project_id,
        )
        dirty_state = enforce_pull_import_safety_gate(
            conn,
            root_id=normalized_root_id,
            project_id=local_target.target_project_id,
            lss_store=lss_store,
            allow_force_import=allow_force_import,
            force_import_typed_phrase=force_import_typed_phrase,
        )

        pre_pull_fingerprint = _load_manifest_fingerprint_if_present(root)
        _run_ff_only_pull_with_tracking_retry(runner, root)
        post_pull_fingerprint = _load_manifest_fingerprint_if_present(root)
        pps_changed = pre_pull_fingerprint != post_pull_fingerprint
        if not pps_changed:
            return PullImportResult(
                pulled=True,
                pps_changed=False,
                imported=False,
                local_dirty_before_import=dirty_state.is_dirty,
                pre_pull_fingerprint=pre_pull_fingerprint,
                post_pull_fingerprint=post_pull_fingerprint,
                plan_summary=None,
                warnings=_coerce_warning_tuple(warnings),
                marker_conflict_candidates=tuple(),
                confirmation_context=None,
                confirmation_audit=tuple(),
                status=_safe_repo_status(root, run_git=runner),
            )

        def _gate_runner(repo_root: Path, args: Sequence[str]) -> tuple[int, str, str]:
            try:
                result = runner(repo_root, args)
            except FileNotFoundError as exc:
                raise GitWorkflowError(
                    "git-missing",
                    "Git executable is unavailable. Install Git and confirm trusted binary configuration.",
                    details=[_command_text(args), type(exc).__name__],
                ) from exc
            except GitCommandConfigurationError as exc:
                code = "git-not-trusted" if exc.kind == "git_not_trusted" else "git-path-invalid"
                raise GitWorkflowError(
                    code,
                    "Git executable is unavailable. Configure a trusted absolute Git binary path before running Git Sync.",
                    details=[_command_text(args), exc.kind],
                ) from exc
            except Exception as exc:
                raise GitWorkflowError(
                    "git-conflict-check-failed",
                    "Unable to evaluate PPS conflict state.",
                    details=[_command_text(args), type(exc).__name__, str(exc)],
                ) from exc
            return result.exit_code, result.stdout, result.stderr

        gate_result = run_import_preflight_gates(
            root,
            run_git=_gate_runner,
            on_warning=capture_warning,
        )

        incoming_project, incoming_tags, incoming_entries = load_pps_snapshot_entities(root / ACTIVE_DIRNAME)
        incoming_identity = validate_import_identity(
            expected_root_id=normalized_root_id,
            manifest=gate_result.manifest,
            incoming_project=incoming_project,
        )
        import_target = resolve_import_target_project_for_root(
            conn,
            root_id=incoming_identity.root_id,
            incoming_project_id=incoming_identity.project_id,
        )
        plan = build_import_plan(
            incoming_project=incoming_project,
            incoming_tags=incoming_tags,
            incoming_entries=incoming_entries,
            local_project=_load_project_payload(conn, project_id=import_target.target_project_id),
            local_tags=_load_tag_payloads(conn, root_id=normalized_root_id),
            local_entries=_load_entry_payloads(conn, project_id=import_target.target_project_id),
        )
        confirmation_context = _build_destructive_confirmation_context(
            root_id=normalized_root_id,
            project_id=import_target.target_project_id,
            local_dirty=dirty_state.is_dirty,
            plan_delete_count=plan.total_delete_count,
            delete_threshold=delete_threshold,
        )
        confirmation_audit: list[DestructiveConfirmationAudit] = []
        try:
            enforce_import_plan_confirmation(
                plan,
                confirm_apply=confirm_apply,
                confirm_large_delete=confirm_large_delete,
                delete_threshold=delete_threshold,
                require_force_import_phrase=confirmation_context.requires_force_import_phrase,
                force_import_project_id=import_target.target_project_id,
                force_import_typed_phrase=force_import_typed_phrase,
            )
        except ImportPlanError:
            blocked_event = _build_destructive_confirmation_audit(
                context=confirmation_context,
                confirm_apply=confirm_apply,
                confirm_large_delete=confirm_large_delete,
                force_import_typed_phrase=force_import_typed_phrase,
                outcome="blocked",
                actor=audit_actor,
            )
            confirmation_audit.append(blocked_event)
            _emit_destructive_confirmation_audit(
                blocked_event,
                on_confirmation_audit=on_confirmation_audit,
            )
            raise

        passed_event = _build_destructive_confirmation_audit(
            context=confirmation_context,
            confirm_apply=confirm_apply,
            confirm_large_delete=confirm_large_delete,
            force_import_typed_phrase=force_import_typed_phrase,
            outcome="passed",
            actor=audit_actor,
        )
        confirmation_audit.append(passed_event)
        _emit_destructive_confirmation_audit(
            passed_event,
            on_confirmation_audit=on_confirmation_audit,
        )

        apply_result = apply_import_plan_transactionally(
            conn,
            plan,
            incoming_project=incoming_project,
            incoming_tags=incoming_tags,
            incoming_entries=incoming_entries,
            on_warning=capture_warning,
        )
        warnings.extend(apply_result.warnings)

        imported_fingerprint = _normalize_optional_text(gate_result.manifest.get("snapshot_fingerprint"))
        if imported_fingerprint and lss_store is not None:
            lss_store.record_import_success(normalized_root_id, snapshot_fingerprint=imported_fingerprint)

        return PullImportResult(
            pulled=True,
            pps_changed=True,
            imported=True,
            local_dirty_before_import=dirty_state.is_dirty,
            pre_pull_fingerprint=pre_pull_fingerprint,
            post_pull_fingerprint=post_pull_fingerprint,
            plan_summary=plan.summary(),
            warnings=_coerce_warning_tuple(warnings),
            marker_conflict_candidates=gate_result.marker_conflict_candidates,
            confirmation_context=confirmation_context,
            confirmation_audit=tuple(confirmation_audit),
            status=_safe_repo_status(root, run_git=runner),
        )
    except Exception as exc:  # Keep mapped codes/details from gate/import helpers.
        mapped = _map_import_error(exc)
        _record_lss_error(
            lss_store=lss_store,
            root_id=normalized_root_id,
            code=mapped.code,
            message=str(mapped),
        )
        raise mapped from exc


__all__ = [
    "CommitPushResult",
    "DestructiveConfirmationAudit",
    "DestructiveConfirmationContext",
    "GitWorkflowError",
    "ImportResult",
    "LocalFileChangeCounts",
    "PullImportResult",
    "RepoSyncStatus",
    "export_local_metadata_snapshot",
    "get_repo_sync_status",
    "run_commit_push_workflow",
    "run_import_workflow",
    "run_pull_import_workflow",
]
