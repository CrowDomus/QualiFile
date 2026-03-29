from __future__ import annotations

import ctypes
import json
import math
import os
import platform
import shlex
import shutil
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, List

from flask import Response, current_app, jsonify, request
from PyPDF2 import PdfReader

from ...features.filesystem.service import resolve_within_root, safe_secure_filename
from ...features.preview.merge import MergeError, extract_pdf_pages, images_to_pdf, merge_pdfs
from ...shared.preferences import get_preference, set_preference
from . import api_bp
from .helpers import (
    _auto_rename,
    _fs_error_response,
    _json_body,
    _reveal_in_explorer,
    _root_or_response,
)


def _log_file_path() -> Path:
    """Return the path used to persist activity logs."""

    configured = current_app.config.get("LOG_FILE")
    if configured:
        return Path(configured)
    return Path(current_app.instance_path) / "activity.log"


def _clear_cache_dir(path: Path) -> tuple[int, int]:
    """Delete files and subdirectories under ``path`` without following symlinks."""

    deleted_files = 0
    deleted_dirs = 0
    if not path.exists():
        return (0, 0)
    for root, dirs, files in os.walk(path):
        root_path = Path(root)
        for file in files:
            target = root_path / file
            try:
                if target.is_symlink():
                    target.unlink(missing_ok=True)
                    deleted_files += 1
                else:
                    target.unlink(missing_ok=True)
                    deleted_files += 1
            except Exception:
                continue
        for directory in dirs:
            target_dir = root_path / directory
            try:
                if target_dir.is_symlink():
                    target_dir.unlink(missing_ok=True)
                    deleted_dirs += 1
                else:
                    shutil.rmtree(target_dir, ignore_errors=True)
                    deleted_dirs += 1
            except Exception:
                continue
    return deleted_files, deleted_dirs


