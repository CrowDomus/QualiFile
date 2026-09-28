from __future__ import annotations

import ctypes
import io
import json
import math
from functools import wraps
import os
import platform
import stat
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, List

from flask import Response, current_app, jsonify, request
from pypdf import PdfReader
from pypdf.errors import PdfReadError
from PIL import Image, UnidentifiedImageError

from ...features.filesystem.service import resolve_within_root, safe_secure_filename
from ...features.preview.merge import MergeError, extract_pdf_pages, images_to_pdf, merge_pdfs, staged_output
from ...shared.preferences import get_preference, set_preference
from ...shared.capability_security import (
    cache_root_identity,
    capability_guard,
    reject_unknown_fields,
)
from ...shared.redaction import redact_text
from . import api_bp
from .helpers import (
    _auto_rename,
    _fs_error_response,
    _json_body,
    _reveal_in_explorer,
    _root_or_response,
)

_MERGE_LOCK = threading.Lock()


def _serialized_merge(function):
    @wraps(function)
    def guarded(*args, **kwargs):
        if not _MERGE_LOCK.acquire(blocking=False):
            return jsonify({"error": "Another merge is running. Try again when it finishes.", "code": "busy"}), 409
        try:
            return function(*args, **kwargs)
        finally:
            _MERGE_LOCK.release()
    return guarded



def _log_file_path() -> Path:
    """Return the path used to persist activity logs."""

    configured = current_app.config.get("LOG_FILE")
    if configured:
        return Path(configured)
    return Path(current_app.instance_path) / "activity.log"


_WINDOWS_REPARSE_ATTRIBUTE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
_CACHE_CLEAR_LOCK = threading.Lock()


class _UnsafeCacheTreeError(RuntimeError):
    """Raised before cache removal when a filesystem boundary is unsafe."""


def _path_is_reparse_point(path: Path) -> bool:
    """Detect links, junctions, and other Windows reparse-point nodes."""

    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise _UnsafeCacheTreeError("Unable to inspect cache tree.") from exc
    is_junction = getattr(path, "is_junction", None)
    try:
        junction = bool(is_junction()) if callable(is_junction) else False
    except OSError as exc:
        raise _UnsafeCacheTreeError("Unable to inspect cache tree.") from exc
    attributes = int(getattr(info, "st_file_attributes", 0))
    return (
        stat.S_ISLNK(info.st_mode)
        or junction
        or bool(attributes & _WINDOWS_REPARSE_ATTRIBUTE)
    )


def _preflight_cache_tree(path: Path) -> None:
    """Reject special nodes before any cache entry is removed."""

    if not os.path.lexists(path):
        return
    pending = [path]
    while pending:
        current = pending.pop()
        if _path_is_reparse_point(current):
            raise _UnsafeCacheTreeError("Cache tree contains a reparse point.")
        try:
            info = current.lstat()
        except OSError as exc:
            raise _UnsafeCacheTreeError("Unable to inspect cache tree.") from exc
        if not stat.S_ISDIR(info.st_mode):
            raise _UnsafeCacheTreeError("Cache root is not a directory.")
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    child = Path(entry.path)
                    if _path_is_reparse_point(child):
                        raise _UnsafeCacheTreeError("Cache tree contains a reparse point.")
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            pending.append(child)
                        elif not entry.is_file(follow_symlinks=False):
                            raise _UnsafeCacheTreeError(
                                "Cache tree contains an unsupported filesystem node."
                            )
                    except OSError as exc:
                        raise _UnsafeCacheTreeError(
                            "Unable to inspect cache tree."
                        ) from exc
        except _UnsafeCacheTreeError:
            raise
        except OSError as exc:
            raise _UnsafeCacheTreeError("Unable to inspect cache tree.") from exc


