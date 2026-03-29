"""Identity anchoring helpers for discovery and import targeting."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any, Mapping, Sequence


class IdentityAnchorError(RuntimeError):
    """Raised when root/project identity anchoring rules are violated."""

    def __init__(self, code: str, message: str, *, details: Sequence[str] | None = None):
        super().__init__(message)
        self.code = code
        self.details = tuple(details or ())


@dataclass(frozen=True)
class ImportIdentity:
    root_id: str
    project_id: str


@dataclass(frozen=True)
class RootAnchorDecision:
    root_id: str
    target_project_id: str
    local_project_ids: tuple[str, ...]
    is_new_root: bool


def _normalize_required_text(value: Any, *, label: str) -> str:
    text = str(value).strip() if value is not None else ""
    if not text:
        raise ValueError(f"{label} must be a non-empty string.")
    return text


def _load_project_ids_for_root(conn: sqlite3.Connection, *, root_id: str) -> tuple[str, ...]:
    rows = conn.execute(
        """
        SELECT project_id
        FROM projects
        WHERE root_id = ?
        ORDER BY project_id ASC
        """,
        (root_id,),
    ).fetchall()
    return tuple(str(row[0]) for row in rows if row and row[0])


def resolve_local_target_project_for_root(
    conn: sqlite3.Connection,
    *,
    root_id: str,
    fallback_project_id: str,
) -> RootAnchorDecision:
    """Resolve local target project for a root before pull/import safety checks."""

    normalized_root_id = _normalize_required_text(root_id, label="root_id")
    fallback = _normalize_required_text(fallback_project_id, label="fallback_project_id")
    local_project_ids = _load_project_ids_for_root(conn, root_id=normalized_root_id)
    if len(local_project_ids) > 1:
        raise IdentityAnchorError(
            "git-sync-root-id-ambiguous",
            "Git Sync is blocked because multiple local projects claim this root_id.",
            details=[f"root_id={normalized_root_id}", f"project_ids={','.join(local_project_ids)}"],
        )
    if len(local_project_ids) == 1:
        return RootAnchorDecision(
            root_id=normalized_root_id,
            target_project_id=local_project_ids[0],
            local_project_ids=local_project_ids,
            is_new_root=False,
        )
    return RootAnchorDecision(
        root_id=normalized_root_id,
        target_project_id=fallback,
        local_project_ids=tuple(),
        is_new_root=True,
    )


def validate_import_identity(
    *,
    expected_root_id: str,
    manifest: Mapping[str, Any],
    incoming_project: Mapping[str, Any],
) -> ImportIdentity:
    """Validate manifest/project identity fields before import-target resolution."""

    normalized_expected_root_id = _normalize_required_text(expected_root_id, label="expected_root_id")
    manifest_root_id = _normalize_required_text(manifest.get("root_id"), label="manifest.root_id")
    manifest_project_id = _normalize_required_text(manifest.get("project_id"), label="manifest.project_id")
    incoming_root_id = _normalize_required_text(incoming_project.get("root_id"), label="incoming_project.root_id")
    incoming_project_id = _normalize_required_text(incoming_project.get("project_id"), label="incoming_project.project_id")

    if manifest_root_id != normalized_expected_root_id:
        raise IdentityAnchorError(
            "git-sync-import-root-mismatch",
            "Import is blocked because PPS root_id does not match the requested sync root.",
            details=[f"requested_root_id={normalized_expected_root_id}", f"manifest_root_id={manifest_root_id}"],
        )
    if incoming_root_id != manifest_root_id:
        raise IdentityAnchorError(
            "git-sync-import-root-mismatch",
            "Import is blocked because PPS project root_id does not match manifest root_id.",
            details=[f"manifest_root_id={manifest_root_id}", f"incoming_root_id={incoming_root_id}"],
        )
    if incoming_project_id != manifest_project_id:
        raise IdentityAnchorError(
            "git-sync-import-project-mismatch",
            "Import is blocked because PPS project_id does not match manifest project_id.",
            details=[f"manifest_project_id={manifest_project_id}", f"incoming_project_id={incoming_project_id}"],
        )
    return ImportIdentity(root_id=manifest_root_id, project_id=manifest_project_id)


def resolve_import_target_project_for_root(
    conn: sqlite3.Connection,
    *,
    root_id: str,
    incoming_project_id: str,
) -> RootAnchorDecision:
    """Resolve import target project using root_id as canonical anchor."""

    normalized_root_id = _normalize_required_text(root_id, label="root_id")
    normalized_incoming_project_id = _normalize_required_text(incoming_project_id, label="incoming_project_id")
    local_project_ids = _load_project_ids_for_root(conn, root_id=normalized_root_id)

    if len(local_project_ids) > 1:
        raise IdentityAnchorError(
            "git-sync-root-id-ambiguous",
            "Git Sync is blocked because multiple local projects claim this root_id.",
            details=[f"root_id={normalized_root_id}", f"project_ids={','.join(local_project_ids)}"],
        )
    if len(local_project_ids) == 1:
        local_project_id = local_project_ids[0]
        if local_project_id != normalized_incoming_project_id:
            raise IdentityAnchorError(
                "git-sync-identity-mismatch",
                (
                    "Import is blocked by root_id anchoring because incoming PPS project_id does not match "
                    "the existing local project bound to this root."
                ),
                details=[
                    f"root_id={normalized_root_id}",
                    f"local_project_id={local_project_id}",
                    f"incoming_project_id={normalized_incoming_project_id}",
                ],
            )
        return RootAnchorDecision(
            root_id=normalized_root_id,
            target_project_id=local_project_id,
            local_project_ids=local_project_ids,
            is_new_root=False,
        )
    return RootAnchorDecision(
        root_id=normalized_root_id,
        target_project_id=normalized_incoming_project_id,
        local_project_ids=tuple(),
        is_new_root=True,
    )


def resolve_discovery_target_project_for_root(
    conn: sqlite3.Connection,
    *,
    root_id: str,
    discovered_project_id: str,
) -> RootAnchorDecision:
    """Resolve discovery target project using the same root_id anchoring rules."""

    return resolve_import_target_project_for_root(
        conn,
        root_id=root_id,
        incoming_project_id=discovered_project_id,
    )


__all__ = [
    "IdentityAnchorError",
    "ImportIdentity",
    "RootAnchorDecision",
    "resolve_import_target_project_for_root",
    "resolve_discovery_target_project_for_root",
    "resolve_local_target_project_for_root",
    "validate_import_identity",
]
