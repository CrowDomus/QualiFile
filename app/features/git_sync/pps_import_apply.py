"""Transactional PPS import apply helpers with best-effort alert cleanup."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

from .pps_import_plan import EntityChangeSet, ImportPlan

IMPORT_WARNING_ALERT_CLEANUP_FAILED = "git-sync.import.alert-cleanup-failed"
IMPORT_WARNING_PARENT_FALLBACK = "git-sync.import.parent-fallback"
_ENTRY_KINDS = {"note", "task"}
_PROJECT_ID_KEYS = ("project_id", "id")
_PROJECT_TS_KEYS = ("created_at", "updated_at")


class ImportApplyError(RuntimeError):
    """Raised when transactional PPS import apply fails."""

    def __init__(self, code: str, message: str, *, details: Sequence[str] | None = None):
        super().__init__(message)
        self.code = code
        self.details = tuple(details or ())


@dataclass(frozen=True)
class ImportApplyResult:
    deleted_task_ids: tuple[str, ...]
    alert_cleanup_warning: str | None = None
    warnings: tuple[str, ...] = tuple()


def _normalize_text(value: Any, *, label: str) -> str:
    if not isinstance(value, str):
        raise ImportApplyError("import-apply-invalid-payload", f"{label} must be a non-empty string.")
    text = value.strip()
    if not text:
        raise ImportApplyError("import-apply-invalid-payload", f"{label} must be a non-empty string.")
    return text


def _normalize_scope_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        candidate = value.strip()
        return candidate or None
    candidate = str(value).strip()
    return candidate or None


def _extract_project_id(payload: Mapping[str, Any], *, label: str) -> str:
    for key in _PROJECT_ID_KEYS:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    raise ImportApplyError("import-apply-invalid-payload", f"{label} is missing a valid project_id.")


def _extract_timestamp(payload: Mapping[str, Any], *, primary: str) -> Any:
    if primary == "created_at":
        return payload.get("created_at") or payload.get("created")
    if primary == "updated_at":
        return payload.get("updated_at") or payload.get("updated")
    return payload.get(primary)


def _map_entities_by_id(
    items: Sequence[Mapping[str, Any]] | None,
    *,
    label: str,
) -> dict[str, Mapping[str, Any]]:
    mapped: dict[str, Mapping[str, Any]] = {}
    for index, item in enumerate(items or ()):
        if not isinstance(item, Mapping):
            raise ImportApplyError(
                "import-apply-invalid-payload",
                f"{label}[{index}] must be an object.",
            )
        entity_id = _normalize_text(item.get("id"), label=f"{label}[{index}].id")
        if entity_id in mapped:
            raise ImportApplyError(
                "import-apply-duplicate-entity-id",
                f"{label} contains duplicate id '{entity_id}'.",
            )
        mapped[entity_id] = item
    return mapped


def _ids_for_upsert(change_set: EntityChangeSet) -> tuple[str, ...]:
    return tuple(change_set.add) + tuple(change_set.update)


def _placeholders(size: int) -> str:
    if size <= 0:
        raise ValueError("size must be positive.")
    return ",".join("?" for _ in range(size))


def _default_cleanup_deleted_task_alerts(conn: sqlite3.Connection, deleted_task_ids: Sequence[str]) -> None:
    if not deleted_task_ids:
        return
    params = tuple(deleted_task_ids)
    with conn:
        conn.execute(
            f"DELETE FROM task_alert_state WHERE task_id IN ({_placeholders(len(params))})",
            params,
        )


def _format_alert_cleanup_warning(exc: Exception) -> str:
    return (
        f"[{IMPORT_WARNING_ALERT_CLEANUP_FAILED}] "
        "Best-effort alert cleanup failed after transactional import apply: "
        f"{type(exc).__name__}: {exc}"
    )


def _format_parent_fallback_warning(project_id: str, missing_parent_id: str) -> str:
    return (
        f"[{IMPORT_WARNING_PARENT_FALLBACK}] "
        "Incoming project parent_id was not found locally; parent_id was reset to null. "
        f"project_id={project_id} parent_id={missing_parent_id}"
    )


def _format_scope(scope: Mapping[str, str | None], keys: Sequence[str]) -> str:
    return ",".join(f"{key}={scope.get(key)!r}" for key in keys)


def _raise_id_collision(
    *,
    entity_type: str,
    entity_id: str,
    scope_keys: Sequence[str],
    incoming_scope: Mapping[str, str | None],
    existing_scope: Mapping[str, str | None],
) -> None:
    raise ImportApplyError(
        "id-collision",
        (
            f"Incoming {entity_type} id '{entity_id}' maps to a different local scope. "
            "Import was blocked to prevent overwrite; reconcile manually or migrate legacy IDs before retrying."
        ),
        details=[
            f"incoming_scope={_format_scope(incoming_scope, scope_keys)}",
            f"existing_scope={_format_scope(existing_scope, scope_keys)}",
        ],
    )


def _select_deleted_task_ids(conn: sqlite3.Connection, deleted_entry_ids: Sequence[str]) -> tuple[str, ...]:
    if not deleted_entry_ids:
        return tuple()
    params = tuple(deleted_entry_ids)
    rows = conn.execute(
        f"""
        SELECT entry_id
        FROM entries
        WHERE kind = 'task' AND entry_id IN ({_placeholders(len(params))})
        """,
        params,
    ).fetchall()
    return tuple(sorted(str(row[0]) for row in rows if row and row[0]))


def _upsert_project(conn: sqlite3.Connection, payload: Mapping[str, Any]) -> str | None:
    project_id = _extract_project_id(payload, label="incoming_project")
    parent_value = _normalize_scope_value(payload.get("parent_id"))
    parent_warning: str | None = None
    if parent_value is not None:
        parent_exists = conn.execute(
            "SELECT 1 FROM projects WHERE project_id = ? LIMIT 1",
            (parent_value,),
        ).fetchone()
        if parent_exists is None:
            parent_warning = _format_parent_fallback_warning(project_id, parent_value)
            parent_value = None
    created_at, updated_at = (_extract_timestamp(payload, primary=key) for key in _PROJECT_TS_KEYS)
    conn.execute(
        """
        INSERT INTO projects (
            project_id, root_id, name, description, parent_id, root_path,
            status, color, entry_mode, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
            root_id = excluded.root_id,
            name = excluded.name,
            description = excluded.description,
            parent_id = excluded.parent_id,
            root_path = excluded.root_path,
            status = excluded.status,
            color = excluded.color,
            entry_mode = excluded.entry_mode,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        """,
        (
            project_id,
            payload.get("root_id"),
            payload.get("name"),
            payload.get("description"),
            parent_value,
            payload.get("root_path"),
            payload.get("status"),
            payload.get("color"),
            payload.get("entry_mode"),
            created_at,
            updated_at,
        ),
    )
    return parent_warning


def _upsert_tag(conn: sqlite3.Connection, payload: Mapping[str, Any], *, default_root_id: str | None) -> None:
    tag_id = _normalize_text(payload.get("id"), label="incoming_tag.id")
    show_header = payload.get("show_header")
    show_header_value = None if show_header is None else (1 if bool(show_header) else 0)
    conn.execute(
        """
        INSERT INTO tag_definitions (tag_id, root_id, name, color, show_header, parent_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(tag_id) DO UPDATE SET
            root_id = excluded.root_id,
            name = excluded.name,
            color = excluded.color,
            show_header = excluded.show_header,
            parent_id = excluded.parent_id
        """,
        (
            tag_id,
            payload.get("root_id") or default_root_id,
            payload.get("name"),
            payload.get("color"),
            show_header_value,
            payload.get("parent_id"),
        ),
    )


def _normalize_entry_kind(payload: Mapping[str, Any]) -> str:
    kind_raw = payload.get("kind")
    kind = _normalize_text(kind_raw, label="incoming_entry.kind").lower()
    if kind not in _ENTRY_KINDS:
        raise ImportApplyError(
            "import-apply-invalid-payload",
            "incoming_entry.kind must be one of: note, task.",
        )
    return kind


def _upsert_entry(
    conn: sqlite3.Connection,
    payload: Mapping[str, Any],
    *,
    default_project_id: str | None,
    default_root_id: str | None,
) -> None:
    entry_id = _normalize_text(payload.get("id"), label="incoming_entry.id")
    project_id = payload.get("project_id") or default_project_id
    if project_id is None:
        raise ImportApplyError(
            "import-apply-invalid-payload",
            f"incoming_entry '{entry_id}' is missing project_id.",
        )
    normalized_project_id = _normalize_text(project_id, label=f"incoming_entry[{entry_id}].project_id")
    kind = _normalize_entry_kind(payload)
    created_at = _extract_timestamp(payload, primary="created_at")
    updated_at = _extract_timestamp(payload, primary="updated_at")
    conn.execute(
        """
        INSERT INTO entries (
            entry_id, project_id, root_id, kind, payload_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET
            project_id = excluded.project_id,
            root_id = excluded.root_id,
            kind = excluded.kind,
            payload_json = excluded.payload_json,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        """,
        (
            entry_id,
            normalized_project_id,
            payload.get("root_id") or default_root_id,
            kind,
            json.dumps(payload, ensure_ascii=False),
            created_at,
            updated_at,
        ),
    )


def _validate_project_apply_target(
    plan: ImportPlan,
    incoming_project: Mapping[str, Any] | None,
) -> tuple[str | None, str | None]:
    project_apply_ids = set(_ids_for_upsert(plan.project))
    project_id: str | None = None
    root_id: str | None = None

    if project_apply_ids:
        if incoming_project is None:
            raise ImportApplyError(
                "import-apply-plan-mismatch",
                "Import plan requires project upsert but incoming_project is missing.",
            )
        project_id = _extract_project_id(incoming_project, label="incoming_project")
        if project_id not in project_apply_ids:
            raise ImportApplyError(
                "import-apply-plan-mismatch",
                "Import plan project apply ids do not match incoming_project.",
                details=[f"incoming_project_id={project_id}", f"plan_apply_ids={sorted(project_apply_ids)}"],
            )
    elif incoming_project is not None:
        project_id = _extract_project_id(incoming_project, label="incoming_project")

    if incoming_project is not None:
        root_value = incoming_project.get("root_id")
        if root_value is not None:
            root_id = _normalize_text(root_value, label="incoming_project.root_id")
    return project_id, root_id


def _validate_upsert_sources(
    *,
    plan: ImportPlan,
    incoming_tags_by_id: Mapping[str, Mapping[str, Any]],
    incoming_entries_by_id: Mapping[str, Mapping[str, Any]],
) -> None:
    missing_tags = sorted(tag_id for tag_id in _ids_for_upsert(plan.tags) if tag_id not in incoming_tags_by_id)
    if missing_tags:
        raise ImportApplyError(
            "import-apply-plan-mismatch",
            "Import plan references tag upserts that are missing in incoming snapshot payload.",
            details=[f"missing_tag_ids={','.join(missing_tags)}"],
        )

    missing_entries = sorted(
        entry_id for entry_id in _ids_for_upsert(plan.entries) if entry_id not in incoming_entries_by_id
    )
    if missing_entries:
        raise ImportApplyError(
            "import-apply-plan-mismatch",
            "Import plan references entry upserts that are missing in incoming snapshot payload.",
            details=[f"missing_entry_ids={','.join(missing_entries)}"],
        )


def _enforce_collision_gate(
    conn: sqlite3.Connection,
    plan: ImportPlan,
    *,
    incoming_project: Mapping[str, Any] | None,
    incoming_tags_by_id: Mapping[str, Mapping[str, Any]],
    incoming_entries_by_id: Mapping[str, Mapping[str, Any]],
    default_project_id: str | None,
    default_root_id: str | None,
) -> None:
    project_apply_ids = _ids_for_upsert(plan.project)
    if project_apply_ids:
        assert incoming_project is not None
        project_id = _extract_project_id(incoming_project, label="incoming_project")
        row = conn.execute(
            "SELECT root_id FROM projects WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        if row:
            incoming_scope = {"root_id": _normalize_scope_value(incoming_project.get("root_id"))}
            existing_scope = {"root_id": _normalize_scope_value(row[0])}
            if incoming_scope != existing_scope:
                _raise_id_collision(
                    entity_type="project",
                    entity_id=project_id,
                    scope_keys=("root_id",),
                    incoming_scope=incoming_scope,
                    existing_scope=existing_scope,
                )

    for tag_id in _ids_for_upsert(plan.tags):
        row = conn.execute(
            "SELECT root_id FROM tag_definitions WHERE tag_id = ?",
            (tag_id,),
        ).fetchone()
        if not row:
            continue
        incoming_scope = {
            "root_id": _normalize_scope_value(incoming_tags_by_id[tag_id].get("root_id") or default_root_id)
        }
        existing_scope = {"root_id": _normalize_scope_value(row[0])}
        if incoming_scope != existing_scope:
            _raise_id_collision(
                entity_type="tag",
                entity_id=tag_id,
                scope_keys=("root_id",),
                incoming_scope=incoming_scope,
                existing_scope=existing_scope,
            )

    for entry_id in _ids_for_upsert(plan.entries):
        row = conn.execute(
            "SELECT project_id, kind, root_id FROM entries WHERE entry_id = ?",
            (entry_id,),
        ).fetchone()
        if not row:
            continue
        entry_payload = incoming_entries_by_id[entry_id]
        incoming_scope = {
            "project_id": _normalize_scope_value(entry_payload.get("project_id") or default_project_id),
            "kind": _normalize_scope_value(_normalize_entry_kind(entry_payload)),
            "root_id": _normalize_scope_value(entry_payload.get("root_id") or default_root_id),
        }
        existing_scope = {
            "project_id": _normalize_scope_value(row[0]),
            "kind": _normalize_scope_value(row[1]),
            "root_id": _normalize_scope_value(row[2]),
        }
        if incoming_scope != existing_scope:
            _raise_id_collision(
                entity_type="entry",
                entity_id=entry_id,
                scope_keys=("project_id", "kind", "root_id"),
                incoming_scope=incoming_scope,
                existing_scope=existing_scope,
            )


def _apply_deletions(conn: sqlite3.Connection, plan: ImportPlan) -> None:
    deleted_entry_ids = tuple(plan.entries.delete)
    if deleted_entry_ids:
        conn.execute(
            f"DELETE FROM entries WHERE entry_id IN ({_placeholders(len(deleted_entry_ids))})",
            deleted_entry_ids,
        )

    deleted_tag_ids = tuple(plan.tags.delete)
    if deleted_tag_ids:
        conn.execute(
            f"UPDATE tag_definitions SET parent_id = NULL WHERE parent_id IN ({_placeholders(len(deleted_tag_ids))})",
            deleted_tag_ids,
        )
        conn.execute(
            f"DELETE FROM tag_definitions WHERE tag_id IN ({_placeholders(len(deleted_tag_ids))})",
            deleted_tag_ids,
        )

    deleted_project_ids = tuple(plan.project.delete)
    if deleted_project_ids:
        conn.execute(
            f"DELETE FROM projects WHERE project_id IN ({_placeholders(len(deleted_project_ids))})",
            deleted_project_ids,
        )


def apply_import_plan_transactionally(
    conn: sqlite3.Connection,
    plan: ImportPlan,
    *,
    incoming_project: Mapping[str, Any] | None,
    incoming_tags: Sequence[Mapping[str, Any]] | None,
    incoming_entries: Sequence[Mapping[str, Any]] | None,
    cleanup_deleted_task_alerts: Callable[[sqlite3.Connection, Sequence[str]], None] | None = None,
    on_warning: Callable[[str], None] | None = None,
) -> ImportApplyResult:
    """Apply import upserts/deletes in one transaction, then clean task alerts best effort."""

    incoming_tags_by_id = _map_entities_by_id(incoming_tags, label="incoming_tags")
    incoming_entries_by_id = _map_entities_by_id(incoming_entries, label="incoming_entries")
    default_project_id, default_root_id = _validate_project_apply_target(plan, incoming_project)
    _validate_upsert_sources(
        plan=plan,
        incoming_tags_by_id=incoming_tags_by_id,
        incoming_entries_by_id=incoming_entries_by_id,
    )
    _enforce_collision_gate(
        conn,
        plan,
        incoming_project=incoming_project,
        incoming_tags_by_id=incoming_tags_by_id,
        incoming_entries_by_id=incoming_entries_by_id,
        default_project_id=default_project_id,
        default_root_id=default_root_id,
    )

    deleted_task_ids: tuple[str, ...] = tuple()
    recorded_warnings: list[str] = []
    try:
        with conn:
            if _ids_for_upsert(plan.project):
                assert incoming_project is not None
                parent_warning = _upsert_project(conn, incoming_project)
                if parent_warning:
                    recorded_warnings.append(parent_warning)

            for tag_id in _ids_for_upsert(plan.tags):
                _upsert_tag(conn, incoming_tags_by_id[tag_id], default_root_id=default_root_id)

            for entry_id in _ids_for_upsert(plan.entries):
                _upsert_entry(
                    conn,
                    incoming_entries_by_id[entry_id],
                    default_project_id=default_project_id,
                    default_root_id=default_root_id,
                )

            deleted_task_ids = _select_deleted_task_ids(conn, plan.entries.delete)
            _apply_deletions(conn, plan)
    except ImportApplyError:
        raise
    except Exception as exc:
        raise ImportApplyError(
            "import-apply-failed",
            "Transactional import apply failed; all DB mutations were rolled back.",
            details=[type(exc).__name__, str(exc)],
        ) from exc

    cleanup_fn = cleanup_deleted_task_alerts or _default_cleanup_deleted_task_alerts
    cleanup_warning: str | None = None
    if deleted_task_ids:
        try:
            cleanup_fn(conn, deleted_task_ids)
        except Exception as exc:
            cleanup_warning = _format_alert_cleanup_warning(exc)
            recorded_warnings.append(cleanup_warning)

    if on_warning is not None:
        for warning in recorded_warnings:
            on_warning(warning)

    return ImportApplyResult(
        deleted_task_ids=deleted_task_ids,
        alert_cleanup_warning=cleanup_warning,
        warnings=tuple(recorded_warnings),
    )


__all__ = [
    "IMPORT_WARNING_ALERT_CLEANUP_FAILED",
    "IMPORT_WARNING_PARENT_FALLBACK",
    "ImportApplyError",
    "ImportApplyResult",
    "apply_import_plan_transactionally",
]
