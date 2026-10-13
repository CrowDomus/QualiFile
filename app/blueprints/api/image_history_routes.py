"""Workspace-scoped editable annotation and history endpoints."""

from flask import Response, current_app, jsonify, request, send_file
import io
import json
from pathlib import Path

from . import api_bp
from .helpers import _root_or_response, _fs_error_response, _json_body
from ...shared.db import get_db, open_connection, load_db_settings
from ...shared.capability_security import capability_guard
from ...features.preview.image_history import ImageHistory, IMAGE_LOCK, history_for_path


def image_history(root, path=""):
    return history_for_path(get_db(current_app), root, current_app.config["DATA_DIR"], path)


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
            service = image_history(root, request.args.get("path", ""))
            _, state = service.document(request.args.get("path", ""))
            asset = request.args.get("asset")
            if asset:
                if asset not in {"base", "overlay"} or not state.get(asset):
                    raise ValueError("Annotation asset not found.")
                mime = "image/png" if asset == "overlay" else "application/pdf" if Path(request.args["path"]).suffix.lower() == ".pdf" else None
                response = send_file(io.BytesIO(service._read_blob(state[asset])), mimetype=mime, download_name="base" + service.target(request.args["path"]).suffix)
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
        service = image_history(root)
        reference = data.get("reference", "")
        if request.accept_mimetypes.best == "application/x-ndjson":
            with IMAGE_LOCK:
                _, source = service.document(reference)
                if not source["document"]["nodes"] or not source["overlay"]:
                    raise ValueError("The reference image does not have annotations.")
            settings = load_db_settings(current_app)
            data_dir = current_app.config["DATA_DIR"]
            def progress():
                # Streaming outlives Flask's normal request teardown. Own this
                # connection for precisely the generator's lifetime.
                connection = open_connection(settings)
                try:
                    stream_service = ImageHistory(connection, root, data_dir)
                    for row in stream_service.iter_duplicate(reference, targets, preserve_existing=preserve_existing):
                        yield json.dumps(row) + "\n"
                    yield json.dumps({"complete": True}) + "\n"
                finally:
                    connection.close()
            return Response(progress(), mimetype="application/x-ndjson", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
        return jsonify({"results": service.duplicate(reference, targets, preserve_existing=preserve_existing)})
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
            if request.method == "POST":
                data = _json_body()
                if isinstance(data, Response):
                    return data
                service = image_history(root, data.get("path", ""))
                service.restore(data.get("path", ""), data.get("version_id"), data.get("hash"))
                return jsonify({"restored": True})
            path = request.args.get("path", "")
            service = image_history(root, path)
            if request.args.get("version_id"):
                binary, _ = service.version(path, request.args["version_id"])
                response = send_file(io.BytesIO(binary), download_name=service.target(path).name)
                response.headers["Cache-Control"] = "no-store"
                return response
            _, state = service.document(path)
            return jsonify({"versions": service.versions(path), "hash": state["hash"]})
    except Exception as exc:
        return _fs_error_response(exc)


@api_bp.route("/pdf-annotations", methods=["POST"])
@capability_guard("annotation", max_body_bytes=20 * 1024 * 1024)
def save_pdf_annotations():
    root, response = _root_or_response()
    if response:
        return response
    data = _json_body()
    if isinstance(data, Response):
        return data
    try:
        from ...features.filesystem.service import safe_secure_filename
        from ...features.preview.pdf_annotations import PdfHistory
        if set(data) - {"path", "mode", "filename", "document", "expected_hash"}:
            raise ValueError("Unexpected PDF annotation fields.")
        path = data.get("path", "")
        mode = data.get("mode", "overwrite")
        if not isinstance(path, str) or mode not in {"copy", "overwrite"}:
            raise ValueError("Invalid PDF save request.")
        service = PdfHistory(get_db(current_app), root, current_app.config["DATA_DIR"])
        destination = None
        if mode == "copy":
            name = data.get("filename") or (Path(path).stem + "-annotated.pdf")
            if not isinstance(name, str) or '/' in name or '\\' in name:
                raise ValueError("Enter a filename without folders.")
            name = safe_secure_filename(name)
            if not name or Path(name).suffix.lower() != '.pdf':
                raise ValueError("The annotated copy must have a .pdf extension.")
            destination = (Path(path).parent / name).as_posix()
        after = service.save_pdf(path, data.get("document"), data.get("expected_hash"), destination=destination)
        return jsonify({"path": destination or path, "mode": mode, "mime": "application/pdf", "hash": after["hash"]})
    except Exception as exc:
        return _fs_error_response(exc)
