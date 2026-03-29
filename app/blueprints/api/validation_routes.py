from __future__ import annotations

from flask import Response, current_app, jsonify

from ...features.filesystem.service import resolve_within_root
from . import api_bp
from .helpers import _fs_error_response, _json_body, _relative_to_base, _root_or_response
from ...features.metadata.service import MetadataService, SidecarReadError
from ...features.validation.store import ValidationStore
from ...shared.db import get_db


@api_bp.route("/validation", methods=["POST"])
def api_toggle_validation() -> Response:
    """Toggle or set validation state for a file."""

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
        target = resolve_within_root(root, relative)
    except Exception as exc:
        return _fs_error_response(exc)
    if not target.is_file():
        return jsonify({"error": "Validation applies to files only.", "code": "invalid"}), 400
    try:
        canonical = _relative_to_base(root, target)
    except Exception as exc:
        return _fs_error_response(exc)
    metadata = MetadataService(
        root,
        current_app.config.get("DATA_DIR"),
        config=current_app.config,
        db_conn=get_db(current_app),
    )
    try:
        requested = data.get("validated")
        if requested is None:
            flag = metadata.toggle_validation(canonical)
        else:
            flag = metadata.set_validation(canonical, bool(requested))
    except SidecarReadError as exc:
        return jsonify({"error": str(exc), "code": "sidecar-read-error"}), 423
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    return jsonify({
        "path": ValidationStore.normalize_path(canonical),
        "validated": flag,
        "validation": metadata.validation_assignments,
    })
