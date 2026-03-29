from __future__ import annotations

import base64
import re
from contextlib import suppress
from pathlib import Path

from flask import Response, current_app, jsonify, request, send_file, url_for
from PyPDF2 import PdfReader

from ...features.filesystem.service import describe_path, resolve_within_root, safe_secure_filename
from ...features.preview.office_preview import (
    OfficePreviewCancelledError,
    OfficePreviewError,
    OfficePreviewRenderer,
    OfficePreviewUnavailableError,
    cancel_preview,
)
from ...features.preview.text_preview import detect_code_language, detect_mime, is_probably_textual, read_text_preview
from ...features.metadata.service import MetadataService
from ...shared.db import get_db
from ...shared.preferences import get_preference
from . import api_bp
from .helpers import (
    _fs_error_response,
    _json_body,
    _office_cache_dir,
    _preview_cache_dir,
    _relative_to_base,
    _root_or_response,
)


def _normalize_office_preview_quality(value: object) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"fast", "standard"}:
        return normalized
    return "standard"


def _office_preview_quality() -> str:
    data_dir = Path(current_app.config.get("DATA_DIR") or current_app.instance_path)
    try:
        stored = get_preference(data_dir, current_app.config, "office_preview_quality")
    except Exception:
        return "fast"
    if stored is None:
        return "fast"
    return _normalize_office_preview_quality(stored)


