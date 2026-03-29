from __future__ import annotations

import re
from pathlib import Path

from flask import Response, current_app, jsonify, request

from ...features.git_sync import (
    DEFAULT_LARGE_DELETE_THRESHOLD,
    LocalSyncStateStore,
    build_failure_guidance_catalog,
    commit_push_project_action,
    export_project_metadata_action,
    guidance_for_failure_code,
    import_project_metadata_action,
    init_project_repo_action,
    list_sync_manager_project_statuses,
    pull_import_project_action,
    redact_sensitive_text,
    set_project_remote_action,
    SyncManagerActionError,
)
from ...shared.db import get_db
from . import api_bp
from .helpers import _json_body


def _is_local_request() -> bool:
    remote = (request.remote_addr or "").replace("::1", "127.0.0.1")
    return remote in {"127.0.0.1", "localhost"}


_CODE_TO_STATUS = {
    "forbidden": 403,
    "project-not-found": 404,
    "root-unavailable": 404,
    "invalid-content-type": 415,
    "invalid-json": 400,
    "invalid": 400,
    "project-no-root": 409,
    "project-root-id-missing": 409,
    "git-repo-not-initialized": 409,
    "git-missing": 409,
    "git-path-invalid": 409,
    "git-not-trusted": 409,
}

_WINDOWS_ABS_PATH_RE = re.compile(r"(?i)\b[A-Z]:[\\/][^\s]+")
_POSIX_ABS_PATH_RE = re.compile(r"(?<!:)/(?:[^\s]+)")
_REMOTE_URL_RE = re.compile(r"(?i)\b(?:https?|ssh)://[^\s]+")
_SCP_REMOTE_RE = re.compile(r"(?i)\b[\w.+-]+@[\w.-]+:[^\s]+")


def _status_for_code(code: str) -> int:
    if str(code).startswith("remote-url-"):
        return 400
    return _CODE_TO_STATUS.get(code, 409)


def _sanitize_path_match(value: str) -> str:
    candidate = value.strip(" \"'()[]{}")
    name = Path(candidate).name
    return name or "<path>"


def _sanitize_error_text(value: str | None) -> str:
    text = redact_sensitive_text(value or "")
    if not text:
        return ""
    text = _REMOTE_URL_RE.sub("<remote-url-redacted>", text)
    text = _SCP_REMOTE_RE.sub("<remote-url-redacted>", text)
    text = _WINDOWS_ABS_PATH_RE.sub(lambda match: _sanitize_path_match(match.group(0)), text)
    text = _POSIX_ABS_PATH_RE.sub(lambda match: _sanitize_path_match(match.group(0)), text)
    return text


def _sanitize_error_details(details: tuple[str, ...] | list[str] | None) -> list[str] | None:
    if not details:
        return None
    sanitized: list[str] = []
    for item in details:
        detail = _sanitize_error_text(str(item))
        if detail:
            sanitized.append(detail)
    return sanitized or None


def _action_error(
    code: str,
    message: str,
    *,
    status: int | None = None,
    details: tuple[str, ...] | list[str] | None = None,
) -> tuple[Response, int]:
    guidance = guidance_for_failure_code(code)
    payload = {
        "ok": False,
        "error": _sanitize_error_text(message),
        "code": code,
    }
    sanitized_details = _sanitize_error_details(details)
    if sanitized_details:
        payload["details"] = sanitized_details
    if guidance is not None:
        payload["guidance_key"] = str(guidance.get("code") or "")
        payload["guidance"] = {
            "title": str(guidance.get("title") or ""),
            "summary": _sanitize_error_text(str(guidance.get("summary") or "")),
            "next_steps": [_sanitize_error_text(str(step)) for step in guidance.get("next_steps") or []],
        }
    return jsonify(payload), int(status if status is not None else _status_for_code(code))


def _action_ok(action: str, project_id: str, result: object) -> Response:
    return jsonify(
        {
            "ok": True,
            "action": action,
            "project_id": project_id,
            "result": result,
        }
    )