def _tail_file(path: Path, max_lines: int = 500, max_bytes: int = 262144) -> str:
    """Return the last ``max_lines`` lines from ``path`` capped by ``max_bytes``."""

    if not path.exists():
        return ""
    with path.open("rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        offset = max(0, size - max_bytes)
        handle.seek(offset, os.SEEK_SET)
        data = handle.read().splitlines()
    tail = data[-max_lines:] if max_lines else data
    return b"\n".join(tail).decode("utf-8", errors="replace")


def _parse_page_ranges(expression: str, total_pages: int) -> List[int]:
    """Return a sorted list of page numbers based on the provided expression."""

    tokens = [token.strip() for token in expression.split(",") if token.strip()]
    if not tokens:
        raise ValueError("Enter at least one page number.")
    pages: List[int] = []
    seen: set[int] = set()
    for token in tokens:
        if "-" in token:
            start_raw, end_raw = (part.strip() for part in token.split("-", 1))
        else:
            start_raw = end_raw = token
        try:
            start = int(start_raw)
            end = int(end_raw)
        except ValueError as exc:
            raise ValueError(f"Invalid page selection: '{token}'.") from exc
        if start < 1 or end < 1:
            raise ValueError("Page numbers must be positive.")
        if start > end:
            raise ValueError(f"Range '{token}' must be ascending.")
        if end > total_pages:
            raise ValueError(f"Pages must be between 1 and {total_pages}.")
        for number in range(start, end + 1):
            if number not in seen:
                seen.add(number)
                pages.append(number)
    if not pages:
        raise ValueError("Enter at least one valid page number.")
    return pages


_HOTKEY_CODES: dict[str, int] = {
    "ctrl": 0x11,
    "control": 0x11,
    "shift": 0x10,
    "alt": 0x12,
    "menu": 0x12,
    "win": 0x5B,
    "windows": 0x5B,
    "command": 0x5B,
    "cmd": 0x5B,
    "super": 0x5B,
    "printscreen": 0x2C,
    "prtsc": 0x2C,
    "prtscr": 0x2C,
    "prtscn": 0x2C,
    "space": 0x20,
    "spacebar": 0x20,
    "tab": 0x09,
    "enter": 0x0D,
    "return": 0x0D,
    "escape": 0x1B,
    "esc": 0x1B,
    "delete": 0x2E,
    "del": 0x2E,
    "backspace": 0x08,
    "insert": 0x2D,
    "home": 0x24,
    "end": 0x23,
    "pageup": 0x21,
    "pagedown": 0x22,
    "up": 0x26,
    "down": 0x28,
    "left": 0x25,
    "right": 0x27,
}


def _parse_hotkey_combo(combo: str) -> List[int]:
    """Translate a ``+`` separated hotkey string into virtual key codes."""

    keys: List[int] = []
    for part in (segment.strip() for segment in combo.split("+")):
        if not part:
            continue
        lower = part.lower()
        if len(lower) == 1 and lower.isprintable():
            if lower.isalpha():
                keys.append(ord(lower.upper()))
                continue
            if lower.isdigit():
                keys.append(ord(lower))
                continue
        if lower.startswith("f") and lower[1:].isdigit():
            index = int(lower[1:])
            if 1 <= index <= 24:
                keys.append(0x70 + (index - 1))
                continue
        code = _HOTKEY_CODES.get(lower)
        if code is None:
            raise ValueError(f"Unsupported key '{part}' in Greenshot hotkey.")
        keys.append(code)
    if not keys:
        raise ValueError("Hotkey must include at least one key.")
    return keys


def _resolve_hotkey_sequence(combo: str) -> List[int]:
    """Validate availability and return the sequence for ``combo``."""

    if platform.system().lower() != "windows":
        raise RuntimeError("Greenshot hotkeys can only be automated on Windows.")
    return _parse_hotkey_combo(combo)


def _send_hotkey_sequence(sequence: List[int], delay: float) -> None:
    """Send the prepared ``sequence`` after an optional ``delay``."""

    time.sleep(max(0.0, delay))
    user32 = ctypes.windll.user32
    for code in sequence:
        user32.keybd_event(code, 0, 0, 0)
    for code in reversed(sequence):
        user32.keybd_event(code, 0, 2, 0)


def _parse_hotkey_delay(raw: Any) -> float:
    """Convert milliseconds expressed by the client into seconds."""

    if raw in (None, ""):
        return 0.35
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:  # pragma: no cover - validation path
        raise ValueError("Invalid Greenshot hotkey delay.") from exc
    return max(0.0, value) / 1000.0


def _is_local_request() -> bool:
    remote = (request.remote_addr or "").replace("::1", "127.0.0.1")
    return remote in {"127.0.0.1", "localhost"}


def _is_process_running(executable: str) -> bool:
    """Return ``True`` when *executable* is already running (Windows only)."""

    name = Path(executable).name
    if not name or platform.system().lower() != "windows":
        return False
    try:
        args = ["tasklist", "/FI", f"IMAGENAME eq {name}"]
        kwargs: dict[str, Any] = {"capture_output": True, "text": True, "check": False, "timeout": 5}
        if hasattr(subprocess, "CREATE_NO_WINDOW"):
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
        result = subprocess.run(args, **kwargs)
    except Exception:
        return False
    output = (result.stdout or "") + (result.stderr or "")
    return name.lower() in output.lower()


def _parse_greenshot_enabled(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    raise ValueError("Greenshot enabled must be a boolean.")


def _parse_office_preview_quality(value: Any) -> str:
    if value is None:
        return "standard"
    normalized = str(value).strip().lower()
    if normalized in {"fast", "standard"}:
        return normalized
    raise ValueError("Office preview quality must be 'standard' or 'fast'.")


def _data_dir_path() -> Path:
    data_dir = current_app.config.get("DATA_DIR") or current_app.instance_path
    return Path(data_dir)


def _load_greenshot_enabled_preference(executable: str) -> bool:
    saved = get_preference(_data_dir_path(), current_app.config, "greenshot_enabled")
    if saved is None:
        # Backward-compat fallback: preserve existing configured users.
        return bool((executable or "").strip())
    try:
        return _parse_greenshot_enabled(saved)
    except ValueError:
        return bool((executable or "").strip())


@api_bp.route("/settings/greenshot", methods=["POST"])
def api_set_greenshot_settings() -> Response:
    """Persist Greenshot integration settings used by server-side guards."""

    if not _is_local_request():
        return jsonify({"error": "This action is only available locally.", "code": "forbidden"}), 403
    data = _json_body()
    if isinstance(data, Response):
        return data
    try:
        enabled = _parse_greenshot_enabled(data.get("enabled"))
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    set_preference(_data_dir_path(), current_app.config, "greenshot_enabled", "1" if enabled else "0")
    return jsonify({"ok": True, "enabled": enabled})


@api_bp.route("/settings/office_preview_quality", methods=["POST"])
def api_set_office_preview_quality() -> Response:
    """Persist Office preview quality profile used by conversion routes."""

    if not _is_local_request():
        return jsonify({"error": "This action is only available locally.", "code": "forbidden"}), 403
    data = _json_body()
    if isinstance(data, Response):
        return data
    try:
        quality = _parse_office_preview_quality(data.get("quality"))
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    set_preference(_data_dir_path(), current_app.config, "office_preview_quality", quality)
    return jsonify({"ok": True, "quality": quality})


@api_bp.route("/screenshot", methods=["POST"])
def api_screenshot() -> Response:
    """Store an uploaded screenshot blob inside the current folder."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    file = request.files.get("image")
    path = request.form.get("path", ".")
    if not file:
        return jsonify({"error": "No image received", "code": "invalid"}), 400
    requested_name = request.form.get("name")
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    if requested_name:
        base_name = safe_secure_filename(requested_name)
    else:
        base_name = f"screenshot_{timestamp}.png"
    if not base_name.lower().endswith(".png"):
        base_name = f"{base_name}.png"
    try:
        destination = resolve_within_root(root, Path(path) / base_name)
    except Exception as exc:
        return _fs_error_response(exc)
    destination.parent.mkdir(parents=True, exist_ok=True)
    file.save(destination)
    return jsonify({"saved": str(destination.relative_to(root))})


@api_bp.route("/greenshot", methods=["POST"])
def api_greenshot() -> Response:
    """Launch the Greenshot executable using user-provided settings."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    executable_raw = data.get("executable")
    if not _load_greenshot_enabled_preference(str(executable_raw or "")):
        return jsonify({"error": "Greenshot integration is disabled in Settings.", "code": "disabled"}), 403
    if not executable_raw:
        return jsonify({"error": "Configure the Greenshot executable path first.", "code": "invalid"}), 400
    executable = str(executable_raw)
    arguments_raw = data.get("arguments") or ""
    destination_raw = data.get("destination")
    file_raw = data.get("file")
    hotkey = (data.get("hotkey") or "").strip()
    try:
        delay_seconds = _parse_hotkey_delay(data.get("delay"))
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    hotkey_sequence: List[int] | None = None
    if hotkey:
        try:
            hotkey_sequence = _resolve_hotkey_sequence(hotkey)
        except RuntimeError as exc:
            return jsonify({"error": str(exc), "code": "unsupported"}), 400
        except ValueError as exc:
            return jsonify({"error": str(exc), "code": "invalid"}), 400
    target_folder = None
    file_path = None
    uses_file_placeholder = False
    if destination_raw not in (None, ""):
        try:
            target_folder = resolve_within_root(root, destination_raw)
        except Exception as exc:
            return _fs_error_response(exc)
    if file_raw not in (None, ""):
        try:
            file_path = resolve_within_root(root, file_raw)
        except Exception as exc:
            return _fs_error_response(exc)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    placeholder_map = {"timestamp": timestamp}
    if target_folder is not None:
        placeholder_map["output"] = str(target_folder)
    if file_path is not None:
        placeholder_map["file"] = str(file_path)
        if isinstance(arguments_raw, str) and "{file" in arguments_raw:
            uses_file_placeholder = True
    try:
        rendered_args = arguments_raw.format(**placeholder_map)
    except Exception:
        return jsonify({"error": "Invalid Greenshot arguments template.", "code": "invalid"}), 400
    command = [executable]
    if rendered_args:
        command.extend(shlex.split(rendered_args))
    if file_path is not None and not uses_file_placeholder:
        command.append(str(file_path))
    working_directory = None
    try:
        exe_path = Path(executable).expanduser()
        if exe_path.exists():
            working_directory = exe_path.parent
    except Exception:
        working_directory = None
    already_running = _is_process_running(executable)
    launched = False
    should_launch = not already_running or file_path is not None
    if should_launch:
        try:
            popen_kwargs: dict[str, Any] = {}
            if working_directory and working_directory.is_dir():
                popen_kwargs["cwd"] = str(working_directory)
            subprocess.Popen(command, **popen_kwargs)
            launched = True
        except FileNotFoundError:
            return jsonify({"error": "Greenshot executable was not found.", "code": "not-found"}), 400
        except Exception as exc:  # pragma: no cover - defensive logging
            return jsonify({"error": f"Failed to launch Greenshot: {exc}", "code": "error"}), 400
    hotkey_sent = False
    if hotkey_sequence:
        try:
            _send_hotkey_sequence(hotkey_sequence, delay_seconds)
            hotkey_sent = True
        except Exception as exc:  # pragma: no cover - defensive logging
            return jsonify({"error": f"Failed to send Greenshot hotkey: {exc}", "code": "hotkey"}), 400
    status = "hotkey" if hotkey_sent else ("launched" if launched else "running")
    return jsonify({
        "status": status,
        "command": command,
        "hotkey_sent": hotkey_sent,
        "launched": launched,
        "already_running": already_running,
    })


def _order_items(items: List[str], preferred_order: List[str] | None) -> List[str]:
    """Apply the drag/drop order selected in the client UI."""

    unique: List[str] = []
    seen = set()
    for item in items:
        if item not in seen:
            seen.add(item)
            unique.append(item)
    if not preferred_order:
        return unique
    ordered: List[str] = []
    for entry in preferred_order:
        if entry in seen and entry not in ordered:
            ordered.append(entry)
    for entry in unique:
        if entry not in ordered:
            ordered.append(entry)
    return ordered


def _parse_phrase_font_size_pt(value: Any) -> float:
    """Parse and clamp image caption size in points."""

    if value is None:
        return 14.0
    if isinstance(value, str) and not value.strip():
        return 14.0
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise MergeError("Caption size must be a number between 6 and 48 points.") from exc
    if not math.isfinite(parsed):
        raise MergeError("Caption size must be a number between 6 and 48 points.")
    if parsed < 6.0:
        return 6.0
    if parsed > 48.0:
        return 48.0
    return parsed


@api_bp.route("/merge", methods=["POST"])
def api_merge() -> Response:
    """Merge PDFs or convert images into a single PDF document."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    items_input = data.get("items", [])
    if not items_input:
        return jsonify({"error": "Select at least two files to merge.", "code": "invalid"}), 400
    try:
        ordered_items = _order_items(items_input, data.get("order"))
        items = [resolve_within_root(root, item) for item in ordered_items]
    except Exception as exc:
        return _fs_error_response(exc)
    mode = data.get("mode", "pdf")
    output_name = data.get("output_name") or ("Merged.pdf" if mode == "pdf" else "Images.pdf")
    try:
        output = resolve_within_root(root, Path(data.get("path", ".")) / output_name)
    except Exception as exc:
        return _fs_error_response(exc)
    if output.exists():
        output = _auto_rename(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    page_numbers = bool(data.get("page_numbers"))
    try:
        if mode == "pdf":
            if any(item.suffix.lower() != ".pdf" for item in items):
                raise MergeError("All selected files must be PDFs for PDF merge.")
            merge_pdfs(items, output, page_numbers=page_numbers)
        else:
            allowed = {".png", ".jpg", ".jpeg"}
            if any(item.suffix.lower() not in allowed for item in items):
                raise MergeError("Only PNG and JPG images can be merged into a PDF.")
            paper_size = data.get("paper_size", "A4")
            orientation = data.get("orientation", "portrait")
            margin = int(data.get("margin", 10))
            fit = data.get("fit", "contain")
            phrases = data.get("phrases") or {}
            phrase_alignment = data.get("phrase_alignment", "left")
            phrase_font_size_pt = _parse_phrase_font_size_pt(data.get("phrase_font_size_pt"))
            if isinstance(phrases, list):
                phrases = {int(idx): value for idx, value in enumerate(phrases)}
            try:
                phrase_map = {int(key): str(value) for key, value in phrases.items()}
            except Exception:
                return jsonify({"error": "Invalid phrase map.", "code": "invalid"}), 400
            images_to_pdf(
                items,
                output,
                paper_size=paper_size,
                orientation=orientation,
                fit=fit,
                margin_mm=margin,
                phrases=phrase_map,
                phrase_alignment=phrase_alignment,
                phrase_font_size_pt=phrase_font_size_pt,
                page_numbers=page_numbers,
            )
    except MergeError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    except (FileNotFoundError, PermissionError) as exc:
        return _fs_error_response(exc)
    return jsonify({"output": str(output.relative_to(root))})


@api_bp.route("/pdf/extract", methods=["POST"])
def api_extract_pdf_pages() -> Response:
    """Extract selected pages from a PDF into a new document."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    rel = (data.get("path") or "").strip()
    if not rel:
        return jsonify({"error": "Select a PDF file first.", "code": "invalid"}), 400
    pages_expr = (data.get("pages") or "").strip()
    if not pages_expr:
        return jsonify({"error": "Enter one or more page numbers.", "code": "invalid"}), 400
    try:
        source = resolve_within_root(root, rel)
    except Exception as exc:
        return _fs_error_response(exc)
    if source.suffix.lower() != ".pdf":
        return jsonify({"error": "Only PDF files can be processed.", "code": "invalid"}), 400
    try:
        with source.open("rb") as handle:
            reader = PdfReader(handle)
            total_pages = len(reader.pages)
    except Exception as exc:
        current_app.logger.warning("Unable to read PDF %s: %s", source, exc)
        return jsonify({"error": "Unable to read the selected PDF.", "code": "invalid"}), 400
    try:
        pages = _parse_page_ranges(pages_expr, total_pages)
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    destination_rel = (data.get("destination") or Path(rel).parent.as_posix() or ".").strip()
    destination_rel = destination_rel or "."
    try:
        destination = resolve_within_root(root, destination_rel)
    except Exception as exc:
        return _fs_error_response(exc)
    output_name = (data.get("output_name") or f"{source.stem}-extracted.pdf").strip() or "extracted.pdf"
    if not output_name.lower().endswith(".pdf"):
        output_name = f"{output_name}.pdf"
    output_name = safe_secure_filename(output_name)
    output = destination / output_name
    if output.exists():
        output = _auto_rename(output)
    try:
        extract_pdf_pages(source, output, pages)
    except MergeError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    except Exception as exc:
        current_app.logger.warning("PDF extraction failed for %s: %s", source, exc)
        return jsonify({"error": "Unable to extract the requested pages.", "code": "error"}), 400
    return jsonify({"output": str(output.relative_to(root)), "pages": pages})


@api_bp.route("/status")
def api_status() -> Response:
    """Simple health endpoint used by smoke tests."""

    return jsonify({"status": "ok"})


@api_bp.route("/shutdown", methods=["POST"])
def api_shutdown() -> Response:
    """Gracefully stop the server when portable shutdown is enabled."""

    if not current_app.config.get("ALLOW_SHUTDOWN"):
        return jsonify({"error": "Shutdown is disabled.", "code": "unsupported"}), 404
    if not _is_local_request():
        return jsonify({"error": "Shutdown is only available locally.", "code": "forbidden"}), 403
    shutdown_handler = current_app.config.get("SHUTDOWN_HANDLER")
    if callable(shutdown_handler):
        def _stop_server() -> None:
            try:
                shutdown_handler()
            except Exception as exc:  # pragma: no cover - defensive logging
                current_app.logger.warning("Shutdown handler failed: %s", exc)

        threading.Thread(target=_stop_server, daemon=True).start()
        return jsonify({"status": "shutting-down"})

    shutdown_func = request.environ.get("werkzeug.server.shutdown")
    if shutdown_func is None:
        return jsonify({"error": "Shutdown is not available in this server context.", "code": "unsupported"}), 500

    def _stop_server() -> None:
        shutdown_func()

    threading.Thread(target=_stop_server, daemon=True).start()
    return jsonify({"status": "shutting-down"})


@api_bp.route("/portable/data_dir")
def api_portable_data_dir() -> Response:
    """Return the active data directory for portable builds."""

    if not current_app.config.get("PORTABLE_MODE"):
        return jsonify({"error": "Portable mode is disabled.", "code": "unsupported"}), 404
    data_dir = Path(current_app.config.get("DATA_DIR") or current_app.instance_path)
    portable_root = current_app.config.get("PORTABLE_ROOT")
    return jsonify({
        "data_dir": str(data_dir),
        "portable_root": str(portable_root) if portable_root else None,
    })


@api_bp.route("/portable/open_data_dir", methods=["POST"])
def api_open_data_dir() -> Response:
    """Open the active data directory in the system file explorer (portable only)."""

    if not current_app.config.get("PORTABLE_MODE"):
        return jsonify({"error": "Portable mode is disabled.", "code": "unsupported"}), 404
    if not _is_local_request():
        return jsonify({"error": "This action is only available locally.", "code": "forbidden"}), 403
    data_dir = Path(current_app.config.get("DATA_DIR") or current_app.instance_path)
    try:
        _reveal_in_explorer(data_dir, select=False)
    except Exception as exc:
        return jsonify({"error": str(exc), "code": "error"}), 500
    return jsonify({"status": "ok"})


@api_bp.route("/logs")
def api_logs() -> Response:
    """Return accumulated activity log entries."""

    logs_path = _log_file_path()
    tail_param = request.args.get("tail")
    try:
        tail_lines = int(tail_param) if tail_param is not None else 500
        if tail_lines < 0:
            tail_lines = 0
    except Exception:
        tail_lines = 500
    content = _tail_file(logs_path, max_lines=tail_lines)
    return Response(content, mimetype="text/plain")


@api_bp.route("/log", methods=["POST"])
def api_log() -> Response:
    """Append an entry to the activity log file."""

    logs_path = _log_file_path()
    logs_path.parent.mkdir(parents=True, exist_ok=True)
    entry = _json_body()
    if isinstance(entry, Response):
        return entry
    entry["timestamp"] = datetime.utcnow().isoformat()
    with logs_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")
    # Trim file to last ~256KB to avoid unbounded growth
    max_bytes = 262144
    try:
        if logs_path.stat().st_size > max_bytes:
            trimmed = _tail_file(logs_path, max_lines=0, max_bytes=max_bytes)
            logs_path.write_text(trimmed, encoding="utf-8")
    except Exception:
        pass
    return jsonify({"status": "logged"})


@api_bp.route("/cache/clear", methods=["POST"])
def api_clear_cache() -> Response:
    """Clear preview caches (office + general) without touching other data."""

    base = Path(current_app.config.get("DATA_DIR") or current_app.instance_path)
    preview_dir = Path(current_app.config.get("PREVIEW_CACHE_DIR") or base / "preview_cache")
    office_dir = Path(current_app.config.get("OFFICE_CACHE_DIR") or base / "office_cache")
    if not preview_dir.exists() and not office_dir.exists():
        return jsonify({"ok": True, "deleted_files": 0, "deleted_dirs": 0})
    deleted_files = 0
    deleted_dirs = 0
    for target in {preview_dir, office_dir}:
        files, dirs = _clear_cache_dir(target)
        deleted_files += files
        deleted_dirs += dirs
    return jsonify({"ok": True, "deleted_files": deleted_files, "deleted_dirs": deleted_dirs})
