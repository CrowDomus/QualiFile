from __future__ import annotations

from flask import Response, current_app, jsonify

from ...features.filesystem.service import PathOutsideRootError
from ...features.linked_notes.service import create_linked_note_for_project, list_linked_notes_for_project
from ...features.metadata.service import SidecarReadError
from ...shared.db import get_db
from . import api_bp
from .helpers import _fs_error_response, _json_body


@api_bp.route("/projects/<project_id>/linked-notes", methods=["GET"])
def api_project_linked_notes(project_id: str) -> Response:
    """Return linked notes for the provided project root."""

    conn = get_db(current_app)
    try:
        payload = list_linked_notes_for_project(
            conn,
            current_app.config.get("DATA_DIR"),
            current_app.config,
            project_id,
        )
    except KeyError:
        return jsonify({"error": "Project not found.", "code": "not-found"}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    except FileNotFoundError:
        return jsonify({"error": "Project root is unavailable.", "code": "root-missing"}), 404
    return jsonify(payload)


@api_bp.route("/projects/<project_id>/linked-notes", methods=["POST"])
def api_create_project_linked_note(project_id: str) -> Response:
    """Create a linked note inside the project's root."""

    data = _json_body()
    if isinstance(data, Response):
        return data
    conn = get_db(current_app)
    try:
        payload = create_linked_note_for_project(
            conn,
            current_app.config.get("DATA_DIR"),
            current_app.config,
            project_id,
            data,
        )
    except KeyError:
        return jsonify({"error": "Project not found.", "code": "not-found"}), 404
    except SidecarReadError as exc:
        return jsonify({"error": str(exc), "code": "sidecar-read-error"}), 423
    except FileNotFoundError:
        return jsonify({"error": "Project root is unavailable.", "code": "root-missing"}), 404
    except ValueError as exc:
        if isinstance(exc, PathOutsideRootError):
            return _fs_error_response(exc)
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    except Exception as exc:
        return _fs_error_response(exc)
    return jsonify(payload)