def _clear_cache_dir(path: Path) -> tuple[int, int]:
    """Delete a preflighted cache tree without following special nodes."""

    if not os.path.lexists(path):
        return (0, 0)
    deleted_files = 0
    deleted_dirs = 0

    def clear_directory(directory: Path) -> None:
        nonlocal deleted_files, deleted_dirs
        if _path_is_reparse_point(directory):
            raise _UnsafeCacheTreeError("Cache directory changed during removal.")
        try:
            with os.scandir(directory) as scan:
                entries = list(scan)
        except OSError as exc:
            raise _UnsafeCacheTreeError("Unable to inspect cache tree.") from exc
        for entry in entries:
            target = Path(entry.path)
            if _path_is_reparse_point(target):
                raise _UnsafeCacheTreeError("Cache entry changed during removal.")
            try:
                if entry.is_dir(follow_symlinks=False):
                    clear_directory(target)
                    if _path_is_reparse_point(target):
                        raise _UnsafeCacheTreeError("Cache directory changed during removal.")
                    target.rmdir()
                    deleted_dirs += 1
                elif entry.is_file(follow_symlinks=False):
                    target.unlink()
                    deleted_files += 1
                else:
                    raise _UnsafeCacheTreeError(
                        "Cache tree contains an unsupported filesystem node."
                    )
            except _UnsafeCacheTreeError:
                raise
            except OSError as exc:
                raise _UnsafeCacheTreeError("Unable to clear cache safely.") from exc

    clear_directory(path)
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


def _load_greenshot_enabled_preference() -> bool:
    saved = get_preference(_data_dir_path(), current_app.config, "greenshot_enabled")
    if saved is None:
        return False
    try:
        return _parse_greenshot_enabled(saved)
    except ValueError:
        return False


def _trusted_greenshot_executable() -> Path | None:
    """Resolve and revalidate the startup-owned Greenshot executable."""

    raw = current_app.config.get("GREENSHOT_EXECUTABLE")
    if not isinstance(raw, str) or not raw.strip():
        return None
    candidate = Path(raw.strip()).expanduser()
    if not candidate.is_absolute() or candidate.is_symlink():
        return None
    try:
        resolved = candidate.resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    if (
        resolved.name.casefold() != "greenshot.exe"
        or not resolved.is_file()
        or resolved.is_symlink()
    ):
        return None
    return resolved


