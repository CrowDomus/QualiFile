"""Windows-safe sibling temp snapshot export and swap helpers."""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence
from uuid import uuid4

from .pps_manifest import DEFAULT_FINGERPRINT_ALGO, export_pps_snapshot
from .pps_serializer import write_pps_json

ACTIVE_DIRNAME = ".qualifile_sync"
TEMP_DIR_PREFIX = ".qualifile_sync.tmp-"
BAK_DIR_PREFIX = ".qualifile_sync.bak-"
RECOVERY_WARNING_CLEANUP_FAILED = "git-sync.recovery.cleanup-failed"
RECOVERY_WARNING_PROMOTE_TEMP_FAILED = "git-sync.recovery.promote-temp-failed"
RECOVERY_WARNING_RESTORE_BACKUP_FAILED = "git-sync.recovery.restore-backup-failed"
SWAP_WARNING_RENAME_TEMP_FAILED = "git-sync.swap.rename-temp-failed"
SWAP_WARNING_ROLLBACK_FAILED = "git-sync.swap.rollback-failed"
SWAP_WARNING_CLEANUP_BAK_FAILED = "git-sync.swap.cleanup-bak-failed"

_WARNING_MESSAGES: dict[str, str] = {
    RECOVERY_WARNING_CLEANUP_FAILED: "Recovery cleanup failed for stale snapshot artifacts.",
    RECOVERY_WARNING_PROMOTE_TEMP_FAILED: "Recovery could not promote the newest temp snapshot to active state.",
    RECOVERY_WARNING_RESTORE_BACKUP_FAILED: "Recovery could not restore the newest backup snapshot to active state.",
    SWAP_WARNING_RENAME_TEMP_FAILED: "Swap failed while moving staged temp snapshot into active location.",
    SWAP_WARNING_ROLLBACK_FAILED: "Swap rollback failed while restoring the previous active snapshot.",
    SWAP_WARNING_CLEANUP_BAK_FAILED: "Swap finished but cleanup of backup snapshot failed.",
}


@dataclass(frozen=True)
class RecoveryResult:
    action: str
    promoted_from: str | None
    removed_artifacts: tuple[str, ...]
    cleanup_errors: tuple[str, ...]


def warning_message_for_code(code: str) -> str:
    """Return deterministic operator-facing text for a warning code."""

    return _WARNING_MESSAGES.get(code, "Unknown Git Sync swap/recovery warning.")


def format_swap_warning(code: str, *, artifact: str | None = None, detail: str | None = None) -> str:
    """Build a stable warning string for UI/support surfaces."""

    message = warning_message_for_code(code)
    payload = [f"[{code}] {message}"]
    if artifact:
        payload.append(f"artifact={artifact}")
    if detail:
        payload.append(f"detail={detail}")
    return " | ".join(payload)


def _emit_warning(
    *,
    code: str,
    artifact: str | None,
    detail: str | None,
    on_warning: Callable[[str], None] | None,
) -> str:
    warning = format_swap_warning(code, artifact=artifact, detail=detail)
    if on_warning is not None:
        on_warning(warning)
    return warning


def _volume_key(path: Path) -> str:
    resolved = path.resolve()
    anchor = resolved.anchor or resolved.drive or "/"
    return anchor.lower()


def build_swap_paths(root_dir: Path | str, *, nonce: str | None = None) -> tuple[Path, Path, Path]:
    """Build active/temp/backup PPS paths for a root folder."""

    root = Path(root_dir).expanduser().resolve()
    suffix = (nonce or uuid4().hex[:8]).strip()
    if not suffix:
        raise ValueError("Swap nonce must not be empty.")

    active_dir = root / ACTIVE_DIRNAME
    temp_dir = root / f"{TEMP_DIR_PREFIX}{suffix}"
    bak_dir = root / f"{BAK_DIR_PREFIX}{suffix}"
    return active_dir, temp_dir, bak_dir


def validate_swap_paths(root_dir: Path | str, active_dir: Path, temp_dir: Path, bak_dir: Path) -> None:
    """Validate swap paths are sibling directories on the same volume."""

    root = Path(root_dir).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise ValueError("Root path must exist and be a directory.")

    for path in (active_dir, temp_dir, bak_dir):
        if path.parent.resolve() != root:
            raise ValueError("Swap paths must be direct children of the root directory.")

    volumes = {_volume_key(root), _volume_key(active_dir), _volume_key(temp_dir), _volume_key(bak_dir)}
    if len(volumes) != 1:
        raise ValueError("Swap paths must be on the same volume.")


