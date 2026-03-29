"""Local metadata dirty detection and pull/import safety gates for Git Sync."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from .lss_store import LocalSyncState, LocalSyncStateStore
from .pps_import_plan import ImportPlanError, enforce_force_import_phrase
from .pps_fingerprint import FINGERPRINT_ROOT_NAME
from .pps_manifest import ENTRIES_DIRNAME, PROJECT_FILENAME, TAG_DEFINITIONS_DIRNAME
from .pps_serializer import serialize_pps_json


class DirtyStateError(RuntimeError):
    """Raised when local dirty-state evaluation or safety gating fails."""

    def __init__(self, code: str, message: str, *, details: Sequence[str] | None = None):
        super().__init__(message)
        self.code = code
        self.details = tuple(details or ())


@dataclass(frozen=True)
class DirtyStateResult:
    is_dirty: bool
    reason_code: str
    local_metadata_fingerprint: str
    baseline_fingerprints: tuple[str, ...]


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
        show_header = row[4]
        payloads.append(
            {
                "id": row[0],
                "root_id": row[1],
                "name": row[2],
                "color": row[3],
                "show_header": None if show_header is None else bool(show_header),
                "parent_id": row[5],
            }
        )
    return payloads


def _decode_entry_payload(payload_json: Any) -> dict[str, Any]:
    if not isinstance(payload_json, str) or not payload_json.strip():
        return {}
    try:
        decoded = json.loads(payload_json)
    except Exception:
        return {}
    if isinstance(decoded, Mapping):
        return dict(decoded)
    return {}


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


def _fingerprint_records_for_payloads(
    *,
    project_payload: Mapping[str, Any] | None,
    tag_payloads: Sequence[Mapping[str, Any]],
    entry_payloads: Sequence[Mapping[str, Any]],
) -> list[tuple[str, int, str]]:
    records: list[tuple[str, int, str]] = []

    def _append_record(relpath: str, payload: Mapping[str, Any]) -> None:
        serialized = serialize_pps_json(payload)
        normalized_relpath = relpath.replace("\\", "/")
        records.append(
            (
                f"{FINGERPRINT_ROOT_NAME}/{normalized_relpath}",
                len(serialized),
                hashlib.sha256(serialized).hexdigest(),
            )
        )

    if project_payload is not None:
        _append_record(PROJECT_FILENAME, project_payload)
    for payload in tag_payloads:
        tag_id = _normalize_required_text(payload.get("id"), label="tag.id")
        _append_record(f"{TAG_DEFINITIONS_DIRNAME}/{tag_id}.json", payload)
    for payload in entry_payloads:
        entry_id = _normalize_required_text(payload.get("id"), label="entry.id")
        _append_record(f"{ENTRIES_DIRNAME}/{entry_id}.json", payload)
    records.sort(key=lambda item: item[0].encode("utf-8"))
    return records


def _hash_fingerprint_stream(records: Sequence[tuple[str, int, str]]) -> str:
    stream = bytearray()
    for relpath, size, digest in records:
        stream.extend(relpath.encode("utf-8"))
        stream.extend(b"\0")
        stream.extend(str(size).encode("utf-8"))
        stream.extend(b"\0")
        stream.extend(digest.encode("utf-8"))
        stream.extend(b"\n")
    return hashlib.sha256(bytes(stream)).hexdigest()


def _normalize_baseline_fingerprints(state: LocalSyncState) -> tuple[str, ...]:
    ordered: list[str] = []
    for value in (state.last_export_fingerprint, state.last_import_fingerprint):
        normalized = _normalize_optional_text(value)
        if normalized and normalized not in ordered:
            ordered.append(normalized)
    return tuple(ordered)


def _resolve_lss_state(
    *,
    root_id: str,
    lss_state: LocalSyncState | None,
    lss_store: LocalSyncStateStore | None,
) -> LocalSyncState:
    if lss_state is not None:
        resolved = lss_state
    elif lss_store is not None:
        resolved = lss_store.get_state(root_id)
    else:
        raise ValueError("Either lss_state or lss_store must be provided.")

    normalized_state_root = _normalize_required_text(resolved.root_id, label="lss_state.root_id")
    if normalized_state_root != root_id:
        raise DirtyStateError(
            "dirty-lss-root-mismatch",
            "LSS state root_id does not match the requested root_id.",
            details=[f"state_root_id={normalized_state_root}", f"requested_root_id={root_id}"],
        )
    return resolved


def compute_local_metadata_fingerprint(
    conn: sqlite3.Connection,
    *,
    root_id: str,
    project_id: str,
) -> str:
    """Compute deterministic local DB fingerprint aligned with PPS entity layout."""

    normalized_root_id = _normalize_required_text(root_id, label="root_id")
    normalized_project_id = _normalize_required_text(project_id, label="project_id")

    project_payload = _load_project_payload(conn, project_id=normalized_project_id)
    if project_payload is not None:
        project_root_id = _normalize_optional_text(project_payload.get("root_id"))
        if project_root_id is not None and project_root_id != normalized_root_id:
            raise DirtyStateError(
                "dirty-project-root-mismatch",
                "Project root_id does not match the requested root_id.",
                details=[f"project_root_id={project_root_id}", f"requested_root_id={normalized_root_id}"],
            )

    records = _fingerprint_records_for_payloads(
        project_payload=project_payload,
        tag_payloads=_load_tag_payloads(conn, root_id=normalized_root_id),
        entry_payloads=_load_entry_payloads(conn, project_id=normalized_project_id),
    )
    return _hash_fingerprint_stream(records)


def evaluate_local_metadata_dirty(
    conn: sqlite3.Connection,
    *,
    root_id: str,
    project_id: str,
    lss_state: LocalSyncState | None = None,
    lss_store: LocalSyncStateStore | None = None,
) -> DirtyStateResult:
    """Evaluate whether local metadata diverged from the latest exported/imported baseline."""

    normalized_root_id = _normalize_required_text(root_id, label="root_id")
    normalized_project_id = _normalize_required_text(project_id, label="project_id")
    resolved_state = _resolve_lss_state(root_id=normalized_root_id, lss_state=lss_state, lss_store=lss_store)

    local_fingerprint = compute_local_metadata_fingerprint(
        conn,
        root_id=normalized_root_id,
        project_id=normalized_project_id,
    )
    baselines = _normalize_baseline_fingerprints(resolved_state)
    if not baselines:
        return DirtyStateResult(
            is_dirty=True,
            reason_code="dirty-baseline-missing",
            local_metadata_fingerprint=local_fingerprint,
            baseline_fingerprints=tuple(),
        )
    if local_fingerprint in baselines:
        return DirtyStateResult(
            is_dirty=False,
            reason_code="clean-fingerprint-match",
            local_metadata_fingerprint=local_fingerprint,
            baseline_fingerprints=baselines,
        )
    return DirtyStateResult(
        is_dirty=True,
        reason_code="dirty-fingerprint-mismatch",
        local_metadata_fingerprint=local_fingerprint,
        baseline_fingerprints=baselines,
    )


def enforce_pull_import_safety_gate(
    conn: sqlite3.Connection,
    *,
    root_id: str,
    project_id: str,
    lss_state: LocalSyncState | None = None,
    lss_store: LocalSyncStateStore | None = None,
    allow_export_first: bool = False,
    allow_force_import: bool = False,
    force_import_typed_phrase: str | None = None,
) -> DirtyStateResult:
    """Enforce pull/import blocking when local metadata is dirty."""

    result = evaluate_local_metadata_dirty(
        conn,
        root_id=root_id,
        project_id=project_id,
        lss_state=lss_state,
        lss_store=lss_store,
    )
    if not result.is_dirty:
        return result
    if allow_force_import:
        normalized_project_id = _normalize_required_text(project_id, label="project_id")
        try:
            enforce_force_import_phrase(
                project_id=normalized_project_id,
                typed_confirmation=force_import_typed_phrase,
            )
        except ImportPlanError as exc:
            raise DirtyStateError(
                "pull-import-force-confirmation-required",
                "Pull & Import force override requires exact typed confirmation (`IMPORT <project_id>`).",
                details=exc.details,
            ) from exc
        return result

    details = [
        f"reason={result.reason_code}",
        f"root_id={_normalize_required_text(root_id, label='root_id')}",
        f"project_id={_normalize_required_text(project_id, label='project_id')}",
    ]
    if allow_export_first:
        raise DirtyStateError(
            "pull-import-export-required",
            "Pull & Import is blocked because local metadata is dirty. Export and commit local metadata first.",
            details=details,
        )
    raise DirtyStateError(
        "pull-import-dirty-local",
        "Pull & Import is blocked because local metadata has unexported changes.",
        details=details,
    )


__all__ = [
    "DirtyStateError",
    "DirtyStateResult",
    "compute_local_metadata_fingerprint",
    "enforce_pull_import_safety_gate",
    "evaluate_local_metadata_dirty",
]
