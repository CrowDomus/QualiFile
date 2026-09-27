from __future__ import annotations

import logging
import os
import platform
from pathlib import Path
from typing import Any, Dict, List

from flask import Response, current_app, jsonify, request, send_file

from ...features.filesystem.service import (
    copy_items,
    create_file,
    create_folder,
    create_zip_archive,
    delete_items,
    describe_path,
    list_directory,
    move_items,
    numeric_sort_key,
    rename_entry,
    resolve_within_root,
)
from ...features.metadata.service import MetadataService, SidecarReadError
from ...features.preview.text_preview import detect_mime
from ...shared.db import get_db
from ...shared.capability_security import (
    capability_guard,
    is_passive_open_path,
    reject_unknown_fields,
)
from ...shared.internal_paths import is_internal_path
from . import api_bp
from .helpers import (
    EMAIL_ATTACHMENT_COUNT_LIMIT,
    EMAIL_ATTACHMENT_SIZE_LIMIT,
    _apply_notes,
    _apply_tags,
    _apply_validation,
    _auto_rename,
    _browser_children,
    _error_response,
    _fs_error_response,
    _is_internal_name,
    _json_body,
    _launch_default_application,
    _launch_email_with_attachments,
    _parse_template,
    _relative_to_base,
    _resolve_browser_path,
    _reveal_in_explorer,
    _root_or_response,
)


@api_bp.route("/root", methods=["GET", "POST", "DELETE"])
def api_root() -> Response:
    """CRUD endpoint for managing the configured root directory."""

    if request.method == "GET":
        from ... import save_root_path
        root = current_app.config.get("QUALIFILE_ROOT")
        return jsonify({"root": str(root) if root else None})
    if request.method == "DELETE":
        from ... import save_root_path
        current_app.config["QUALIFILE_ROOT"] = None
        save_root_path(
            None,
            state_file=current_app.config.get("ROOT_STATE_FILE"),
            data_dir=current_app.config.get("DATA_DIR"),
            config=current_app.config,
        )
        return jsonify({"status": "cleared"})
    data = _json_body()
    if isinstance(data, Response):
        return data
    raw_path = str(data.get("path", ""))
    cleaned = raw_path.strip()
    if cleaned:
        quote = cleaned[0]
        if quote in {'"', "'"} and cleaned.endswith(quote):
            cleaned = cleaned[1:-1].strip()
    if not cleaned:
        return jsonify({"error": "Please provide a folder path."}), 400
    if platform.system() == "Windows" and cleaned.startswith("\\\\?\\"):
        if cleaned.startswith("\\\\?\\UNC\\"):
            cleaned = "\\\\" + cleaned[len("\\\\?\\UNC\\"):]
        else:
            cleaned = cleaned[4:]
    path = Path(cleaned).expanduser()
    if not path.exists() or not path.is_dir():
        return jsonify({"error": "Selected path is not a directory."}), 400
    current_app.config["QUALIFILE_ROOT"] = path.resolve()
    from ... import save_root_path
    save_root_path(
        path.resolve(),
        state_file=current_app.config.get("ROOT_STATE_FILE"),
        data_dir=current_app.config.get("DATA_DIR"),
        config=current_app.config,
    )
    return jsonify({"root": str(path.resolve())})