@api_bp.route("/preview")
def api_preview() -> Response:
    """Return preview data for files (text, images, PDFs, binaries)."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    rel = request.args.get("path")
    if not rel:
        return jsonify({"error": "Path is required.", "code": "invalid"}), 400
    offset = int(request.args.get("offset", 0))
    length_param = request.args.get("length")
    length = int(length_param) if length_param not in (None, "") else None
    try:
        target = resolve_within_root(root, rel)
        metadata = describe_path(root, rel)
        meta_service = MetadataService(
            root,
            current_app.config.get("DATA_DIR"),
            config=current_app.config,
            db_conn=get_db(current_app),
        )
        metadata["validated"] = False if metadata.get("is_dir") else meta_service.is_validated(metadata.get("path"))
        stat_info = target.stat()
        cache_bust = getattr(stat_info, "st_mtime_ns", None)
        if cache_bust is None:
            cache_bust = int(stat_info.st_mtime * 1_000_000_000)
        mime = detect_mime(target)
        language = detect_code_language(target)
        cancel_token = request.headers.get("X-Qualifile-Cancel-Token") or request.args.get("cancel_token")
        if OfficePreviewRenderer.is_supported_document(target):
            renderer = OfficePreviewRenderer(_office_cache_dir(), quality=_office_preview_quality())
            try:
                artifact = renderer.prepare_preview(target, cancel_token=cancel_token)
            except OfficePreviewCancelledError:
                return jsonify({
                    "type": "notice",
                    "notice": "Office preview was cancelled.",
                    "metadata": metadata,
                })
            except OfficePreviewUnavailableError as exc:
                current_app.logger.debug(
                    "Office preview unavailable (%s): %s",
                    target.suffix.lower(),
                    type(exc).__name__,
                )
                return jsonify({
                    "type": "notice",
                    "notice": "Office preview is unavailable on this system. (office-preview-unavailable)",
                    "metadata": metadata,
                })
            except OfficePreviewError as exc:
                current_app.logger.warning(
                    "Office preview failed (%s): %s",
                    target.suffix.lower(),
                    type(exc).__name__,
                )
                return jsonify({
                    "type": "notice",
                    "notice": "Unable to preview this Office document. Try switching Office preview quality to Standard or open the file externally. (office-preview-error)",
                    "metadata": metadata,
                })
            file_url = url_for("api.api_preview_artifact", token=artifact.token, _external=False)
            return jsonify({
                "type": "pdf",
                "mime": artifact.mime,
                "url": file_url,
                "pages": artifact.pages,
                "metadata": metadata,
            })
        if language:
            content, has_more, next_offset, total_size = read_text_preview(target, offset=offset, length=length)
            return jsonify({
                "type": "code",
                "language": language,
                "content": content,
                "has_more": has_more,
                "next_offset": next_offset,
                "offset": offset,
                "total_size": total_size,
                "metadata": metadata,
                "mime": mime,
            })
        if is_probably_textual(mime):
            content, has_more, next_offset, total_size = read_text_preview(target, offset=offset, length=length)
            return jsonify({
                "type": "text",
                "content": content,
                "has_more": has_more,
                "next_offset": next_offset,
                "offset": offset,
                "total_size": total_size,
                "metadata": metadata,
                "mime": mime,
            })
        file_url = url_for("api.api_file", path=rel, v=cache_bust, _external=False)
        if mime.startswith("image/"):
            return jsonify({
                "type": "image",
                "mime": mime,
                "url": file_url,
                "metadata": metadata,
            })
        if mime == "application/pdf":
            page_count = None
            try:
                with target.open("rb") as handle:
                    reader = PdfReader(handle)
                    try:
                        page_count = len(reader.pages)
                    finally:
                        close_reader = getattr(reader, "close", None)
                        if callable(close_reader):
                            with suppress(Exception):
                                close_reader()  # type: ignore[misc]
                        else:
                            stream = getattr(reader, "stream", None)
                            if hasattr(stream, "close"):
                                with suppress(Exception):
                                    stream.close()
            except Exception:
                page_count = None
            return jsonify({
                "type": "pdf",
                "mime": mime,
                "url": file_url,
                "pages": page_count,
                "metadata": metadata,
            })
        return jsonify({
            "type": "binary",
            "mime": mime,
            "url": file_url,
            "metadata": metadata,
        })
    except Exception as exc:
        return _fs_error_response(exc)


@api_bp.route("/preview/cancel", methods=["POST"])
def api_preview_cancel() -> Response:
    """Signal cancellation of an in-progress Office preview conversion."""

    data = _json_body()
    if isinstance(data, Response):
        return data
    token = str(data.get("token") or "").strip()
    if not token:
        return jsonify({"status": "ignored", "reason": "missing-token"})
    cancelled = cancel_preview(token)
    return jsonify({"status": "cancelled" if cancelled else "not-found"})


@api_bp.route("/annotate", methods=["POST"])
def api_save_annotation() -> Response:
    """Persist an annotated image either in-place or as a sibling copy."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None

    data = _json_body()
    if isinstance(data, Response):
        return data
    rel = data.get("path")
    mode = (data.get("mode") or "overwrite").lower()
    data_url = data.get("data_url") or ""
    requested_name = (data.get("filename") or "").strip()

    if not rel:
        return jsonify({"error": "Path is required.", "code": "invalid"}), 400
    if mode not in {"overwrite", "copy"}:
        return jsonify({"error": "Invalid save mode.", "code": "invalid"}), 400
    match = re.match(r"^data:(image/(?:png|jpe?g|webp));base64,(.+)$", data_url, re.IGNORECASE)
    if not match:
        return jsonify({"error": "Annotation data is invalid.", "code": "invalid"}), 400
    mime = match.group(1).lower()
    payload = match.group(2)
    extension_map = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/webp": ".webp",
    }
    extension = extension_map.get(mime)
    if not extension:
        return jsonify({"error": f"Unsupported image format: {mime}", "code": "invalid-format"}), 400
    try:
        binary = base64.b64decode(payload, validate=True)
    except Exception as exc:
        return jsonify({"error": f"Unable to decode annotation data: {exc}", "code": "invalid"}), 400

    try:
        target = resolve_within_root(root, rel)
        if not target.is_file():
            raise FileNotFoundError(f"'{target}' is unavailable.")
        destination = target
        if mode == "copy":
            base_name = requested_name or f"{target.stem}-annotated"
            clean = safe_secure_filename(base_name)
            if not clean:
                return jsonify({"error": "File name cannot be empty.", "code": "invalid"}), 400
            candidate = Path(clean)
            if candidate.suffix.lower() != extension:
                candidate = candidate.with_suffix(extension)
            destination = target.parent / candidate.name
            if destination.exists():
                return jsonify({"error": "A file with this name already exists.", "code": "conflict"}), 409
        destination.write_bytes(binary)
        relative = _relative_to_base(root, destination)
    except Exception as exc:
        return _fs_error_response(exc)
    return jsonify({"path": relative, "mode": mode, "mime": mime})


@api_bp.route("/preview_artifact/<token>")
def api_preview_artifact(token: str) -> Response:
    """Serve cached preview artifacts such as Office-to-PDF conversions."""

    safe_token = Path(token).name
    if not safe_token:
        return jsonify({"error": "Preview artifact missing.", "code": "preview-missing"}), 404

    def _try_resolve(base: Path) -> Path | None:
        base.mkdir(parents=True, exist_ok=True)
        candidate = (base / safe_token).resolve()
        try:
            candidate.relative_to(base.resolve())
        except ValueError:
            return None
        return candidate if candidate.exists() else None

    cache_dirs = [_office_cache_dir(), _preview_cache_dir()]
    artifact_path = None
    for base in cache_dirs:
        artifact_path = _try_resolve(base)
        if artifact_path:
            break

    if not artifact_path:
        return jsonify({"error": "Preview artifact missing.", "code": "preview-missing"}), 404

    return send_file(artifact_path, mimetype=detect_mime(artifact_path), conditional=True)