def _server_greenshot_delay() -> float:
    raw = current_app.config.get("GREENSHOT_DELAY_MS", 350)
    if isinstance(raw, bool):
        raise ValueError("Invalid server Greenshot delay.")
    try:
        milliseconds = float(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid server Greenshot delay.") from exc
    if not math.isfinite(milliseconds) or not 0 <= milliseconds <= 2000:
        raise ValueError("Invalid server Greenshot delay.")
    return milliseconds / 1000.0


@api_bp.route("/settings/greenshot", methods=["POST"])
@capability_guard("settings", max_body_bytes=4096)
def api_set_greenshot_settings() -> Response:
    """Persist Greenshot integration settings used by server-side guards."""

    if not _is_local_request():
        return jsonify({"error": "This action is only available locally.", "code": "forbidden"}), 403
    data = _json_body()
    if isinstance(data, Response):
        return data
    schema_error = reject_unknown_fields(data, {"enabled"})
    if schema_error is not None:
        return schema_error
    try:
        enabled = _parse_greenshot_enabled(data.get("enabled"))
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    set_preference(_data_dir_path(), current_app.config, "greenshot_enabled", "1" if enabled else "0")
    return jsonify({"ok": True, "enabled": enabled})


@api_bp.route("/settings/office_preview_quality", methods=["POST"])
@capability_guard("settings", max_body_bytes=4096)
def api_set_office_preview_quality() -> Response:
    """Persist Office preview quality profile used by conversion routes."""

    if not _is_local_request():
        return jsonify({"error": "This action is only available locally.", "code": "forbidden"}), 403
    data = _json_body()
    if isinstance(data, Response):
        return data
    schema_error = reject_unknown_fields(data, {"quality"})
    if schema_error is not None:
        return schema_error
    try:
        quality = _parse_office_preview_quality(data.get("quality"))
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    set_preference(_data_dir_path(), current_app.config, "office_preview_quality", quality)
    return jsonify({"ok": True, "quality": quality})


@api_bp.route("/settings/office_preview_acceleration", methods=["GET", "POST"])
@capability_guard("settings", max_body_bytes=4096)
def api_office_preview_acceleration() -> Response:
    """Store acceleration independently of PDF quality in profile preferences."""
    if not _is_local_request():
        return jsonify({"error": "This action is only available locally.", "code": "forbidden"}), 403
    if request.method == "GET":
        enabled = get_preference(_data_dir_path(), current_app.config, "office_preview_accelerated") != "0"
        response = jsonify({"enabled": enabled})
        response.headers["Cache-Control"] = "no-store"
        return response
    data = _json_body()
    if isinstance(data, Response):
        return data
    schema_error = reject_unknown_fields(data, {"enabled"})
    if schema_error is not None:
        return schema_error
    enabled = data.get("enabled")
    if not isinstance(enabled, bool):
        return jsonify({"error": "Enabled must be a boolean.", "code": "invalid"}), 400
    set_preference(_data_dir_path(), current_app.config, "office_preview_accelerated", "1" if enabled else "0")
    if not enabled:
        from ...features.preview.office_session import close_office_session

        close_office_session()
    return jsonify({"ok": True, "enabled": enabled})


@api_bp.route("/settings/capture_merge_overwrite", methods=["GET", "POST"])
@capability_guard("settings", max_body_bytes=4096)
def api_capture_merge_overwrite():
    """Keep automatic replacement an explicit, disabled-by-default preference."""
    if not _is_local_request():
        return jsonify({"error": "This action is only available locally.", "code": "forbidden"}), 403
    if request.method == "POST":
        data = _json_body()
        if isinstance(data, Response):
            return data
        if set(data) != {"enabled"} or not isinstance(data["enabled"], bool):
            return jsonify({"error": "Enabled must be a boolean.", "code": "invalid"}), 400
        set_preference(_data_dir_path(), current_app.config, "capture_merge_overwrite", "1" if data["enabled"] else "0")
    response = jsonify({"enabled": get_preference(_data_dir_path(), current_app.config, "capture_merge_overwrite") == "1"})
    response.headers["Cache-Control"] = "no-store"
    return response


@api_bp.route("/screenshot", methods=["POST"])
@capability_guard("screenshot", max_body_bytes=10 * 1024 * 1024)
def api_screenshot() -> Response:
    """Store an uploaded screenshot blob inside the current folder."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    file = request.files.get("image")
    if set(request.files) != {"image"} or set(request.form) - {"path", "name"}:
        return jsonify({"error": "Unsupported screenshot fields.", "code": "invalid"}), 400
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
    payload = file.stream.read((10 * 1024 * 1024) + 1)
    if len(payload) > 10 * 1024 * 1024 or not payload.startswith(b"\x89PNG\r\n\x1a\n"):
        return jsonify({"error": "Screenshot must be a valid PNG image.", "code": "invalid"}), 400
    try:
        with Image.open(io.BytesIO(payload)) as image:
            width, height = image.size
            if image.format != "PNG" or width > 8192 or height > 8192 or width * height > 40_000_000:
                raise ValueError
            image.verify()
    except (UnidentifiedImageError, OSError, ValueError):
        return jsonify({"error": "Screenshot must be a valid PNG image.", "code": "invalid"}), 400
    try:
        destination = resolve_within_root(root, Path(path) / base_name)
    except Exception as exc:
        return _fs_error_response(exc)
    overwrite = get_preference(_data_dir_path(), current_app.config, "capture_merge_overwrite") == "1"
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            if not overwrite:
                return jsonify({"error": "A file with this name already exists.", "code": "conflict"}), 409
            from .image_history_routes import image_history
            from ...features.preview.image_history import IMAGE_LOCK
            with IMAGE_LOCK:
                image_history(root).replace_capture(destination.relative_to(root).as_posix(), payload)
        else:
            with staged_output(destination, overwrite=False) as stage:
                stage.write_bytes(payload)
    except Exception as exc:
        return _fs_error_response(exc)
    return jsonify({"saved": str(destination.relative_to(root))})


@api_bp.route("/greenshot", methods=["POST"])
@capability_guard("greenshot", max_body_bytes=4096)
def api_greenshot() -> Response:
    """Use one server-owned Greenshot executable with a fixed request schema."""

    if not _is_local_request():
        return jsonify({"error": "This action is only available locally.", "code": "forbidden"}), 403
    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    if set(data) - {"mode", "path"}:
        return jsonify({"error": "Unsupported Greenshot request fields.", "code": "invalid"}), 400
    mode = data.get("mode", "launch")
    if mode not in {"launch", "capture", "open"}:
        return jsonify({"error": "Invalid Greenshot mode.", "code": "invalid"}), 400
    path_raw = data.get("path")
    if mode == "open":
        if not isinstance(path_raw, str) or not path_raw:
            return jsonify({"error": "A file path is required.", "code": "invalid"}), 400
    elif path_raw is not None:
        return jsonify({"error": "Path is only valid in open mode.", "code": "invalid"}), 400
    if not _load_greenshot_enabled_preference():
        return jsonify({"error": "Greenshot integration is disabled in Settings.", "code": "disabled"}), 403
    executable = _trusted_greenshot_executable()
    if executable is None:
        return jsonify({"error": "Greenshot is not available on this server.", "code": "unavailable"}), 503
    file_path = None
    if mode == "open":
        try:
            file_path = resolve_within_root(root, path_raw)
            if not file_path.is_file():
                raise FileNotFoundError("Greenshot target is unavailable.")
        except Exception as exc:
            return _fs_error_response(exc)
    hotkey = str(current_app.config.get("GREENSHOT_HOTKEY") or "").strip()
    try:
        delay_seconds = _server_greenshot_delay()
    except ValueError:
        return jsonify({"error": "Greenshot server configuration is invalid.", "code": "unavailable"}), 503
    hotkey_sequence: List[int] | None = None
    if mode == "capture" and hotkey:
        try:
            hotkey_sequence = _resolve_hotkey_sequence(hotkey)
        except (RuntimeError, ValueError):
            return jsonify({"error": "Greenshot server hotkey is invalid.", "code": "unavailable"}), 503
    command = [str(executable)]
    if file_path is not None:
        command.append(str(file_path.resolve()))
    already_running = _is_process_running(str(executable))
    launched = False
    should_launch = not already_running or file_path is not None
    if should_launch:
        try:
            subprocess.Popen(command, cwd=str(executable.parent))
            launched = True
        except FileNotFoundError:
            return jsonify({"error": "Greenshot is unavailable.", "code": "unavailable"}), 503
        except Exception:  # pragma: no cover - defensive logging
            current_app.logger.exception("Greenshot launch failed.")
            return jsonify({"error": "Greenshot could not be started.", "code": "error"}), 500
    hotkey_sent = False
    if hotkey_sequence:
        try:
            _send_hotkey_sequence(hotkey_sequence, delay_seconds)
            hotkey_sent = True
        except Exception:  # pragma: no cover - defensive logging
            current_app.logger.exception("Greenshot hotkey failed.")
            return jsonify({"error": "Greenshot capture could not be triggered.", "code": "hotkey"}), 500
    status = "hotkey" if hotkey_sent else ("launched" if launched else "running")
    return jsonify({
        "status": status,
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


def _preflight_merge_inputs(items: list[Path], mode: str) -> None:
    """Validate inputs one at a time without imposing aggregate file limits."""
    for item in items:
        if not item.is_file():
            raise MergeError("Every merge input must be an existing file.")
        if mode == "pdf":
            with item.open("rb") as handle:
                if not PdfReader(handle).pages:
                    raise MergeError("A selected PDF has no pages.")
        else:
            try:
                with Image.open(item) as image:
                    image.verify()
            except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
                raise MergeError("A selected image cannot be decoded safely.") from exc


@api_bp.route("/merge", methods=["POST"])
@capability_guard("merge", max_body_bytes=100 * 1024 * 1024)
@_serialized_merge
def api_merge() -> Response:
    """Merge PDFs or convert images into a single PDF document."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    schema_error = reject_unknown_fields(
        data,
        {
            "items", "order", "mode", "output_name", "path", "page_numbers",
            "paper_size", "orientation", "margin", "fit", "phrases",
            "phrase_alignment", "phrase_font_size_pt",
        },
    )
    if schema_error is not None:
        return schema_error
    items_input = data.get("items", [])
    if (
        not isinstance(items_input, list)
        or len(items_input) < 2
        or any(not isinstance(item, str) or not item or len(item) > 4096 for item in items_input)
    ):
        return jsonify({"error": "Select at least two files to merge.", "code": "invalid"}), 400
    try:
        ordered_items = _order_items(items_input, data.get("order"))
        items = [resolve_within_root(root, item) for item in ordered_items]
    except Exception as exc:
        return _fs_error_response(exc)
    mode = data.get("mode", "pdf")
    if not isinstance(mode, str) or mode not in {"pdf", "images"}:
        return jsonify({"error": "Merge mode must be 'pdf' or 'images'.", "code": "invalid"}), 400
    output_name = data.get("output_name") or ("Merged.pdf" if mode == "pdf" else "Images.pdf")
    output_path = data.get("path", ".")
    if (
        not isinstance(output_name, str)
        or not output_name
        or len(output_name) > 255
        or not isinstance(output_path, str)
        or len(output_path) > 4096
    ):
        return jsonify({"error": "Merge destination is invalid.", "code": "invalid"}), 400
    try:
        output = resolve_within_root(root, Path(output_path) / output_name)
    except Exception as exc:
        return _fs_error_response(exc)
    overwrite = get_preference(_data_dir_path(), current_app.config, "capture_merge_overwrite") == "1"
    if output.exists() and not overwrite:
        output = _auto_rename(output)
    page_numbers_raw = data.get("page_numbers", False)
    if not isinstance(page_numbers_raw, bool):
        return jsonify({"error": "Page numbers must be a boolean.", "code": "invalid"}), 400
    page_numbers = page_numbers_raw
    try:
        if mode == "pdf":
            if any(item.suffix.lower() != ".pdf" for item in items):
                raise MergeError("All selected files must be PDFs for PDF merge.")
            _preflight_merge_inputs(items, mode)
            output.parent.mkdir(parents=True, exist_ok=True)
            merge_pdfs(items, output, page_numbers=page_numbers, overwrite=overwrite)
        else:
            allowed = {".png", ".jpg", ".jpeg"}
            if any(item.suffix.lower() not in allowed for item in items):
                raise MergeError("Only PNG and JPG images can be merged into a PDF.")
            _preflight_merge_inputs(items, mode)
            paper_size = data.get("paper_size", "A4")
            orientation = data.get("orientation", "portrait")
            margin_raw = data.get("margin", 10)
            if isinstance(margin_raw, bool) or not isinstance(margin_raw, int) or not 0 <= margin_raw <= 100:
                raise MergeError("Margin must be an integer between 0 and 100.")
            margin = margin_raw
            fit = data.get("fit", "contain")
            phrases = data.get("phrases") or {}
            phrase_alignment = data.get("phrase_alignment", "left")
            phrase_font_size_pt = _parse_phrase_font_size_pt(data.get("phrase_font_size_pt"))
            if paper_size not in {"A4", "Letter"}:
                raise MergeError("Paper size must be A4 or Letter.")
            if orientation not in {"portrait", "landscape"}:
                raise MergeError("Orientation must be portrait or landscape.")
            if fit not in {"contain", "cover"}:
                raise MergeError("Image fit must be contain or cover.")
            if phrase_alignment not in {"left", "center", "right"}:
                raise MergeError("Phrase alignment must be left, center, or right.")
            if isinstance(phrases, list):
                phrases = {int(idx): value for idx, value in enumerate(phrases)}
            try:
                if not isinstance(phrases, dict) or len(phrases) > len(items):
                    raise ValueError
                phrase_map = {
                    int(key): value
                    for key, value in phrases.items()
                    if isinstance(value, str) and len(value) <= 2048
                }
                if len(phrase_map) != len(phrases):
                    raise ValueError
            except Exception:
                return jsonify({"error": "Invalid phrase map.", "code": "invalid"}), 400
            output.parent.mkdir(parents=True, exist_ok=True)
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
                overwrite=overwrite,
            )
    except (MergeError, PdfReadError) as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    except (FileNotFoundError, PermissionError) as exc:
        return _fs_error_response(exc)
    except (MemoryError, OSError):
        return jsonify({"error": "The merge could not finish with the available memory or disk space. Existing files were not replaced.", "code": "resources"}), 503
    return jsonify({"output": str(output.relative_to(root))})