@api_bp.route("/tree")
def api_tree() -> Response:
    """Return the folder tree for the client-side navigation pane."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    relative = request.args.get("path", ".")
    try:
        base = resolve_within_root(root, relative)
        if is_internal_path(root, base):
            raise FileNotFoundError(str(base))
        children = []
        for child in sorted(base.iterdir(), key=lambda p: numeric_sort_key(p.name)):
            if _is_internal_name(child.name):
                continue
            if child.is_dir():
                try:
                    has_children = any(c.is_dir() and not _is_internal_name(c.name) for c in child.iterdir())
                except PermissionError:
                    has_children = False
                children.append({
                    "name": child.name,
                    "path": str(child.relative_to(root)),
                    "has_children": has_children,
                })
    except Exception as exc:
        return _fs_error_response(exc)
    return jsonify({"path": str(base.relative_to(root)), "children": children})


@api_bp.route("/root_picker")
def api_root_picker() -> Response:
    """Provide folder listings for the modal root picker component."""

    scope = request.args.get("scope", "root")
    path_arg = request.args.get("path", ".")
    if scope == "system":
        configured = current_app.config.get("QUALIFILE_ROOT")
        if configured:
            configured_path = Path(configured).resolve()
            base = Path(configured_path.anchor or str(configured_path))
        else:
            cwd = Path.cwd().resolve()
            base = Path(cwd.anchor or str(cwd))
        base = base.resolve()
        try:
            target = _resolve_browser_path(base, path_arg)
        except Exception as exc:
            return _fs_error_response(exc)
    else:
        root, response = _root_or_response()
        if response:
            return response
        assert root is not None
        base = root.resolve()
        try:
            target = resolve_within_root(base, path_arg)
        except Exception as exc:
            return _fs_error_response(exc)
    try:
        children = _browser_children(base, target)
    except Exception as exc:
        return _fs_error_response(exc)
    relative = _relative_to_base(base, target)
    payload = {
        "base": str(base),
        "relative": relative,
        "path": relative,
        "absolute": str(target),
        "children": children,
    }
    return jsonify(payload)


@api_bp.route("/list")
def api_list() -> Response:
    """List files/folders within a directory."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    relative = request.args.get("path", ".")
    include = request.args.get("include_subfolders", "false").lower() == "true"
    try:
        data = list_directory(root, relative, include_subfolders=include)
    except Exception as exc:
        return _fs_error_response(exc)
    metadata = MetadataService(
        root,
        current_app.config.get("DATA_DIR"),
        config=current_app.config,
        db_conn=get_db(current_app),
    )
    if include:
        annotated = _apply_tags(data, metadata, assignments=metadata.tag_assignments)
        annotated = _apply_validation(annotated, metadata, assignments=metadata.validation_assignments)
        try:
            annotated = _apply_notes(annotated, metadata)
        except Exception:
            # Notes are optional; fall back silently if anything goes wrong here.
            pass
        validation_map = metadata.validation_assignments
    else:
        if isinstance(data, list):
            validation_map = metadata.apply_listing_metadata(data, relative)
        else:
            validation_map = {}
        annotated = data
    return jsonify({"items": annotated, "tags": metadata.tag_definitions, "validation": validation_map})


@api_bp.route("/create", methods=["POST"])
def api_create() -> Response:
    """Create a file or folder within the current root."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    action = data.get("action")
    path = data.get("path", ".")
    name = data.get("name", "")
    try:
        if action == "folder":
            target = create_folder(root, path, name)
        elif action == "file":
            target = create_file(root, path, name)
        else:
            return jsonify({"error": "Unknown action"}), 400
    except Exception as exc:  # intentionally broad to surface toasts
        return _fs_error_response(exc)
    return jsonify({"created": str(target.relative_to(root))})


@api_bp.route("/rename", methods=["POST"])
def api_rename() -> Response:
    """Rename a file or folder."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    original = data.get("path")
    try:
        result = rename_entry(root, original, data.get("new_name"))
        new_rel = _relative_to_base(root, result)
        metadata = MetadataService(
            root,
            current_app.config.get("DATA_DIR"),
            config=current_app.config,
            db_conn=get_db(current_app),
        )
        try:
            metadata.reassign_path(original or ".", new_rel, is_dir=result.is_dir())
        except SidecarReadError as exc:
            return jsonify({"error": str(exc), "code": "sidecar-read-error"}), 423
        return jsonify({"path": str(result.relative_to(root))})
    except Exception as exc:
        return _fs_error_response(exc)


@api_bp.route("/move_copy", methods=["POST"])
def api_move_copy() -> Response:
    """Move or copy a set of items to a destination folder."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    items = data.get("items", [])
    destination = data.get("destination")
    conflict = data.get("on_conflict", "rename")
    operation = data.get("operation", "move")
    try:
        if operation == "move":
            results = move_items(root, items, destination, conflict)
        elif operation == "copy":
            results = copy_items(root, items, destination, conflict)
        else:
            return jsonify({"error": "Unknown operation"}), 400
    except Exception as exc:
        return _fs_error_response(exc)
    if operation == "move":
        metadata = MetadataService(
            root,
            current_app.config.get("DATA_DIR"),
            config=current_app.config,
            db_conn=get_db(current_app),
        )
        try:
            for entry in results:
                if entry.get("status") != "moved":
                    continue
                source = entry.get("source")
                dest = entry.get("destination")
                if not source or not dest:
                    continue
                try:
                    old_rel = _relative_to_base(root, Path(source))
                    new_rel = _relative_to_base(root, Path(dest))
                except Exception:
                    continue
                try:
                    is_dir = Path(dest).is_dir()
                except Exception:
                    is_dir = False
                metadata.reassign_path(old_rel, new_rel, is_dir=is_dir)
        except SidecarReadError as exc:
            return jsonify({"error": str(exc), "code": "sidecar-read-error"}), 423
    return jsonify({"results": results})


@api_bp.route("/zip", methods=["POST"])
def api_zip() -> Response:
    """Create a ZIP archive from one or more items."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    items = data.get("items", [])
    destination = data.get("destination") or "."
    name = data.get("name")
    try:
        archive = create_zip_archive(root, items, destination, name)
    except Exception as exc:
        return _fs_error_response(exc)
    return jsonify({
        "archive": _relative_to_base(root, archive),
        "name": archive.name,
    })