def _parse_bool(value: object, *, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _parse_positive_int(value: object, *, default: int) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("delete_threshold must be a positive integer.") from exc
    if parsed <= 0:
        raise ValueError("delete_threshold must be a positive integer.")
    return parsed


def _require_project_id(data: dict) -> str:
    project_id = str(data.get("project_id") or "").strip()
    if not project_id:
        raise ValueError("project_id is required.")
    return project_id


@api_bp.route("/git-sync/projects/status", methods=["GET"])
def api_git_sync_project_status() -> Response:
    """Return Sync Manager baseline status/action rows for all projects."""

    if not _is_local_request():
        return jsonify({"error": "This action is only available locally.", "code": "forbidden"}), 403

    conn = get_db(current_app)
    lss_store = LocalSyncStateStore(conn)
    projects = list_sync_manager_project_statuses(conn, lss_store=lss_store)
    return jsonify(
        {
            "projects": projects,
            "failure_guidance_catalog": build_failure_guidance_catalog(),
        }
    )


@api_bp.route("/git-sync/project/export", methods=["POST"])
def api_git_sync_project_export() -> Response:
    if not _is_local_request():
        return jsonify({"error": "This action is only available locally.", "code": "forbidden"}), 403
    data = _json_body()
    if isinstance(data, Response):
        return data
    try:
        project_id = _require_project_id(data)
        result = export_project_metadata_action(get_db(current_app), project_id=project_id)
        return _action_ok("export", project_id, result)
    except ValueError as exc:
        return _action_error("invalid", str(exc), status=400)
    except SyncManagerActionError as exc:
        return _action_error(exc.code, str(exc), details=list(exc.details))


@api_bp.route("/git-sync/project/import", methods=["POST"])
def api_git_sync_project_import() -> Response:
    if not _is_local_request():
        return jsonify({"error": "This action is only available locally.", "code": "forbidden"}), 403
    data = _json_body()
    if isinstance(data, Response):
        return data
    try:
        project_id = _require_project_id(data)
        result = import_project_metadata_action(
            get_db(current_app),
            project_id=project_id,
            confirm_apply=_parse_bool(data.get("confirm_apply"), default=False),
            confirm_large_delete=_parse_bool(data.get("confirm_large_delete"), default=False),
            delete_threshold=_parse_positive_int(data.get("delete_threshold"), default=DEFAULT_LARGE_DELETE_THRESHOLD),
            allow_force_import=_parse_bool(data.get("allow_force_import"), default=False),
            force_import_typed_phrase=str(data.get("force_import_typed_phrase") or "").strip() or None,
            audit_actor=str(data.get("audit_actor") or "").strip() or None,
        )
        return _action_ok("import", project_id, result)
    except ValueError as exc:
        return _action_error("invalid", str(exc), status=400)
    except SyncManagerActionError as exc:
        return _action_error(exc.code, str(exc), details=list(exc.details))


@api_bp.route("/git-sync/project/init-repo", methods=["POST"])
def api_git_sync_project_init_repo() -> Response:
    if not _is_local_request():
        return jsonify({"error": "This action is only available locally.", "code": "forbidden"}), 403
    data = _json_body()
    if isinstance(data, Response):
        return data
    try:
        project_id = _require_project_id(data)
        raw_warning_codes = data.get("warning_codes")
        warning_codes = raw_warning_codes if isinstance(raw_warning_codes, list) else None
        result = init_project_repo_action(
            get_db(current_app),
            project_id=project_id,
            include_json_eol_rule=_parse_bool(data.get("include_json_eol_rule"), default=True),
            acknowledge_warnings=_parse_bool(data.get("acknowledge_warnings"), default=False),
            warning_codes=warning_codes,
        )
        return _action_ok("init-repo", project_id, result)
    except ValueError as exc:
        return _action_error("invalid", str(exc), status=400)
    except SyncManagerActionError as exc:
        return _action_error(exc.code, str(exc), details=list(exc.details))


@api_bp.route("/git-sync/project/set-remote", methods=["POST"])
def api_git_sync_project_set_remote() -> Response:
    if not _is_local_request():
        return jsonify({"error": "This action is only available locally.", "code": "forbidden"}), 403
    data = _json_body()
    if isinstance(data, Response):
        return data
    try:
        project_id = _require_project_id(data)
        remote_url = str(data.get("remote_url") or "").strip()
        if not remote_url:
            raise ValueError("remote_url is required.")
        remote_name = str(data.get("remote_name") or "origin").strip() or "origin"
        result = set_project_remote_action(
            get_db(current_app),
            project_id=project_id,
            remote_url=remote_url,
            remote_name=remote_name,
        )
        return _action_ok("set-remote", project_id, result)
    except ValueError as exc:
        return _action_error("invalid", str(exc), status=400)
    except SyncManagerActionError as exc:
        return _action_error(exc.code, str(exc), details=list(exc.details))


@api_bp.route("/git-sync/project/commit-push", methods=["POST"])
def api_git_sync_project_commit_push() -> Response:
    if not _is_local_request():
        return jsonify({"error": "This action is only available locally.", "code": "forbidden"}), 403
    data = _json_body()
    if isinstance(data, Response):
        return data
    try:
        project_id = _require_project_id(data)
        commit_message = str(data.get("commit_message") or "").strip() or "Sync metadata"
        result = commit_push_project_action(
            get_db(current_app),
            project_id=project_id,
            commit_message=commit_message,
        )
        return _action_ok("commit-push", project_id, result)
    except ValueError as exc:
        return _action_error("invalid", str(exc), status=400)
    except SyncManagerActionError as exc:
        return _action_error(exc.code, str(exc), details=list(exc.details))


@api_bp.route("/git-sync/project/pull-import", methods=["POST"])
def api_git_sync_project_pull_import() -> Response:
    if not _is_local_request():
        return jsonify({"error": "This action is only available locally.", "code": "forbidden"}), 403
    data = _json_body()
    if isinstance(data, Response):
        return data
    try:
        project_id = _require_project_id(data)
        result = pull_import_project_action(
            get_db(current_app),
            project_id=project_id,
            confirm_apply=_parse_bool(data.get("confirm_apply"), default=False),
            confirm_large_delete=_parse_bool(data.get("confirm_large_delete"), default=False),
            delete_threshold=_parse_positive_int(data.get("delete_threshold"), default=DEFAULT_LARGE_DELETE_THRESHOLD),
            allow_force_import=_parse_bool(data.get("allow_force_import"), default=False),
            force_import_typed_phrase=str(data.get("force_import_typed_phrase") or "").strip() or None,
            audit_actor=str(data.get("audit_actor") or "").strip() or None,
        )
        return _action_ok("pull-import", project_id, result)
    except ValueError as exc:
        return _action_error("invalid", str(exc), status=400)
    except SyncManagerActionError as exc:
        return _action_error(exc.code, str(exc), details=list(exc.details))
