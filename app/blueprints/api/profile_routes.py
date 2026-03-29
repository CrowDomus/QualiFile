from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Mapping

from flask import Response, current_app, jsonify, request, send_file

from . import api_bp
from .helpers import _error_response, _json_body
from ...features.user_profile.avatar import AvatarStore
from ...features.user_profile.importer import parse_import_payload
from ...features.user_profile.payloads import (
    LOCAL_PROFILE_ID,
    NO_CHANGE,
    build_export_payload,
    build_profile_response,
    merge_profile_updates,
    parse_profile_payload,
)
from ...features.user_profile.store import ProfileService

_ENABLED_PROFILE_MODES = {"shadow", "on"}
_ENABLED_AVATAR_MODES = {"on"}


def _profile_mode_enabled() -> bool:
    value = current_app.config.get("PROFILE_MODE", "off")
    if isinstance(value, str):
        return value.strip().lower() in _ENABLED_PROFILE_MODES
    return False


def _profile_disabled_response() -> Response:
    return _error_response("profile-disabled", "Profile mode is disabled.", 404, log_level=logging.INFO)


def _profile_avatar_enabled() -> bool:
    value = current_app.config.get("PROFILE_AVATAR_MODE", "off")
    if isinstance(value, str):
        return value.strip().lower() in _ENABLED_AVATAR_MODES
    return False


def _avatar_disabled_response() -> Response:
    return _error_response("profile-avatar-disabled", "Profile avatar uploads are disabled.", 404, log_level=logging.INFO)


def _profile_service() -> ProfileService:
    data_dir = current_app.config.get("DATA_DIR") or current_app.instance_path
    return ProfileService(Path(data_dir), current_app.config)


def _import_error(message: str) -> Response:
    response = jsonify({"error": message, "code": "invalid"})
    response.status_code = 400
    return response


def _load_import_payload() -> Mapping[str, Any] | Response:
    if request.is_json:
        data = request.get_json(silent=True)
        if not isinstance(data, Mapping):
            return _import_error("Import payload must be a JSON object.")
        return data
    upload = request.files.get("payload") or request.files.get("profile")
    if not upload:
        return _import_error("No import payload provided.")
    try:
        text = upload.read().decode("utf-8-sig")
    except UnicodeDecodeError:
        return _import_error("Import payload must be UTF-8 encoded.")
    try:
        parsed = json.loads(text)
    except ValueError:
        return _import_error("Import payload must be valid JSON.")
    if not isinstance(parsed, Mapping):
        return _import_error("Import payload must be a JSON object.")
    return parsed


@api_bp.route("/profile", methods=["GET"])
def api_get_profile() -> Response:
    """Return the active profile and portable preferences."""

    if not _profile_mode_enabled():
        return _profile_disabled_response()
    service = _profile_service()
    return jsonify(build_profile_response(service.get_active_profile()))


@api_bp.route("/profile/export", methods=["GET"])
def api_export_profile() -> Response:
    """Export profile identity and portable preferences."""

    if not _profile_mode_enabled():
        return _profile_disabled_response()
    service = _profile_service()
    profile = service.get_active_profile()
    if not profile:
        return jsonify({"error": "Profile not found.", "code": "not-found"}), 404
    return jsonify(build_export_payload(profile))


@api_bp.route("/profile/import", methods=["POST"])
def api_import_profile() -> Response:
    """Import profile identity and portable preferences."""

    if not _profile_mode_enabled():
        return _profile_disabled_response()
    payload = _load_import_payload()
    if isinstance(payload, Response):
        return payload
    service = _profile_service()
    try:
        profile_updates, portable = parse_import_payload(payload)
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400

    current = service.get_active_profile()
    try:
        if current:
            merged = merge_profile_updates(current, profile_updates)
            profile = service.upsert_profile(LOCAL_PROFILE_ID, **merged)
        else:
            profile = service.upsert_profile(LOCAL_PROFILE_ID, **profile_updates)
        if portable is not NO_CHANGE:
            service.set_portable_preferences(LOCAL_PROFILE_ID, portable)
        service.activate_profile(LOCAL_PROFILE_ID)
    except RuntimeError as exc:
        return _error_response("profile-disabled", str(exc), 409, log_level=logging.INFO)
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    return jsonify(build_profile_response(service.get_active_profile() or profile))


