from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

from flask import Response, current_app, jsonify, request

from ...features.projects.entries_store import (
    ProjectEntryStore,
    ProjectNote,
    ProjectTask,
    _normalize_parent_identifier,
)
from ...features.projects.store import (
    MISSING,
    _now,
    _normalize_color,
    _normalize_description,
    _normalize_entry_mode,
    _normalize_name,
    _normalize_parent,
    _normalize_root_path,
    _normalize_status,
)
from ...features.projects.db_entries_store import ProjectEntryDBStore
from ...features.projects.db_store import ProjectDBStore
from ...features.tags.import_service import (
    TagImportLimitError,
    import_tags_between_roots,
    normalize_import_mode,
)
from ...features.task_alerts import TaskAlertService, notify_task_alert_scheduler
from ...features.task_alerts.actions import (
    DISABLE_ACTIVE_ALERT_ACTION_CLEAR,
    normalize_disable_active_alert_action,
    TaskAlertActionService,
)
from ...features.task_alerts.store import TaskAlertStateStore
from ...shared.db import get_db
from ...shared.db_roots import ensure_root
from . import api_bp
from .helpers import _json_body


def _project_db_store() -> ProjectDBStore:
    """Return a ProjectDBStore bound to the request DB connection."""

    return ProjectDBStore(get_db(current_app))


def _project_entry_db_store() -> ProjectEntryDBStore:
    """Return a ProjectEntryDBStore bound to the request DB connection."""

    return ProjectEntryDBStore(get_db(current_app))


def _task_alert_state_store() -> TaskAlertStateStore:
    """Return a TaskAlertStateStore bound to the request DB connection."""

    return TaskAlertStateStore(get_db(current_app))


def _task_alert_service() -> TaskAlertService:
    """Return a TaskAlertService bound to the request DB connection."""

    return TaskAlertService(get_db(current_app))


def _task_alert_action_service() -> TaskAlertActionService:
    """Return a TaskAlertActionService bound to the request DB connection."""

    return TaskAlertActionService(get_db(current_app))


def _sync_task_alert_after_task_write(task_id: str) -> None:
    """Evaluate reminder alert state without failing the primary write path."""

    try:
        _task_alert_service().evaluate_task(task_id)
    except Exception:
        current_app.logger.exception("Task alert evaluation failed after task write.")
    try:
        notify_task_alert_scheduler(current_app)
    except Exception:
        current_app.logger.exception("Task alert scheduler notify failed.")


def _project_map(projects: list[dict]) -> dict[str, dict]:
    mapping: dict[str, dict] = {}
    for project in projects:
        if not isinstance(project, dict):
            continue
        project_id = project.get("id")
        if isinstance(project_id, str):
            mapping[project_id] = project
    return mapping


def _project_children(projects: dict[str, dict], parent_id: str) -> list[str]:
    return [
        project_id
        for project_id, project in projects.items()
        if project.get("parent_id") == parent_id
    ]


def _project_descendants(projects: dict[str, dict], project_id: str) -> list[str]:
    descendants: list[str] = []
    queue = [project_id]
    while queue:
        current = queue.pop(0)
        children = _project_children(projects, current)
        descendants.extend(children)
        queue.extend(children)
    return descendants


def _would_create_project_cycle(projects: dict[str, dict], project_id: str, parent_id: str) -> bool:
    current = parent_id
    visited = {project_id}
    while current:
        if current in visited:
            return True
        visited.add(current)
        parent = projects.get(current, {}).get("parent_id")
        if not parent:
            return False
        current = parent
    return False


def _task_with_defaults(payload: dict) -> dict:
    cleaned = dict(payload)
    if "auto_rollup_dates" not in cleaned:
        cleaned["auto_rollup_dates"] = False
    if "parent_project_id" not in cleaned:
        cleaned["parent_project_id"] = None
    if "parent_task_id" not in cleaned:
        cleaned["parent_task_id"] = None
    if "reminder_enabled" not in cleaned:
        cleaned["reminder_enabled"] = False
    if "reminder_mode" not in cleaned:
        cleaned["reminder_mode"] = "on_end_date"
    if "reminder_days_before" not in cleaned:
        cleaned["reminder_days_before"] = None
    return cleaned


def _entry_payload_from_row(
    entry_id: str,
    kind: str,
    payload_json: str | None,
    created_at: str | None,
    updated_at: str | None,
) -> dict:
    payload: dict = {}
    if payload_json:
        try:
            payload = json.loads(payload_json)
        except Exception:
            payload = {}
    payload.setdefault("id", entry_id)
    if created_at is not None:
        payload.setdefault("created_at", created_at)
    if updated_at is not None:
        payload.setdefault("updated_at", updated_at)
    if kind == "task":
        payload = _task_with_defaults(payload)
    return payload


