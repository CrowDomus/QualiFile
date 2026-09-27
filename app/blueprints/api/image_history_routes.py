"""Workspace-scoped editable annotation and history endpoints."""

from flask import Response, current_app, jsonify, request, send_file
import io

from . import api_bp
from .helpers import _root_or_response, _fs_error_response, _json_body
from ...shared.db import get_db
from ...shared.capability_security import capability_guard
from ...features.preview.image_history import ImageHistory, IMAGE_LOCK


def image_history(root):
    return ImageHistory(get_db(current_app), root, current_app.config["DATA_DIR"])


@api_bp.route("/image-history/settings", methods=["GET"])
def image_history_settings():
    root, response = _root_or_response()
    if response:
        return response
    try:
        with IMAGE_LOCK:
            service = image_history(root)
            return jsonify(service.settings())
    except Exception as exc:
        return _fs_error_response(exc)


@api_bp.route("/image-history/document")
def image_history_document():
    root, response = _root_or_response()
    if response:
        return response
    try:
        with IMAGE_LOCK:
            service = image_history(root)
            _, state = service.document(request.args.get("path", ""))
            asset = request.args.get("asset")
            if asset:
                if asset not in {"base", "overlay"} or not state.get(asset):
                    raise ValueError("Annotation asset not found.")
                response = send_file(io.BytesIO(service._read_blob(state[asset])), mimetype="image/png" if asset == "overlay" else None, download_name="base" + service.target(request.args["path"]).suffix)
                response.headers["Cache-Control"] = "no-store"
                return response
            return jsonify({"document": state["document"], "hash": state["hash"]})
    except Exception as exc:
        return _fs_error_response(exc)


@api_bp.route("/image-history/duplicate", methods=["POST"])
@capability_guard("annotation", max_body_bytes=1024 * 1024)
def duplicate_image_annotations():
    root, response = _root_or_response()
    if response:
        return response
    data = _json_body()
    if isinstance(data, Response):
        return data
    try:
        targets = data.get("targets")
        if not isinstance(targets, list) or not 1 <= len(targets) <= 500 or any(not isinstance(path, str) for path in targets):
            raise ValueError("Select between 1 and 500 images.")
        preserve_existing = data.get("preserve_existing", False)
        if not isinstance(preserve_existing, bool):
            raise ValueError("Preserve existing annotations must be true or false.")
        return jsonify({"results": image_history(root).duplicate(data.get("reference", ""), targets, preserve_existing=preserve_existing)})
    except Exception as exc:
        return _fs_error_response(exc)


@api_bp.route("/image-history/versions", methods=["GET", "POST"])
@capability_guard("annotation", max_body_bytes=1024 * 1024)
def image_versions():
    root, response = _root_or_response()
    if response:
        return response
    try:
        with IMAGE_LOCK:
            service = image_history(root)
            if request.method == "POST":
                data = _json_body()
                if isinstance(data, Response):
                    return data
                service.restore(data.get("path", ""), data.get("version_id"), data.get("hash"))
                return jsonify({"restored": True})
            path = request.args.get("path", "")
            if request.args.get("version_id"):
                binary, _ = service.version(path, request.args["version_id"])
                response = send_file(io.BytesIO(binary), download_name=service.target(path).name)
                response.headers["Cache-Control"] = "no-store"
                return response
            _, state = service.document(path)
            return jsonify({"versions": service.versions(path), "hash": state["hash"]})
    except Exception as exc:
        return _fs_error_response(exc)