@api_bp.route("/reveal", methods=["POST"])
@capability_guard("reveal", max_body_bytes=4096)
def api_reveal() -> Response:
    """Reveal a path in the host operating system's file explorer."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    schema_error = reject_unknown_fields(data, {"path", "select"})
    if schema_error is not None:
        return schema_error
    rel = data.get("path", ".")
    if rel is None:
        rel = "."
    elif isinstance(rel, str):
        rel = rel.strip() or "."
    select_raw = data.get("select", False)
    if not isinstance(select_raw, bool):
        return jsonify({"error": "Select must be a boolean.", "code": "invalid"}), 400
    try:
        target = resolve_within_root(root, rel)
        select = select_raw and target.is_file()
        _reveal_in_explorer(target, select)
    except Exception as exc:
        return _fs_error_response(exc)
    return jsonify({"status": "ok"})


@api_bp.route("/delete", methods=["POST"])
def api_delete() -> Response:
    """Delete (soft or hard) the provided filesystem entries."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    try:
        results = delete_items(root, data.get("items", []), permanent=data.get("permanent", False))
    except Exception as exc:
        return _fs_error_response(exc)
    metadata = MetadataService(
        root,
        current_app.config.get("DATA_DIR"),
        config=current_app.config,
        db_conn=get_db(current_app),
    )
    try:
        for entry in results:
            path_text = entry.get("path")
            if not path_text:
                continue
            try:
                relative = _relative_to_base(root, Path(path_text))
            except Exception:
                relative = None
            if relative:
                metadata.clear_path(relative)
    except SidecarReadError as exc:
        return jsonify({"error": str(exc), "code": "sidecar-read-error"}), 423
    return jsonify({"results": results})


@api_bp.route("/metadata")
def api_metadata() -> Response:
    """Return metadata for a single filesystem entry."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    try:
        meta = describe_path(root, request.args.get("path"))
        metadata = MetadataService(
            root,
            current_app.config.get("DATA_DIR"),
            config=current_app.config,
            db_conn=get_db(current_app),
        )
        meta["validated"] = False if meta.get("is_dir") else metadata.is_validated(meta.get("path"))
    except Exception as exc:
        return _fs_error_response(exc)
    return jsonify(meta)


@api_bp.route("/file")
def api_file() -> Response:
    """Stream a file from the configured root directory."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    rel = request.args.get("path")
    if not rel:
        return jsonify({"error": "Path is required.", "code": "invalid"}), 400
    try:
        target = resolve_within_root(root, rel)
    except Exception as exc:
        return _fs_error_response(exc)
    mime = detect_mime(target)
    inline_suffixes = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ico", ".pdf"}
    inline = target.suffix.casefold() in inline_suffixes and (
        mime.startswith("image/") or mime == "application/pdf"
    )
    return send_file(
        target,
        mimetype=mime if inline else "application/octet-stream",
        as_attachment=not inline,
        download_name=target.name,
        conditional=True,
    )


