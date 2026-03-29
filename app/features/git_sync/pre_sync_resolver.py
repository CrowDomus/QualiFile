"""Pre-sync resolver helpers for canonical project selection and detach flow."""

from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from typing import Any, Callable, Sequence


DETACH_WARNING_CODE = "git-sync.pre-sync.detached-local-only"


class PreSyncResolverError(RuntimeError):
    """Raised when pre-sync resolver rules block sync operations."""

    def __init__(self, code: str, message: str, *, details: Sequence[str] | None = None):
        super().__init__(message)
        self.code = code
        self.details = tuple(details or ())


@dataclass(frozen=True)
class PreSyncProjectBinding:
    project_id: str
    root_id: str | None
    root_path: str | None


@dataclass(frozen=True)
class PreSyncConflict:
    root_id: str
    root_path: str | None
    projects: tuple[PreSyncProjectBinding, ...]

    @property
    def project_ids(self) -> tuple[str, ...]:
        return tuple(item.project_id for item in self.projects)


@dataclass(frozen=True)
class PreSyncResolutionResult:
    root_id: str
    root_path: str | None
    canonical_project_id: str
    detached_project_ids: tuple[str, ...]
    warning: str | None


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


def _normalize_path_for_compare(value: str | None) -> str | None:
    normalized = _normalize_optional_text(value)
    if normalized is None:
        return None
    return os.path.normcase(os.path.normpath(normalized))


def _format_detach_warning(*, canonical_project_id: str, detached_project_ids: Sequence[str]) -> str:
    detached = ",".join(sorted(str(project_id) for project_id in detached_project_ids))
    return (
        f"[{DETACH_WARNING_CODE}] Detached projects are now local-only until manually reconciled. "
        f"canonical_project_id={canonical_project_id} detached_project_ids={detached}"
    )


def detect_pre_sync_conflict(
    conn: sqlite3.Connection,
    *,
    root_id: str,
    root_path: str | None,
) -> PreSyncConflict | None:
    """Detect root-level sync conflicts that require canonical selection."""

    normalized_root_id = _normalize_required_text(root_id, label="root_id")
    normalized_root_path = _normalize_optional_text(root_path)
    normalized_compare_path = _normalize_path_for_compare(normalized_root_path)

    rows = conn.execute(
        """
        SELECT project_id, root_id, root_path
        FROM projects
        ORDER BY project_id ASC
        """
    ).fetchall()

    matched: list[PreSyncProjectBinding] = []
    seen: set[str] = set()
    for row in rows:
        project_id = _normalize_optional_text(row[0])
        if project_id is None or project_id in seen:
            continue
        row_root_id = _normalize_optional_text(row[1])
        row_root_path = _normalize_optional_text(row[2])
        same_root_id = row_root_id == normalized_root_id
        same_root_path = (
            normalized_compare_path is not None
            and _normalize_path_for_compare(row_root_path) == normalized_compare_path
        )
        if not same_root_id and not same_root_path:
            continue
        seen.add(project_id)
        matched.append(
            PreSyncProjectBinding(
                project_id=project_id,
                root_id=row_root_id,
                root_path=row_root_path,
            )
        )

    if len(matched) <= 1:
        return None
    return PreSyncConflict(
        root_id=normalized_root_id,
        root_path=normalized_root_path,
        projects=tuple(matched),
    )


def enforce_pre_sync_resolver(
    conn: sqlite3.Connection,
    *,
    root_id: str,
    root_path: str | None,
) -> None:
    """Block sync when duplicate root ownership requires canonical selection."""

    conflict = detect_pre_sync_conflict(conn, root_id=root_id, root_path=root_path)
    if conflict is None:
        return
    raise PreSyncResolverError(
        "git-sync-presync-resolver-required",
        (
            "Git Sync is blocked because multiple local projects share this root_id/root_path. "
            "Choose one canonical project and detach the others before continuing."
        ),
        details=[
            f"root_id={conflict.root_id}",
            f"root_path={conflict.root_path or ''}",
            f"project_ids={','.join(conflict.project_ids)}",
        ],
    )


def resolve_pre_sync_conflict(
    conn: sqlite3.Connection,
    *,
    root_id: str,
    root_path: str | None,
    canonical_project_id: str,
    on_warning: Callable[[str], None] | None = None,
) -> PreSyncResolutionResult:
    """Resolve root conflict by selecting canonical project and detaching others."""

    normalized_root_id = _normalize_required_text(root_id, label="root_id")
    normalized_root_path = _normalize_optional_text(root_path)
    canonical_id = _normalize_required_text(canonical_project_id, label="canonical_project_id")

    conflict = detect_pre_sync_conflict(conn, root_id=normalized_root_id, root_path=normalized_root_path)
    if conflict is None:
        raise PreSyncResolverError(
            "git-sync-presync-no-conflict",
            "No pre-sync conflict exists for this root_id/root_path.",
            details=[f"root_id={normalized_root_id}", f"root_path={normalized_root_path or ''}"],
        )
    if canonical_id not in conflict.project_ids:
        raise PreSyncResolverError(
            "git-sync-presync-canonical-invalid",
            "Canonical project must be one of the conflicting projects for this root.",
            details=[
                f"canonical_project_id={canonical_id}",
                f"project_ids={','.join(conflict.project_ids)}",
            ],
        )

    detached_ids = tuple(project_id for project_id in conflict.project_ids if project_id != canonical_id)
    with conn:
        conn.execute(
            """
            UPDATE projects
            SET root_id = ?, root_path = ?
            WHERE project_id = ?
            """,
            (normalized_root_id, normalized_root_path, canonical_id),
        )
        if detached_ids:
            placeholders = ",".join("?" for _ in detached_ids)
            conn.execute(
                f"""
                UPDATE projects
                SET root_id = NULL, root_path = NULL
                WHERE project_id IN ({placeholders})
                """,
                detached_ids,
            )
            conn.execute(
                f"""
                UPDATE entries
                SET root_id = NULL
                WHERE project_id IN ({placeholders})
                """,
                detached_ids,
            )

    warning = _format_detach_warning(
        canonical_project_id=canonical_id,
        detached_project_ids=detached_ids,
    )
    if detached_ids and on_warning is not None:
        on_warning(warning)
    return PreSyncResolutionResult(
        root_id=normalized_root_id,
        root_path=normalized_root_path,
        canonical_project_id=canonical_id,
        detached_project_ids=detached_ids,
        warning=warning if detached_ids else None,
    )


__all__ = [
    "DETACH_WARNING_CODE",
    "PreSyncConflict",
    "PreSyncProjectBinding",
    "PreSyncResolutionResult",
    "PreSyncResolverError",
    "detect_pre_sync_conflict",
    "enforce_pre_sync_resolver",
    "resolve_pre_sync_conflict",
]
