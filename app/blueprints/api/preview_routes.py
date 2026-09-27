from __future__ import annotations

import base64
import io
import os
import re
import tempfile
from contextlib import suppress
from pathlib import Path

from flask import Response, current_app, jsonify, request, send_file, url_for
from pypdf import PdfReader
from PIL import Image, UnidentifiedImageError

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
from ...shared.capability_security import capability_guard
from ...shared.preferences import get_preference
from ...features.preview.image_history import ImageHistory, decode_overlay, digest, image_size
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


def _office_preview_accelerated() -> bool:
    data_dir = Path(current_app.config.get("DATA_DIR") or current_app.instance_path)
    try:
        return get_preference(data_dir, current_app.config, "office_preview_accelerated") != "0"
    except Exception:
        return False


_PREVIEW_BODY_KEYS = frozenset({"path", "offset", "length", "cancel_token"})
_MAX_PREVIEW_PATH_LENGTH = 4096
_MAX_PREVIEW_CHUNK_BYTES = 1024 * 1024
_MAX_PREVIEW_OFFSET = (1 << 63) - 1
_CANCEL_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{16,128}$")


def _preview_request_body() -> tuple[dict, Response | None]:
    data = _json_body()
    if isinstance(data, Response):
        return {}, data
    if set(data) - _PREVIEW_BODY_KEYS:
        return {}, (jsonify({"error": "Preview request contains unsupported fields.", "code": "invalid"}), 400)
    rel = data.get("path")
    if not isinstance(rel, str) or not rel or len(rel) > _MAX_PREVIEW_PATH_LENGTH:
        return {}, (jsonify({"error": "A valid path is required.", "code": "invalid"}), 400)
    offset = data.get("offset", 0)
    length = data.get("length", 8192)
    if isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= _MAX_PREVIEW_OFFSET:
        return {}, (jsonify({"error": "Preview offset is invalid.", "code": "invalid"}), 400)
    if isinstance(length, bool) or not isinstance(length, int) or not 1 <= length <= _MAX_PREVIEW_CHUNK_BYTES:
        return {}, (jsonify({"error": "Preview length is invalid.", "code": "invalid"}), 400)
    cancel_token = data.get("cancel_token")
    if cancel_token is not None and (
        not isinstance(cancel_token, str) or _CANCEL_TOKEN_PATTERN.fullmatch(cancel_token) is None
    ):
        return {}, (jsonify({"error": "Preview cancellation token is invalid.", "code": "invalid"}), 400)
    return {
        "path": rel,
        "offset": offset,
        "length": length,
        "cancel_token": cancel_token,
    }, None


@api_bp.route("/preview", methods=["POST"])
@capability_guard("preview", max_body_bytes=256 * 1024)
def api_preview() -> Response:
    """Return preview data for files (text, images, PDFs, binaries)."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data, error = _preview_request_body()
    if error is not None:
        return error
    rel = data["path"]
    offset = data["offset"]
    length = data["length"]
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
        cancel_token = data["cancel_token"]
        if OfficePreviewRenderer.is_supported_document(target):
            renderer = OfficePreviewRenderer(
                _office_cache_dir(), quality=_office_preview_quality(),
                accelerated=_office_preview_accelerated(),
            )
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
@capability_guard("preview_cancel", max_body_bytes=4096)
def api_preview_cancel() -> Response:
    """Signal cancellation of an in-progress Office preview conversion."""

    data = _json_body()
    if isinstance(data, Response):
        return data
    if set(data) != {"token"}:
        return jsonify({"error": "Cancellation requires exactly one token.", "code": "invalid"}), 400
    token = data.get("token")
    if not isinstance(token, str) or _CANCEL_TOKEN_PATTERN.fullmatch(token) is None:
        return jsonify({"error": "Cancellation token is invalid.", "code": "invalid"}), 400
    cancelled = cancel_preview(token)
    return jsonify({"status": "cancelled" if cancelled else "not-found"})


@api_bp.route("/annotate", methods=["POST"])
@capability_guard("annotation", max_body_bytes=60 * 1024 * 1024)
def api_save_annotation() -> Response:
    """Persist an annotated image either in-place or as a sibling copy."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None

    data = _json_body()
    if isinstance(data, Response):
        return data
    if set(data) - {"path", "mode", "data_url", "filename", "document", "overlay", "expected_hash"}:
        return jsonify({"error": "Unsupported annotation fields.", "code": "invalid"}), 400
    rel = data.get("path")
    mode_raw = data.get("mode", "overwrite")
    if not isinstance(mode_raw, str):
        return jsonify({"error": "Invalid save mode.", "code": "invalid"}), 400
    mode = mode_raw.lower()
    data_url = data.get("data_url") or ""
    filename_raw = data.get("filename", "")
    if not isinstance(filename_raw, str):
        return jsonify({"error": "Invalid file name.", "code": "invalid"}), 400
    requested_name = filename_raw.strip()

    if not isinstance(rel, str) or not rel or len(rel) > 4096:
        return jsonify({"error": "Path is required.", "code": "invalid"}), 400
    if not isinstance(data_url, str) or len(data_url) > 28 * 1024 * 1024:
        return jsonify({"error": "Annotation data is too large.", "code": "too-large"}), 413
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

    if len(binary) > 20 * 1024 * 1024:
        return jsonify({"error": "Annotation image is too large.", "code": "too-large"}), 413
    expected_format = {
        "image/png": "PNG",
        "image/jpeg": "JPEG",
        "image/jpg": "JPEG",
        "image/webp": "WEBP",
    }[mime]
    try:
        with Image.open(io.BytesIO(binary)) as image:
            width, height = image.size
            if (
                image.format != expected_format
                or width > 8192
                or height > 8192
                or width * height > 40_000_000
            ):
                raise ValueError
            image.verify()
    except (UnidentifiedImageError, OSError, ValueError):
        return jsonify({"error": "Annotation image content is invalid.", "code": "invalid"}), 400

    try:
        target = resolve_within_root(root, rel)
        if not target.is_file():
            raise FileNotFoundError(f"'{target}' is unavailable.")
        if target.suffix.casefold() not in {".png", ".jpg", ".jpeg", ".webp"}:
            return jsonify({"error": "Only supported images can be annotated.", "code": "invalid-format"}), 400
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
        service = ImageHistory(get_db(current_app), root, current_app.config["DATA_DIR"])
        _, previous = service.document(rel)
        document = data.get("document")
        restored = None
        if document is not None:
            overlay = decode_overlay(data.get("overlay"), image_size(binary))
            expected = data.get("expected_hash")
        else:
            # Legacy clients still save flattened images without reusable shapes.
            width, height = image_size(binary)
            document = {"version": 1, "width": width, "height": height, "nodes": []}
            overlay = None
            expected = previous["hash"]
            restored = {"hash": digest(binary), "base": service._blob(binary), "overlay": None, "document": document}
        service.save(rel, binary, document, overlay, expected,
                     destination=_relative_to_base(root, destination) if mode == "copy" else None,
                     restored_state=restored)
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
        if not base.is_dir():
            return None
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