def _fetch_entry_payload(conn, project_id: str, entry_id: str, kind: str | None = None) -> dict:
    sql = """
        SELECT entry_id, kind, payload_json, created_at, updated_at
        FROM entries
        WHERE project_id = ? AND entry_id = ?
    """
    params: list[object] = [project_id, entry_id]
    if kind:
        normalized = ProjectEntryStore.normalize_kind(kind)
        sql += " AND kind = ?"
        params.append(normalized)
    row = conn.execute(sql, tuple(params)).fetchone()
    if not row:
        raise KeyError(f"Entry '{entry_id}' not found.")
    entry_id, entry_kind, payload_json, created_at, updated_at = row
    return _entry_payload_from_row(entry_id, entry_kind, payload_json, created_at, updated_at)


def _fetch_task_payload(conn, project_id: str | None, task_id: str | None) -> dict | None:
    if not project_id or not task_id:
        return None
    row = conn.execute(
        """
        SELECT entry_id, kind, payload_json, created_at, updated_at
        FROM entries
        WHERE project_id = ? AND entry_id = ? AND kind = 'task'
        """,
        (project_id, task_id),
    ).fetchone()
    if not row:
        return None
    entry_id, entry_kind, payload_json, created_at, updated_at = row
    return _entry_payload_from_row(entry_id, entry_kind, payload_json, created_at, updated_at)


def _would_create_task_cycle(
    conn,
    project_id: str,
    task_id: str,
    parent_project_id: str | None,
    parent_task_id: str | None,
) -> bool:
    if not parent_project_id or not parent_task_id:
        return False
    target = (project_id, task_id)
    cursor = (parent_project_id, parent_task_id)
    visited: set[tuple[str, str]] = set()
    while cursor[0] and cursor[1]:
        if cursor == target:
            return True
        if cursor in visited:
            return True
        visited.add(cursor)
        payload = _fetch_task_payload(conn, cursor[0], cursor[1])
        if not payload:
            break
        cursor = (
            _normalize_parent_identifier(payload.get("parent_project_id")) or cursor[0],
            _normalize_parent_identifier(payload.get("parent_task_id")),
        )
    return False


def _validate_task_parent(conn, project_id: str, task_id: str, payload: dict) -> tuple[str | None, str | None]:
    parent_project_id = _normalize_parent_identifier(payload.get("parent_project_id"))
    parent_task_id = _normalize_parent_identifier(payload.get("parent_task_id"))
    if parent_project_id is None and parent_task_id is None:
        return None, None
    if parent_task_id and not parent_project_id:
        parent_project_id = project_id
    if parent_project_id and not parent_task_id:
        raise ValueError("parent_task_id is required when setting a parent.")
    try:
        ProjectDBStore(conn).get_project(parent_project_id)  # type: ignore[arg-type]
    except Exception as exc:  # pragma: no cover - defensive
        raise ValueError("Parent project was not found.") from exc
    parent_task = _fetch_task_payload(conn, parent_project_id, parent_task_id)
    if not parent_task:
        raise ValueError("Parent task was not found.")
    if parent_project_id == project_id and parent_task_id == task_id:
        raise ValueError("A task cannot be its own parent.")
    if _would_create_task_cycle(conn, project_id, task_id, parent_project_id, parent_task_id):
        raise ValueError("Parent relationship would create a cycle.")
    return parent_project_id, parent_task_id


def _resolve_entry_kind_db(conn, project: dict, entry_id: str, requested: str | None) -> str:
    """Infer the entry kind for a project entry using the DB."""

    if requested:
        return ProjectEntryStore.normalize_kind(requested)
    default_mode = (project.get("entry_mode") or "note").strip().lower()
    if default_mode in {"note", "task"}:
        return ProjectEntryStore.normalize_kind(default_mode)
    row = conn.execute(
        "SELECT kind FROM entries WHERE project_id = ? AND entry_id = ?",
        (project.get("id", ""), entry_id),
    ).fetchone()
    if row:
        return ProjectEntryStore.normalize_kind(row[0])
    raise ValueError("Entry type is required.")