@api_bp.route("/open", methods=["POST"])
@capability_guard("open", max_body_bytes=4096)
def api_open() -> Response:
    """Open a file using the operating system's default application."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    schema_error = reject_unknown_fields(data, {"path"})
    if schema_error is not None:
        return schema_error
    rel = data.get("path")
    if not isinstance(rel, str) or not rel or len(rel) > 4096:
        return jsonify({"error": "Path is required.", "code": "invalid"}), 400
    try:
        target = resolve_within_root(root, rel)
    except Exception as exc:
        return _fs_error_response(exc)
    if not target.is_file():
        return jsonify({"error": "Please select a file, not a folder.", "code": "is-directory"}), 400
    if not is_passive_open_path(target):
        return jsonify({"error": "This file type cannot be opened here.", "code": "blocked-type"}), 400
    try:
        _launch_default_application(target)
    except FileNotFoundError as exc:
        return _fs_error_response(exc)
    except PermissionError as exc:
        return _fs_error_response(exc)
    except IsADirectoryError:
        return jsonify({"error": "Please select a file, not a folder.", "code": "is-directory"}), 400
    except RuntimeError as exc:
        return jsonify({"error": str(exc), "code": "open-failed"}), 500
    except Exception as exc:  # pragma: no cover - defensive catch-all
        return jsonify({"error": f"Unable to open file: {exc}", "code": "open-failed"}), 500
    return jsonify({"status": "launched"})


@api_bp.route("/email", methods=["POST"])
@capability_guard("email", max_body_bytes=32768)
def api_email() -> Response:
    """Open the default mail client with selected files attached."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    schema_error = reject_unknown_fields(data, {"paths"})
    if schema_error is not None:
        return schema_error
    paths_raw = data.get("paths")
    if not isinstance(paths_raw, list) or not paths_raw:
        return jsonify({"error": "Provide at least one file to email.", "code": "invalid"}), 400
    if len(paths_raw) > EMAIL_ATTACHMENT_COUNT_LIMIT:
        return (
            jsonify({
                "error": f"Select {EMAIL_ATTACHMENT_COUNT_LIMIT} or fewer attachments for email.",
                "code": "too-many",
            }),
            400,
        )
    resolved: list[Path] = []
    total_size = 0
    for rel in paths_raw:
        if not rel:
            return jsonify({"error": "All paths must be non-empty.", "code": "invalid"}), 400
        try:
            target = resolve_within_root(root, rel)
        except Exception as exc:
            return _fs_error_response(exc)
        if target.is_dir():
            return jsonify({"error": "Folders cannot be attached. Select files or archives only.", "code": "is-directory"}), 400
        try:
            size = target.stat().st_size
        except Exception as exc:
            return _fs_error_response(exc)
        total_size += size
        resolved.append(target)
    if total_size > EMAIL_ATTACHMENT_SIZE_LIMIT:
        limit_mb = EMAIL_ATTACHMENT_SIZE_LIMIT // (1024 * 1024)
        return (
            jsonify({
                "error": f"Total attachments exceed {limit_mb} MB. Please reduce the selection.",
                "code": "size-limit",
            }),
            400,
        )
    try:
        _launch_email_with_attachments(resolved)
    except FileNotFoundError as exc:
        return _fs_error_response(exc)
    except PermissionError as exc:
        return _fs_error_response(exc)
    except IsADirectoryError:
        return jsonify({"error": "Please select files, not folders.", "code": "is-directory"}), 400
    except RuntimeError as exc:
        return jsonify({"error": str(exc), "code": "email-failed"}), 500
    except Exception as exc:  # pragma: no cover - defensive catch-all
        return jsonify({"error": f"Unable to start the email client: {exc}", "code": "email-failed"}), 500
    return jsonify({"status": "launched"})


@api_bp.route("/import", methods=["POST"])
def api_import_structure() -> Response:
    """Create folders/files from a plain text structure template."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    file = request.files.get("template")
    destination = request.form.get("destination", ".")
    mode = request.form.get("mode", "preview")
    collision_mode = request.form.get("collision", "skip")
    label_mode = request.form.get("label_mode", "full")
    if label_mode not in {"full", "numeric"}:
        label_mode = "full"
    if collision_mode not in {"skip", "merge", "rename"}:
        collision_mode = "skip"
    if not file:
        return _error_response("invalid", "No template provided.", 400, log_level=logging.INFO)
    text = file.read().decode("utf-8", errors="replace")
    try:
        plan = _parse_template(text, label_mode=label_mode)
    except ValueError as exc:
        return _error_response("invalid", str(exc), 400, log_level=logging.INFO)
    try:
        dest = resolve_within_root(root, destination)
    except Exception as exc:
        return _fs_error_response(exc)
    preview: List[Dict[str, Any]] = []
    collisions: List[str] = []
    created: List[str] = []
    for item in plan:
        relative_path = Path(destination) / Path(item["path"])
        try:
            target = resolve_within_root(root, relative_path)
        except Exception as exc:
            return _fs_error_response(exc)
        rel_display = str(target.relative_to(root))
        exists = target.exists()
        preview.append({
            "path": rel_display,
            "is_dir": item["is_dir"],
            "exists": exists,
        })
        if exists:
            collisions.append(rel_display)
    if mode == "preview":
        return jsonify({"preview": preview, "collisions": collisions})
    for item in plan:
        relative_path = Path(destination) / Path(item["path"])
        target = resolve_within_root(root, relative_path)
        final_target = target
        if target.exists():
            if collision_mode == "skip":
                continue
            if collision_mode == "merge":
                if item["is_dir"]:
                    continue
                # cannot merge files; skip to protect data
                continue
            if collision_mode == "rename":
                final_target = _auto_rename(target)
        if item["is_dir"]:
            final_target.mkdir(parents=True, exist_ok=True)
        else:
            final_target.parent.mkdir(parents=True, exist_ok=True)
            final_target.touch(exist_ok=True)
        created.append(str(final_target.relative_to(root)))
    return jsonify({"created": created, "collisions": collisions, "preview": preview})