@api_bp.route("/pdf/extract", methods=["POST"])
@capability_guard("pdf_extract", max_body_bytes=256 * 1024)
def api_extract_pdf_pages() -> Response:
    """Extract selected pages from a PDF into a new document."""

    root, response = _root_or_response()
    if response:
        return response
    assert root is not None
    data = _json_body()
    if isinstance(data, Response):
        return data
    schema_error = reject_unknown_fields(data, {"path", "pages", "destination", "output_name"})
    if schema_error is not None:
        return schema_error
    rel = (data.get("path") or "").strip()
    if not rel:
        return jsonify({"error": "Select a PDF file first.", "code": "invalid"}), 400
    pages_expr = (data.get("pages") or "").strip()
    if not pages_expr or len(pages_expr) > 2048:
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
    if len(pages) > 1000:
        return jsonify({"error": "Select no more than 1000 pages.", "code": "too-many"}), 400
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
    except (MergeError, PdfReadError) as exc:
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
@capability_guard("shutdown", max_body_bytes=4096)
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
                from ...features.preview.office_session import close_office_session

                close_office_session()
                shutdown_handler()
            except Exception as exc:  # pragma: no cover - defensive logging
                current_app.logger.warning("Shutdown handler failed: %s", exc)

        threading.Thread(target=_stop_server, daemon=True).start()
        return jsonify({"status": "shutting-down"})

    shutdown_func = request.environ.get("werkzeug.server.shutdown")
    if shutdown_func is None:
        return jsonify({"error": "Shutdown is not available in this server context.", "code": "unsupported"}), 500

    def _stop_server() -> None:
        from ...features.preview.office_session import close_office_session

        close_office_session()
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
@capability_guard("open_data_dir", max_body_bytes=4096)
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
@capability_guard("log_read", max_body_bytes=None)
def api_logs() -> Response:
    """Return accumulated activity log entries."""

    logs_path = _log_file_path()
    tail_param = request.args.get("tail")
    try:
        tail_lines = int(tail_param) if tail_param is not None else 500
        if not 0 <= tail_lines <= 500:
            raise ValueError
    except Exception:
        return jsonify({"error": "Tail must be between 0 and 500.", "code": "invalid"}), 400
    content = _tail_file(logs_path, max_lines=tail_lines)
    return Response(content, mimetype="text/plain")