@api_bp.route("/projects", methods=["GET", "POST"])
def api_projects() -> Response:
    """List all projects or create a new one."""

    db_store = _project_db_store()
    if request.method == "GET":
        return jsonify({"projects": db_store.list_projects()})
    data = _json_body()
    if isinstance(data, Response):
        return data
    conn = get_db(current_app)
    projects = db_store.list_projects()
    project_map = _project_map(projects)
    try:
        name = _normalize_name(data.get("name", ""))
        description = _normalize_description(data.get("description"))
        parent_id = _normalize_parent(data.get("parent_id"))
        root_path = _normalize_root_path(data.get("root_path"))
        status = _normalize_status(data.get("status"))
        color = _normalize_color(data.get("color"))
        entry_mode = _normalize_entry_mode(data.get("entry_mode"))
        if parent_id and parent_id not in project_map:
            raise ValueError("Parent project does not exist.")
        if parent_id and color is None:
            parent = project_map.get(parent_id, {})
            color = _normalize_color(parent.get("color"))
        project_id = f"proj-{uuid4().hex[:8]}"
        if parent_id and _would_create_project_cycle(project_map, project_id, parent_id):
            raise ValueError("Parent relationship would create a cycle.")
        timestamp = _now()
        project = {
            "id": project_id,
            "name": name,
            "description": description,
            "parent_id": parent_id,
            "root_path": root_path,
            "created_at": timestamp,
            "updated_at": timestamp,
            "status": status,
            "color": color,
            "entry_mode": entry_mode,
            "archived": False,
            "archived_at": None,
        }
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    root_id = ensure_root(conn, project.get("root_path"))
    payload = dict(project)
    payload["root_id"] = root_id
    ProjectDBStore(conn).upsert_project(payload)
    return jsonify(project), 201


