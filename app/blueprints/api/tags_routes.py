from __future__ import annotations

from flask import Response, current_app, jsonify, request

from ...features.filesystem.service import resolve_within_root
from ...features.metadata.service import MetadataService, SidecarReadError
from . import api_bp
from .helpers import _fs_error_response, _json_body, _root_or_response
from ...features.tags.store import TagStore, _NO_CHANGE
from ...features.tags.db_store import TagDefinitionDBStore
from ...shared.db import get_db


@api_bp.route("/tags", methods=["GET"])
def api_get_tags() -> Response:
    """Return all defined tags and current assignments."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    db_conn = get_db(current_app)
    metadata = MetadataService(
        root,
        current_app.config.get("DATA_DIR"),
        config=current_app.config,
        db_conn=db_conn,
    )
    tags = TagDefinitionDBStore(db_conn, root).list_tags()
    return jsonify({"tags": tags, "assignments": metadata.tag_assignments})


@api_bp.route("/tags", methods=["POST"])
def api_create_tag() -> Response:
    """Create a new tag definition."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    db_store = TagDefinitionDBStore(get_db(current_app), root)
    try:
        tag = db_store.create_tag(data.get("name", ""), data.get("color"), data.get("parent_id"))
        if "show_header" in data:
            tag = db_store.update_tag(tag["id"], show_header=data.get("show_header"))
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    return jsonify({"tag": tag, "tags": db_store.list_tags()})


@api_bp.route("/tags/<tag_id>", methods=["PATCH"])
def api_update_tag(tag_id: str) -> Response:
    """Rename or recolour a tag."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    parent_value = data.get("parent_id") if "parent_id" in data else _NO_CHANGE
    db_store = TagDefinitionDBStore(get_db(current_app), root)
    try:
        tag = db_store.update_tag(
            tag_id,
            name=data.get("name"),
            color=data.get("color"),
            show_header=data.get("show_header"),
            parent_id=parent_value,
        )
    except KeyError:
        return jsonify({"error": "Tag not found.", "code": "not-found"}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    return jsonify({"tag": tag, "tags": db_store.list_tags()})


@api_bp.route("/tags/<tag_id>", methods=["DELETE"])
def api_delete_tag(tag_id: str) -> Response:
    """Delete a tag and remove its assignments."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    db_conn = get_db(current_app)
    db_store = TagDefinitionDBStore(db_conn, root)
    try:
        db_store.delete_tag(tag_id)
    except KeyError:
        return jsonify({"error": "Tag not found.", "code": "not-found"}), 404
    metadata = MetadataService(
        root,
        current_app.config.get("DATA_DIR"),
        config=current_app.config,
        db_conn=db_conn,
    )
    try:
        metadata.remove_tag_assignments(tag_id)
    except SidecarReadError as exc:
        return jsonify({"error": str(exc), "code": "sidecar-read-error"}), 423
    return jsonify({"tags": db_store.list_tags(), "assignments": metadata.tag_assignments})


@api_bp.route("/tags/assign", methods=["POST"])
def api_assign_tags() -> Response:
    """Assign tags to a particular file."""

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
        assigned = metadata.assign_tags(relative, data.get("tags", []))
    except SidecarReadError as exc:
        return jsonify({"error": str(exc), "code": "sidecar-read-error"}), 423
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    return jsonify({"path": TagStore.normalize_path(relative), "tags": assigned})
