from __future__ import annotations

from flask import Response, current_app, jsonify, request

from ...features.filesystem.service import resolve_within_root
from ...features.metadata.service import MetadataService, SidecarReadError
from ...features.notes.store import NoteStore
from ...shared.db import get_db
from . import api_bp
from .helpers import _fs_error_response, _json_body, _root_or_response


@api_bp.route("/notes", methods=["GET"])
def api_get_notes() -> Response:
    """Return notes for a specific file or folder."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    relative = request.args.get("path", ".")
    try:
        resolve_within_root(root, relative)
    except Exception as exc:
        return _fs_error_response(exc)
    metadata = MetadataService(
        root,
        current_app.config.get("DATA_DIR"),
        config=current_app.config,
        db_conn=get_db(current_app),
    )
    notes = metadata.get_notes(relative)
    summary = metadata.summarize(notes)
    return jsonify({
        "path": NoteStore.normalize_path(relative),
        "notes": notes,
        "summary": summary,
    })


@api_bp.route("/notes", methods=["POST"])
def api_create_note() -> Response:
    """Create a new note attached to a file or folder."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    relative = data.get("path")
    if not relative:
        return jsonify({"error": "Path is required.", "code": "invalid"}), 400
    try:
        resolve_within_root(root, relative)
    except Exception as exc:
        return _fs_error_response(exc)
    metadata = MetadataService(
        root,
        current_app.config.get("DATA_DIR"),
        config=current_app.config,
        db_conn=get_db(current_app),
    )
    try:
        note = metadata.add_note(
            relative,
            text=data.get("text", ""),
            deadline=data.get("deadline"),
            priority=data.get("priority"),
            status=data.get("status", "none"),
            color=data.get("color"),
        )
    except SidecarReadError as exc:
        return jsonify({"error": str(exc), "code": "sidecar-read-error"}), 423
    except (ValueError, KeyError) as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    notes = metadata.get_notes(relative)
    return jsonify({
        "note": note,
        "notes": notes,
        "summary": metadata.summarize(notes),
        "path": NoteStore.normalize_path(relative),
    })


@api_bp.route("/notes/<note_id>", methods=["PATCH"])
def api_update_note(note_id: str) -> Response:
    """Update note content or metadata."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    relative = data.get("path")
    if not relative:
        return jsonify({"error": "Path is required.", "code": "invalid"}), 400
    try:
        resolve_within_root(root, relative)
    except Exception as exc:
        return _fs_error_response(exc)
    metadata = MetadataService(
        root,
        current_app.config.get("DATA_DIR"),
        config=current_app.config,
        db_conn=get_db(current_app),
    )
    try:
        note = metadata.update_note(
            relative,
            note_id,
            text=data.get("text"),
            deadline=data.get("deadline"),
            priority=data.get("priority"),
            status=data.get("status"),
            color=data.get("color"),
        )
    except SidecarReadError as exc:
        return jsonify({"error": str(exc), "code": "sidecar-read-error"}), 423
    except KeyError:
        return jsonify({"error": "Note not found.", "code": "not-found"}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    notes = metadata.get_notes(relative)
    return jsonify({
        "note": note,
        "notes": notes,
        "summary": metadata.summarize(notes),
        "path": NoteStore.normalize_path(relative),
    })


@api_bp.route("/notes/<note_id>", methods=["DELETE"])
def api_delete_note(note_id: str) -> Response:
    """Delete a note from a file or folder."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    if request.args.get("path"):
        relative = request.args.get("path")
    else:
        body = request.get_json(silent=True) or {}
        relative = body.get("path")
    if not relative:
        return jsonify({"error": "Path is required.", "code": "invalid"}), 400
    try:
        resolve_within_root(root, relative)
    except Exception as exc:
        return _fs_error_response(exc)
    metadata = MetadataService(
        root,
        current_app.config.get("DATA_DIR"),
        config=current_app.config,
        db_conn=get_db(current_app),
    )
    try:
        metadata.delete_note(relative, note_id)
    except SidecarReadError as exc:
        return jsonify({"error": str(exc), "code": "sidecar-read-error"}), 423
    notes = metadata.get_notes(relative)
    return jsonify({
        "notes": notes,
        "summary": metadata.summarize(notes),
        "path": NoteStore.normalize_path(relative),
    })