def _artifact_candidates(root: Path, prefix: str) -> list[Path]:
    return sorted(
        [candidate for candidate in root.glob(f"{prefix}*") if candidate.exists()],
        key=lambda path: path.name,
    )


def _select_newest(candidates: Sequence[Path]) -> Path:
    if not candidates:
        raise ValueError("No candidates provided.")
    return max(candidates, key=lambda path: (path.stat().st_mtime_ns, path.name))


def _remove_artifact(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()


def _cleanup_artifacts(
    paths: Sequence[Path],
    *,
    on_event: Callable[[str], None] | None,
    on_warning: Callable[[str], None] | None,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    removed: list[str] = []
    warnings: list[str] = []
    for artifact in paths:
        if not artifact.exists():
            continue
        try:
            _remove_artifact(artifact)
            removed.append(artifact.name)
        except Exception as exc:
            warning = _emit_warning(
                code=RECOVERY_WARNING_CLEANUP_FAILED,
                artifact=artifact.name,
                detail=type(exc).__name__,
                on_warning=on_warning,
            )
            warnings.append(warning)
            if on_event is not None:
                on_event("recovery-cleanup-failed")
    return tuple(sorted(removed)), tuple(warnings)


def recover_snapshot_artifacts(
    root_dir: Path | str,
    *,
    on_event: Callable[[str], None] | None = None,
    on_warning: Callable[[str], None] | None = None,
) -> RecoveryResult:
    """Reconcile stale PPS swap artifacts using deterministic precedence."""

    root = Path(root_dir).expanduser().resolve()
    active_dir = root / ACTIVE_DIRNAME
    temp_candidates = _artifact_candidates(root, TEMP_DIR_PREFIX)
    bak_candidates = _artifact_candidates(root, BAK_DIR_PREFIX)

    action = "no-artifacts"
    promoted_from: str | None = None
    removed_artifacts: tuple[str, ...] = tuple()
    cleanup_errors: tuple[str, ...] = tuple()

    if on_event is not None:
        on_event("recovery-begin")

    if active_dir.exists():
        action = "active-authoritative"
        removed_artifacts, cleanup_errors = _cleanup_artifacts(
            [*temp_candidates, *bak_candidates],
            on_event=on_event,
            on_warning=on_warning,
        )
    elif temp_candidates:
        newest_temp = _select_newest(temp_candidates)
        if on_event is not None:
            on_event("recovery-promote-temp")
        try:
            newest_temp.rename(active_dir)
        except Exception as exc:
            _emit_warning(
                code=RECOVERY_WARNING_PROMOTE_TEMP_FAILED,
                artifact=newest_temp.name,
                detail=type(exc).__name__,
                on_warning=on_warning,
            )
            raise
        action = "promoted-temp"
        promoted_from = newest_temp.name
        remaining = [candidate for candidate in temp_candidates if candidate != newest_temp]
        removed_artifacts, cleanup_errors = _cleanup_artifacts(
            [*remaining, *bak_candidates],
            on_event=on_event,
            on_warning=on_warning,
        )
    elif bak_candidates:
        newest_bak = _select_newest(bak_candidates)
        if on_event is not None:
            on_event("recovery-restore-backup")
        try:
            newest_bak.rename(active_dir)
        except Exception as exc:
            _emit_warning(
                code=RECOVERY_WARNING_RESTORE_BACKUP_FAILED,
                artifact=newest_bak.name,
                detail=type(exc).__name__,
                on_warning=on_warning,
            )
            raise
        action = "restored-backup"
        promoted_from = newest_bak.name
        remaining = [candidate for candidate in bak_candidates if candidate != newest_bak]
        removed_artifacts, cleanup_errors = _cleanup_artifacts(
            remaining,
            on_event=on_event,
            on_warning=on_warning,
        )

    if on_event is not None:
        on_event("recovery-complete")

    return RecoveryResult(
        action=action,
        promoted_from=promoted_from,
        removed_artifacts=removed_artifacts,
        cleanup_errors=cleanup_errors,
    )


def swap_snapshot_directories(
    active_dir: Path,
    temp_dir: Path,
    bak_dir: Path,
    *,
    on_event: Callable[[str], None] | None = None,
    on_warning: Callable[[str], None] | None = None,
) -> None:
    """Swap staged PPS snapshot into active location with rollback on rename failure."""

    if not temp_dir.exists():
        raise FileNotFoundError(f"Staged temp snapshot is missing: {temp_dir}")
    if bak_dir.exists():
        raise FileExistsError(f"Backup path already exists: {bak_dir}")

    had_active = active_dir.exists()
    if had_active:
        if on_event is not None:
            on_event("rename-active-to-bak")
        active_dir.rename(bak_dir)

    try:
        if on_event is not None:
            on_event("rename-tmp-to-active")
        temp_dir.rename(active_dir)
    except Exception as exc:
        _emit_warning(
            code=SWAP_WARNING_RENAME_TEMP_FAILED,
            artifact=temp_dir.name,
            detail=type(exc).__name__,
            on_warning=on_warning,
        )
        if had_active and bak_dir.exists() and not active_dir.exists():
            try:
                if on_event is not None:
                    on_event("rollback-bak-to-active")
                bak_dir.rename(active_dir)
            except Exception as rollback_exc:
                _emit_warning(
                    code=SWAP_WARNING_ROLLBACK_FAILED,
                    artifact=bak_dir.name,
                    detail=type(rollback_exc).__name__,
                    on_warning=on_warning,
                )
        raise

    if bak_dir.exists():
        try:
            if on_event is not None:
                on_event("cleanup-bak")
            shutil.rmtree(bak_dir)
        except Exception as exc:
            _emit_warning(
                code=SWAP_WARNING_CLEANUP_BAK_FAILED,
                artifact=bak_dir.name,
                detail=type(exc).__name__,
                on_warning=on_warning,
            )
            if on_event is not None:
                on_event("cleanup-bak-failed")


def export_pps_snapshot_with_swap(
    root_dir: Path | str,
    *,
    root_id: str,
    project_id: str,
    project: Mapping[str, Any],
    app_min_version: str,
    tag_definitions: Sequence[Mapping[str, Any]] | None = None,
    entries: Sequence[Mapping[str, Any]] | None = None,
    snapshot_fingerprint: str | None = None,
    fingerprint_algo: str = DEFAULT_FINGERPRINT_ALGO,
    created_at: str | None = None,
    exported_at: str | None = None,
    warnings: Sequence[str] | None = None,
    nonce: str | None = None,
    write_json: Callable[[Path | str, Any], None] = write_pps_json,
    on_event: Callable[[str], None] | None = None,
    on_warning: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Export PPS snapshot to sibling temp dir then perform crash-safe rename chain swap."""

    root = Path(root_dir).expanduser().resolve()
    recover_snapshot_artifacts(root, on_event=on_event, on_warning=on_warning)
    active_dir, temp_dir, bak_dir = build_swap_paths(root, nonce=nonce)
    validate_swap_paths(root, active_dir, temp_dir, bak_dir)

    if temp_dir.exists() or bak_dir.exists():
        raise FileExistsError("Temp or backup swap path already exists for this nonce.")

    if on_event is not None:
        on_event("stage-export")
    manifest = export_pps_snapshot(
        temp_dir,
        root_id=root_id,
        project_id=project_id,
        project=project,
        tag_definitions=tag_definitions,
        entries=entries,
        snapshot_fingerprint=snapshot_fingerprint,
        app_min_version=app_min_version,
        fingerprint_algo=fingerprint_algo,
        created_at=created_at,
        exported_at=exported_at,
        warnings=warnings,
        write_json=write_json,
    )
    if on_event is not None:
        on_event("stage-complete")

    swap_snapshot_directories(active_dir, temp_dir, bak_dir, on_event=on_event, on_warning=on_warning)
    return manifest


__all__ = [
    "ACTIVE_DIRNAME",
    "BAK_DIR_PREFIX",
    "RECOVERY_WARNING_CLEANUP_FAILED",
    "RECOVERY_WARNING_PROMOTE_TEMP_FAILED",
    "RECOVERY_WARNING_RESTORE_BACKUP_FAILED",
    "RecoveryResult",
    "SWAP_WARNING_CLEANUP_BAK_FAILED",
    "SWAP_WARNING_RENAME_TEMP_FAILED",
    "SWAP_WARNING_ROLLBACK_FAILED",
    "TEMP_DIR_PREFIX",
    "build_swap_paths",
    "export_pps_snapshot_with_swap",
    "format_swap_warning",
    "recover_snapshot_artifacts",
    "swap_snapshot_directories",
    "validate_swap_paths",
    "warning_message_for_code",
]