@api_bp.route("/projects/<project_id>", methods=["GET", "PATCH", "DELETE"])
def api_project_detail(project_id: str) -> Response:
    """Retrieve, update, or delete a project."""

    db_store = _project_db_store()
    if request.method == "GET":
        try:
            project = db_store.get_project(project_id)
        except KeyError:
            return jsonify({"error": "Project not found.", "code": "not-found"}), 404
        return jsonify(project)
    if request.method == "PATCH":
        data = _json_body()
        if isinstance(data, Response):
            return data
        allowed = {"name", "description", "parent_id", "root_path", "status", "color", "entry_mode"}
        payload = {key: data[key] for key in allowed if key in data}
        conn = get_db(current_app)
        try:
            project = db_store.get_project(project_id)
        except KeyError:
            return jsonify({"error": "Project not found.", "code": "not-found"}), 404
        try:
            projects = db_store.list_projects()
            project_map = _project_map(projects)
            if "name" in payload:
                project["name"] = _normalize_name(payload.get("name"))
            if "description" in payload:
                project["description"] = _normalize_description(payload.get("description"))
            if "root_path" in payload:
                project["root_path"] = _normalize_root_path(payload.get("root_path"))
            if "status" in payload:
                project["status"] = _normalize_status(payload.get("status"))
            if "color" in payload:
                project["color"] = _normalize_color(payload.get("color"))
            if "entry_mode" in payload:
                project["entry_mode"] = _normalize_entry_mode(payload.get("entry_mode"))
            parent_value = payload.get("parent_id", MISSING)
            if parent_value is not MISSING:
                cleaned_parent = _normalize_parent(parent_value)
                if cleaned_parent:
                    if cleaned_parent == project_id:
                        raise ValueError("A project cannot be its own parent.")
                    if cleaned_parent not in project_map:
                        raise ValueError("Parent project does not exist.")
                    if _would_create_project_cycle(project_map, project_id, cleaned_parent):
                        raise ValueError("Parent relationship would create a cycle.")
                project["parent_id"] = cleaned_parent
            project["updated_at"] = _now()
        except ValueError as exc:
            return jsonify({"error": str(exc), "code": "invalid"}), 400
        root_id = ensure_root(conn, project.get("root_path"))
        updated = dict(project)
        updated["root_id"] = root_id
        ProjectDBStore(conn).upsert_project(updated)
        return jsonify(project)
    cascade_param = str(request.args.get("cascade", "")).strip().lower()
    cascade = cascade_param in {"1", "true", "yes", "on"}
    try:
        projects = db_store.list_projects()
        project_map = _project_map(projects)
        if project_id not in project_map:
            raise KeyError("Project not found.")
        children = _project_children(project_map, project_id)
        if children and not cascade:
            raise ValueError("Delete blocked: project has subprojects.")
        to_remove = {project_id}
        if cascade:
            to_remove.update(_project_descendants(project_map, project_id))
        db_store.delete_projects(sorted(to_remove))
    except KeyError:
        return jsonify({"error": "Project not found.", "code": "not-found"}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    return jsonify({"status": "deleted"})


@api_bp.route("/projects/<project_id>/archive", methods=["POST"])
@api_bp.route("/projects/<project_id>/unarchive", methods=["POST"])
def api_project_archive_state(project_id: str) -> Response:
    """Archive or restore a project without deleting related data."""

    conn = get_db(current_app)
    db_store = ProjectDBStore(conn)
    try:
        project = db_store.get_project(project_id)
    except KeyError:
        return jsonify({"error": "Project not found.", "code": "not-found"}), 404

    archived = request.path.rsplit("/", 1)[-1] == "archive"
    project["archived"] = archived
    project["archived_at"] = _now() if archived else None
    project["updated_at"] = _now()
    payload = dict(project)
    payload["root_id"] = ensure_root(conn, project.get("root_path"))
    db_store.upsert_project(payload)
    return jsonify(project)


@api_bp.route("/projects/<project_id>/tags/import", methods=["POST"])
def api_import_project_tags(project_id: str) -> Response:
    """Import tag definitions between project roots using project ids only."""

    data = _json_body()
    if isinstance(data, Response):
        return data

    source_project_id = str(data.get("source_project_id") or "").strip()
    if not source_project_id:
        return jsonify({"error": "source_project_id is required.", "code": "invalid"}), 400
    if source_project_id == project_id:
        return jsonify({"error": "Source and target projects must be different.", "code": "same-project"}), 400
    try:
        mode = normalize_import_mode(data.get("mode"))
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400

    db_store = _project_db_store()
    try:
        target_project = db_store.get_project(project_id)
    except KeyError:
        return jsonify({"error": "Target project not found.", "code": "not-found"}), 404
    try:
        source_project = db_store.get_project(source_project_id)
    except KeyError:
        return jsonify({"error": "Source project not found.", "code": "not-found"}), 404

    target_root_raw = str(target_project.get("root_path") or "").strip()
    if not target_root_raw:
        return jsonify({"error": "Target project has no root path.", "code": "target-missing-root"}), 400
    source_root_raw = str(source_project.get("root_path") or "").strip()
    if not source_root_raw:
        return jsonify({"error": "Source project has no root path.", "code": "source-missing-root"}), 400

    target_root = Path(target_root_raw).expanduser()
    if not target_root.exists() or not target_root.is_dir():
        return jsonify({"error": "Target project root is unavailable.", "code": "target-root-missing"}), 404
    source_root = Path(source_root_raw).expanduser()
    if not source_root.exists() or not source_root.is_dir():
        return jsonify({"error": "Source project root is unavailable.", "code": "source-root-missing"}), 404

    try:
        payload = import_tags_between_roots(
            get_db(current_app),
            source_root=source_root,
            target_root=target_root,
            mode=mode,
        )
    except TagImportLimitError as exc:
        return jsonify({"error": str(exc), "code": "max-tags"}), 400
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400

    payload["source_project_id"] = source_project_id
    payload["target_project_id"] = project_id
    return jsonify(payload)


@api_bp.route("/projects/<project_id>/entries", methods=["GET", "POST"])
def api_project_entries(project_id: str) -> Response:
    """List or create project-scoped tasks/notes."""

    conn = get_db(current_app)
    project_store = _project_db_store()
    entry_store = _project_entry_db_store()
    try:
        project = project_store.get_project(project_id)
    except KeyError:
        return jsonify({"error": "Project not found.", "code": "not-found"}), 404

    if request.method == "GET":
        kind = request.args.get("type")
        try:
            entries = entry_store.list_entries(project_id, kind)
        except ValueError as exc:
            return jsonify({"error": str(exc), "code": "invalid"}), 400
        return jsonify({"project_id": project_id, "entries": entries})

    data = _json_body()
    if isinstance(data, Response):
        return data
    raw_kind = data.get("type") or request.args.get("type") or project.get("entry_mode") or "note"
    try:
        kind = ProjectEntryStore.normalize_kind(raw_kind)
        if kind == "note":
            entry = ProjectNote.from_payload(data).as_dict()
        else:
            task_id = str(data.get("id") or f"task-{uuid4().hex[:8]}")
            parent_project_id, parent_task_id = _validate_task_parent(conn, project_id, task_id, data)
            task_payload = dict(data)
            task_payload["id"] = task_id
            task_payload["parent_project_id"] = parent_project_id
            task_payload["parent_task_id"] = parent_task_id
            entry = ProjectTask.from_payload(task_payload).as_dict()
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    root_id = ensure_root(conn, project.get("root_path"))
    entry_store.upsert_entry(project_id, kind, entry, root_id=root_id)
    if kind == "task":
        _sync_task_alert_after_task_write(str(entry.get("id")))
    return jsonify({
        "project_id": project_id,
        "type": kind,
        "entry": entry,
        "entries": entry_store.list_entries(project_id, kind),
    }), 201


@api_bp.route("/projects/<project_id>/entries/<entry_id>", methods=["PATCH", "DELETE"])
def api_project_entry_detail(project_id: str, entry_id: str) -> Response:
    """Update or delete a project task/note."""

    conn = get_db(current_app)
    project_store = _project_db_store()
    entry_store = _project_entry_db_store()
    try:
        project = project_store.get_project(project_id)
    except KeyError:
        return jsonify({"error": "Project not found.", "code": "not-found"}), 404

    if request.method == "PATCH":
        data = _json_body()
        if isinstance(data, Response):
            return data
        disable_active_alert_action = None
        try:
            kind = _resolve_entry_kind_db(conn, project, entry_id, data.get("type") or request.args.get("type"))
            current = _fetch_entry_payload(conn, project_id, entry_id, kind)
            merged = {**current, **data, "id": entry_id}
            if kind == "task":
                disable_active_alert_action = normalize_disable_active_alert_action(
                    data.get("disable_active_alert_action")
                )
                current_reminder_enabled = bool(current.get("reminder_enabled"))
                next_reminder_enabled = bool(merged.get("reminder_enabled"))
                disabling_reminder = current_reminder_enabled and not next_reminder_enabled
                has_active_alert = _task_alert_action_service().has_active_alert(entry_id)
                if disabling_reminder and has_active_alert and disable_active_alert_action is None:
                    return (
                        jsonify(
                            {
                                "error": (
                                    "Choose how to disable reminders for this active alert: "
                                    "disable future reminders only, or disable and clear this active alert."
                                ),
                                "code": "active-alert-disable-choice-required",
                            }
                        ),
                        409,
                    )
            if kind == "note":
                merged.pop("status", None)
                merged.pop("deadline", None)
                entry = ProjectNote.from_payload(merged).as_dict()
            else:
                parent_project_id, parent_task_id = _validate_task_parent(conn, project_id, entry_id, merged)
                merged["parent_project_id"] = parent_project_id
                merged["parent_task_id"] = parent_task_id
                entry = ProjectTask.from_payload(merged).as_dict()
        except KeyError:
            return jsonify({"error": "Entry not found.", "code": "not-found"}), 404
        except ValueError as exc:
            return jsonify({"error": str(exc), "code": "invalid"}), 400
        root_id = ensure_root(conn, project.get("root_path"))
        entry_store.upsert_entry(project_id, kind, entry, root_id=root_id)
        if kind == "task":
            if disable_active_alert_action == DISABLE_ACTIVE_ALERT_ACTION_CLEAR:
                try:
                    _task_alert_action_service().clear_active_alert(entry_id)
                except KeyError:
                    pass
            _sync_task_alert_after_task_write(str(entry.get("id")))
        return jsonify({
            "project_id": project_id,
            "type": kind,
            "entry": entry,
            "entries": entry_store.list_entries(project_id, kind),
        })

    raw_kind = request.args.get("type")
    try:
        kind = _resolve_entry_kind_db(conn, project, entry_id, raw_kind)
        _fetch_entry_payload(conn, project_id, entry_id, kind)
    except KeyError:
        return jsonify({"error": "Entry not found.", "code": "not-found"}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    entry_store.delete_entry(project_id, entry_id)
    if kind == "task":
        entry_store.clear_task_parent_links(project_id, entry_id)
        _task_alert_state_store().clear_task_state(entry_id)
        _sync_task_alert_after_task_write(entry_id)
    return jsonify({"status": "deleted", "project_id": project_id, "type": kind})


@api_bp.route("/projects/<project_id>/activate", methods=["POST"])
def api_project_activate(project_id: str) -> Response:
    """Activate a project's root and switch the workspace to it."""

    try:
        project = _project_db_store().get_project(project_id)
    except KeyError:
        return jsonify({"error": "Project not found.", "code": "not-found"}), 404
    root_path = project.get("root_path")
    if not root_path:
        return jsonify({"error": "Project has no root path configured.", "code": "no-root"}), 400
    target = Path(root_path)
    if not target.exists() or not target.is_dir():
        return jsonify({"error": "Project root is unavailable.", "code": "root-missing"}), 404
    current_app.config["QUALIFILE_ROOT"] = target.resolve()
    from ... import save_root_path
    save_root_path(
        target.resolve(),
        state_file=current_app.config.get("ROOT_STATE_FILE"),
        data_dir=current_app.config.get("DATA_DIR"),
        config=current_app.config,
    )
    return jsonify({"root": str(target.resolve()), "project_id": project_id})