@api_bp.route("/profile", methods=["PUT"])
def api_put_profile() -> Response:
    """Create or update the active profile."""

    if not _profile_mode_enabled():
        return _profile_disabled_response()
    data = _json_body()
    if isinstance(data, Response):
        return data
    try:
        profile_updates, portable = parse_profile_payload(data, allow_partial=False)
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    service = _profile_service()
    try:
        profile = service.upsert_profile(LOCAL_PROFILE_ID, **profile_updates)
        if portable is not NO_CHANGE:
            service.set_portable_preferences(LOCAL_PROFILE_ID, portable)
        service.activate_profile(LOCAL_PROFILE_ID)
    except RuntimeError as exc:
        return _error_response("profile-disabled", str(exc), 409, log_level=logging.INFO)
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    return jsonify(build_profile_response(service.get_active_profile() or profile))


@api_bp.route("/profile", methods=["PATCH"])
def api_patch_profile() -> Response:
    """Apply partial updates to the active profile."""

    if not _profile_mode_enabled():
        return _profile_disabled_response()
    data = _json_body()
    if isinstance(data, Response):
        return data
    try:
        profile_updates, portable = parse_profile_payload(data, allow_partial=True)
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    service = _profile_service()
    current = service.get_active_profile()
    if not current:
        return jsonify({"error": "Profile not found.", "code": "not-found"}), 404
    try:
        merged = merge_profile_updates(current, profile_updates)
        profile = service.upsert_profile(LOCAL_PROFILE_ID, **merged)
        if portable is not NO_CHANGE:
            service.set_portable_preferences(LOCAL_PROFILE_ID, portable)
        service.activate_profile(LOCAL_PROFILE_ID)
    except RuntimeError as exc:
        return _error_response("profile-disabled", str(exc), 409, log_level=logging.INFO)
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    return jsonify(build_profile_response(service.get_active_profile() or profile))


@api_bp.route("/profile/avatar", methods=["POST"])
def api_upload_profile_avatar() -> Response:
    """Upload and store a profile avatar image."""

    if not _profile_mode_enabled():
        return _profile_disabled_response()
    if not _profile_avatar_enabled():
        return _avatar_disabled_response()
    upload = request.files.get("avatar")
    if not upload:
        return jsonify({"error": "No avatar file provided.", "code": "invalid"}), 400
    service = _profile_service()
    current = service.get_active_profile()
    if not current:
        return jsonify({"error": "Profile not found.", "code": "not-found"}), 404
    data_dir = current_app.config.get("DATA_DIR") or current_app.instance_path
    store = AvatarStore(Path(data_dir))
    try:
        avatar_ref = store.save(upload)
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    previous_ref = current.get("avatar_ref")
    try:
        merged = merge_profile_updates(current, {"avatar_ref": avatar_ref})
        profile = service.upsert_profile(LOCAL_PROFILE_ID, **merged)
        service.activate_profile(LOCAL_PROFILE_ID)
    except RuntimeError as exc:
        store.delete(avatar_ref)
        return _error_response("profile-disabled", str(exc), 409, log_level=logging.INFO)
    except ValueError as exc:
        store.delete(avatar_ref)
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    if previous_ref and previous_ref != avatar_ref:
        store.delete(previous_ref)
    return jsonify(build_profile_response(service.get_active_profile() or profile))


@api_bp.route("/profile/avatar/<avatar_ref>", methods=["GET"])
def api_get_profile_avatar(avatar_ref: str) -> Response:
    """Return the active profile avatar image."""

    if not _profile_mode_enabled():
        return _profile_disabled_response()
    if not _profile_avatar_enabled():
        return _avatar_disabled_response()
    service = _profile_service()
    profile = service.get_active_profile()
    if not profile:
        return jsonify({"error": "Profile not found.", "code": "not-found"}), 404
    if profile.get("avatar_ref") != avatar_ref:
        return jsonify({"error": "Avatar not found.", "code": "not-found"}), 404
    data_dir = current_app.config.get("DATA_DIR") or current_app.instance_path
    store = AvatarStore(Path(data_dir))
    try:
        path = store.resolve_path(avatar_ref)
    except ValueError:
        return jsonify({"error": "Avatar not found.", "code": "not-found"}), 404
    if not path.is_file():
        return jsonify({"error": "Avatar not found.", "code": "not-found"}), 404
    return send_file(path, mimetype=store.content_type(avatar_ref), conditional=True)


@api_bp.route("/profile/disconnect", methods=["POST"])
def api_disconnect_profile() -> Response:
    """Disconnect the active profile and return to Guest mode."""

    if not _profile_mode_enabled():
        return _profile_disabled_response()
    service = _profile_service()
    try:
        service.disconnect()
    except RuntimeError as exc:
        return _error_response("profile-disabled", str(exc), 409, log_level=logging.INFO)
    return jsonify(build_profile_response(None))
