from __future__ import annotations

from flask import Response, current_app, jsonify, request

from ...shared.db import get_db
from ...features.linked_notes.project_browse import browse_project_root
from . import api_bp
from .helpers import _fs_error_response


@api_bp.route("/projects/<project_id>/browse")
def api_project_browse(project_id: str) -> Response:
    """Browse a project root without switching the active workspace root."""

    conn = get_db(current_app)
    path = request.args.get("path", ".")
    try:
        payload = browse_project_root(conn, project_id, path)
    except KeyError:
        return jsonify({"error": "Project not found.", "code": "not-found"}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    except Exception as exc:
        return _fs_error_response(exc)
    return jsonify(payload)