@api_bp.route("/log", methods=["POST"])
@capability_guard("log_write", max_body_bytes=8192)
def api_log() -> Response:
    """Append an entry to the activity log file."""

    logs_path = _log_file_path()
    logs_path.parent.mkdir(parents=True, exist_ok=True)
    entry = _json_body()
    if isinstance(entry, Response):
        return entry
    schema_error = reject_unknown_fields(entry, {"message", "source"})
    if schema_error is not None:
        return schema_error
    message = entry.get("message")
    source = entry.get("source")
    if (
        not isinstance(message, str)
        or not 1 <= len(message) <= 2048
        or not isinstance(source, str)
        or not 1 <= len(source) <= 128
    ):
        return jsonify({"error": "Log entry is invalid.", "code": "invalid"}), 400
    entry = {
        "message": redact_text(message),
        "source": redact_text(source, max_chars=128),
        "timestamp": datetime.utcnow().isoformat(),
    }
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
@capability_guard("cache_clear", max_body_bytes=4096)
def api_clear_cache() -> Response:
    """Clear preview caches (office + general) without touching other data."""

    data = _json_body()
    if isinstance(data, Response):
        return data
    schema_error = reject_unknown_fields(data, set())
    if schema_error is not None:
        return schema_error
    try:
        base = Path(
            cache_root_identity(
                current_app.config.get("DATA_DIR") or current_app.instance_path
            )
        )
        pinned = current_app.config.get("CACHE_CLEAR_ROOT_IDENTITIES")
        current = {
            "preview": cache_root_identity(current_app.config["PREVIEW_CACHE_DIR"]),
            "office": cache_root_identity(current_app.config["OFFICE_CACHE_DIR"]),
        }
        if not isinstance(pinned, dict) or pinned != current:
            raise _UnsafeCacheTreeError("Cache root identity changed after startup.")
        if _path_is_reparse_point(base):
            raise _UnsafeCacheTreeError("Data root is a reparse point.")
        durable_roots = tuple(
            base / name
            for name in ("notes", "logs", ".qualifile_internal", "diagnostics")
        )
        cache_dirs = {Path(identity) for identity in current.values()}
        for target in cache_dirs:
            target.relative_to(base)
            if target == base or any(
                target == durable or target.is_relative_to(durable)
                for durable in durable_roots
            ):
                raise _UnsafeCacheTreeError("Cache root overlaps durable data.")
            if os.path.lexists(target):
                resolved = target.resolve(strict=True)
                resolved.relative_to(base.resolve(strict=True))
                if resolved != target:
                    raise _UnsafeCacheTreeError("Cache root crosses a filesystem link.")
        distinct = list(cache_dirs)
        for index, first in enumerate(distinct):
            for second in distinct[index + 1 :]:
                if first.is_relative_to(second) or second.is_relative_to(first):
                    raise _UnsafeCacheTreeError("Configured cache roots overlap.")
        with _CACHE_CLEAR_LOCK:
            # Preflight every root before deleting from any root.
            for target in cache_dirs:
                _preflight_cache_tree(target)
            deleted_files = 0
            deleted_dirs = 0
            for target in cache_dirs:
                files, dirs = _clear_cache_dir(target)
                deleted_files += files
                deleted_dirs += dirs
    except (KeyError, OSError, RuntimeError, TypeError, ValueError, _UnsafeCacheTreeError):
        return jsonify({"error": "Cache configuration is invalid.", "code": "invalid"}), 400
    return jsonify({"ok": True, "deleted_files": deleted_files, "deleted_dirs": deleted_dirs})
