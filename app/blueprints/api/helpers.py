from __future__ import annotations

import ctypes
import json
import logging
import os
import platform
import re
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urlsplit

from flask import Response, current_app, jsonify, request, g

from ...features.filesystem.service import (
    PathOutsideRootError,
    numeric_sort_key,
    resolve_within_root,
)
from ...features.notes.store import NoteStore
from ...features.tags.store import TagStore
from ...features.validation.store import ValidationStore
from ...shared.internal_paths import is_internal_name, is_internal_rel_path


def _fs_error_response(exc: Exception) -> Response:
    """Convert filesystem exceptions into JSON API responses."""

    mapped = _map_known_error(exc)
    if mapped:
        status, code, message, log_level = mapped
        return _error_response(code, message, status, log_level=log_level)
    return _error_response("server-error", "An unexpected error occurred. Please try again.", 500, log_level=logging.ERROR, exc=exc)


def _require_root() -> Path:
    """Return the configured root directory or raise an informative error."""

    root = current_app.config.get("QUALIFILE_ROOT")
    if not root:
        raise RuntimeError("Root folder not configured.")
    root_path = Path(root)
    if not root_path.exists():
        raise FileNotFoundError("Selected root folder is no longer available.")
    return root_path


_NON_JSON_ENDPOINTS = {
    "api.api_screenshot",
    "api.api_import_structure",
    "api.api_import_profile",
    "api.api_upload_profile_avatar",
}
_NON_JSON_PATHS = {
    "/api/import",
    "/api/screenshot",
    "/api/profile/import",
    "/api/profile/avatar",
}


def _is_internal_name(name: str) -> bool:
    """Return True for internal QualiFile artifacts that should stay hidden."""

    return is_internal_name(name)


def _csrf_token() -> str | None:
    return current_app.config.get("CSRF_TOKEN")


def _validate_origin_and_csrf() -> Response | None:
    """Enforce same-origin and CSRF token for mutating API requests."""

    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return None

    # Origin/Host check
    origin = request.headers.get("Origin")
    if origin:
        origin_parts = urlsplit(origin)
        host_parts = urlsplit(request.host_url)
        if (origin_parts.scheme, origin_parts.netloc) != (host_parts.scheme, host_parts.netloc):
            return _error_response("forbidden", "Cross-origin requests are not allowed.", 403, log_level=logging.WARNING)
    else:
        # No Origin: fall back to Host header sanity
        if not request.host:
            return _error_response("forbidden", "Host header missing.", 403, log_level=logging.WARNING)

    token = request.headers.get("X-CSRF-Token")
    if not token or token != _csrf_token():
        return _error_response("csrf-invalid", "Invalid or missing CSRF token.", 403, log_level=logging.WARNING)

    content_len = request.content_length
    mimetype = (request.mimetype or "").lower()
    is_multipart = mimetype.startswith("multipart/") or mimetype == "application/x-www-form-urlencoded"
    if request.endpoint not in _NON_JSON_ENDPOINTS and request.path not in _NON_JSON_PATHS and content_len not in (None, 0) and not request.is_json and not is_multipart:
        return _error_response("invalid-content-type", "Content-Type must be application/json.", 415, log_level=logging.WARNING)

    return None


def _request_id() -> str | None:
    return getattr(g, "request_id", None)


def _error_payload(code: str, message: str) -> dict:
    return {
        "ok": False,
        "error": {
            "code": code,
            "message": message,
            "request_id": _request_id(),
        },
        "error_message": message,
    }


def _error_response(code: str, message: str, status: int, *, log_level: int | None = logging.WARNING, exc: Exception | None = None) -> Response:
    payload = _error_payload(code, message)
    logger = logging.getLogger("qualifile")
    extra = {"status_code": status}
    if exc and log_level == logging.ERROR:
        logger.exception(message, exc_info=exc, extra=extra)
    elif log_level is not None:
        logger.log(log_level, message, extra=extra)
    response = jsonify(payload)
    response.status_code = status
    return response


def _map_known_error(exc: Exception) -> tuple[int, str, str, int | None] | None:
    if isinstance(exc, FileNotFoundError):
        message = "Requested item was not found."
        code = "not-found"
        lower_msg = str(exc).lower()
        if "root folder" in lower_msg or "selected root" in lower_msg:
            code = "root-missing"
            message = "Selected root folder is unavailable."
        return 404, code, message, logging.INFO
    if isinstance(exc, PermissionError):
        return 423, "permission", "Permission denied.", logging.WARNING
    if isinstance(exc, PathOutsideRootError):
        return 400, "outside-root", "Path escapes selected root.", logging.WARNING
    if isinstance(exc, ValueError):
        return 400, "invalid", "Request is invalid.", logging.WARNING
    if isinstance(exc, KeyError):
        return 404, "not-found", "Requested item was not found.", logging.INFO
    return None


def _json_body() -> dict | Response:
    """Return JSON body or an error response."""

    if not request.is_json:
        return _error_response("invalid-content-type", "Content-Type must be application/json.", 415, log_level=logging.WARNING)
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return _error_response("invalid-json", "Request body must be a JSON object.", 400, log_level=logging.WARNING)
    return data


def _root_or_response() -> tuple[Path | None, Response | None]:
    """Return the active root path or a ready-made error response."""

    try:
        return _require_root(), None
    except RuntimeError as exc:
        return None, _error_response("no-root", "Root folder not configured.", 400, log_level=logging.INFO)
    except FileNotFoundError as exc:
        return None, _fs_error_response(exc)


def _relative_to_base(base: Path, target: Path) -> str:
    """Compute a safe relative path from ``base`` to ``target``."""

    base_resolved = base.resolve()
    target_resolved = target.resolve()
    try:
        relative = target_resolved.relative_to(base_resolved)
    except ValueError as exc:
        raise PathOutsideRootError(f"Path '{target_resolved}' escapes base '{base_resolved}'.") from exc
    text = relative.as_posix()
    return text if text else "."


def _browser_children(base: Path, target: Path) -> List[Dict[str, Any]]:
    """Return child folder metadata for the folder picker modal."""

    if is_internal_rel_path(_relative_to_base(base, target)):
        raise FileNotFoundError(f"Path '{target}' does not exist.")
    try:
        entries = sorted(
            (p for p in target.iterdir() if not _is_internal_name(p.name)),
            key=lambda p: numeric_sort_key(p.name),
        )
    except PermissionError as exc:
        raise PermissionError(f"Permission denied accessing '{target}': {exc}") from exc
    children: List[Dict[str, Any]] = []
    for child in entries:
        if not child.is_dir():
            continue
        try:
            rel = _relative_to_base(base, child)
        except PathOutsideRootError:
            continue
        try:
            has_children = any(grand.is_dir() and not _is_internal_name(grand.name) for grand in child.iterdir())
        except PermissionError:
            has_children = False
        children.append({
            "name": child.name,
            "path": rel,
            "has_children": has_children,
        })
    return children


def _resolve_browser_path(base: Path, raw_path: str) -> Path:
    """Resolve *raw_path* against *base* ensuring it stays inside the root."""

    base_resolved = base.resolve()
    candidate = Path(raw_path)
    if candidate.is_absolute():
        resolved = candidate.resolve()
        try:
            relative = resolved.relative_to(base_resolved)
        except ValueError as exc:
            raise PathOutsideRootError(f"Path '{resolved}' escapes base '{base_resolved}'.") from exc
        if is_internal_rel_path(relative):
            raise FileNotFoundError(f"Path '{resolved}' does not exist.")
        return resolve_within_root(base_resolved, relative.as_posix())
    if is_internal_rel_path(candidate):
        raise FileNotFoundError(f"Path '{candidate}' does not exist.")
    return resolve_within_root(base_resolved, raw_path)


def _launch_default_application(target: Path) -> None:
    """Open *target* using the operating system's default application."""

    if not target.exists():
        raise FileNotFoundError(f"File '{target}' does not exist.")
    if target.is_dir():
        raise IsADirectoryError(f"'{target}' is a directory.")
    system = platform.system()
    if system == "Windows":
        try:
            os.startfile(str(target))  # type: ignore[attr-defined]
        except PermissionError as exc:
            raise PermissionError(f"Permission denied opening '{target}'.") from exc
        except OSError as exc:
            raise RuntimeError(f"Unable to open '{target}': {exc}") from exc
        return
    opener = ["open", str(target)] if system == "Darwin" else ["xdg-open", str(target)]
    kwargs: Dict[str, Any] = {
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if system != "Windows":
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen(opener, **kwargs)
    except FileNotFoundError as exc:
        command = opener[0]
        raise RuntimeError(f"System opener '{command}' is unavailable. Install it to open files from QualiFile.") from exc
    except PermissionError as exc:
        raise PermissionError(f"Permission denied opening '{target}'.") from exc
    except OSError as exc:
        raise RuntimeError(f"Unable to open '{target}': {exc}") from exc


def _reveal_in_explorer(target: Path, select: bool = False) -> None:
    """Open the system file explorer targeting *target*."""

    if not target.exists():
        raise FileNotFoundError(f"Path '{target}' does not exist.")
    system = platform.system()
    explorer_target = target if target.is_dir() else target.parent
    if explorer_target is None:
        explorer_target = target
    if system == "Windows":
        command: list[str] = ["explorer.exe"]
        if select and target.is_file():
            command.extend(["/select,", str(target)])
        else:
            command.append(str(explorer_target))
        if os.getenv("QUALIFILE_DEBUG_REVEAL") == "1":
            logging.getLogger("qualifile").info("Reveal debug: explorer command=%s", [str(arg) for arg in command])
        try:
            subprocess.Popen(command)
        except FileNotFoundError as exc:
            raise RuntimeError("Windows Explorer is unavailable on this system.") from exc
        except PermissionError as exc:
            raise PermissionError(f"Permission denied opening '{target}'.") from exc
        except OSError as exc:
            raise RuntimeError(f"Unable to open '{target}': {exc}") from exc
        return

    if system == "Darwin":
        if select and target.is_file():
            command = ["open", "-R", str(target)]
        else:
            command = ["open", str(explorer_target)]
    else:
        command = ["xdg-open", str(explorer_target)]

    kwargs: Dict[str, Any] = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "start_new_session": True}
    try:
        subprocess.Popen(command, **kwargs)
    except FileNotFoundError as exc:
        raise RuntimeError(f"System explorer command '{command[0]}' is unavailable.") from exc
    except PermissionError as exc:
        raise PermissionError(f"Permission denied opening '{target}'.") from exc
    except OSError as exc:
        raise RuntimeError(f"Unable to open '{target}': {exc}") from exc


EMAIL_ATTACHMENT_SIZE_LIMIT = 34 * 1024 * 1024  # 34 MB ceiling
EMAIL_ATTACHMENT_COUNT_LIMIT = 20  # defensive ceiling for client limits
_ACTIVE_MAPI_CALLS: list[dict[str, object]] = []


def _launch_email_with_attachments(targets: list[Path]) -> None:
    """Launch the default mail client with each path in *targets* attached."""

    if not targets:
        raise ValueError("No files were provided to email.")
    missing = [t for t in targets if not t.exists()]
    if missing:
        raise FileNotFoundError(f"File '{missing[0]}' does not exist.")
    directories = [t for t in targets if t.is_dir()]
    if directories:
        raise IsADirectoryError("Folders cannot be attached to an email.")
    system = platform.system().lower()
    if system == "windows":
        _launch_email_windows(targets)
        return
    if system == "darwin":
        _launch_email_macos(targets)
        return
    _launch_email_linux(targets)


def _describe_mapi_error(code: int) -> str:
    """Return a user-friendly message for Simple MAPI error codes."""

    errors = {
        1: "Email client cancelled the operation.",
        2: "Email client failed to start.",
        3: "Email login failed. Check your mail setup.",
        5: "Not enough memory to open the email client.",
        6: "Permission denied launching the email client.",
        9: "Too many files were attached.",
        11: "Attachment could not be found.",
        12: "Attachment could not be opened.",
        26: "This system does not support sending mail via MAPI.",
    }
    return errors.get(code, f"Mail client returned error code {code}.")


def _email_debug_enabled() -> bool:
    return os.getenv("QUALIFILE_EMAIL_DEBUG") == "1"


def _email_backend_override() -> str:
    return os.getenv("QUALIFILE_EMAIL_BACKEND", "").strip().lower()


def _is_default_mail_client_outlook() -> bool:
    if platform.system() != "Windows":
        return False
    try:
        import winreg
    except Exception:
        return False
    candidates: list[str] = []
    for hive, path, name in (
        (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\MAILTO\UserChoice", "ProgId"),
        (winreg.HKEY_CURRENT_USER, r"Software\Clients\Mail", ""),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\Clients\Mail", ""),
    ):
        try:
            with winreg.OpenKey(hive, path) as key:
                value, _ = winreg.QueryValueEx(key, name)
                if isinstance(value, str) and value:
                    candidates.append(value)
        except OSError:
            continue
    return any("outlook" in value.lower() for value in candidates)


def _launch_email_outlook_com(targets: list[Path]) -> None:
    resolved_paths = [str(path.resolve()) for path in targets]
    if _email_debug_enabled():
        logger = logging.getLogger("qualifile")
        logger.info("Email debug: backend=outlookcom count=%s", len(resolved_paths))
        for path in resolved_paths:
            logger.info("Email debug: attachment=%s", path)
    payload = json.dumps({
        "paths": resolved_paths,
        "subject": "",
        "body": "",
    })
    script = r"""
$ErrorActionPreference = 'Stop'
$payload = $env:QUALIFILE_EMAIL_PAYLOAD
if (-not $payload) { throw 'Missing email payload.' }
$data = $payload | ConvertFrom-Json
$outlook = New-Object -ComObject Outlook.Application
$mail = $outlook.CreateItem(0)
if ($data.subject) { $mail.Subject = $data.subject }
if ($data.body) { $mail.Body = $data.body }
foreach ($path in $data.paths) {
    if ($path) { $null = $mail.Attachments.Add($path) }
}
$null = $mail.Display()
"""
    env = os.environ.copy()
    env["QUALIFILE_EMAIL_PAYLOAD"] = payload
    debug = _email_debug_enabled()
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            check=False,
            env=env,
            stdout=subprocess.PIPE if debug else subprocess.DEVNULL,
            stderr=subprocess.PIPE if debug else subprocess.DEVNULL,
            text=True,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("PowerShell is unavailable; cannot open Outlook.") from exc
    if result.returncode != 0:
        detail = (result.stderr or "").strip() if debug else ""
        message = detail or "Unable to open Outlook compose window."
        raise RuntimeError(message)


def _launch_email_windows_mapi(targets: list[Path]) -> None:
    """Use Simple MAPI to open the configured Windows mail client."""

    try:
        mapi = ctypes.windll.mapi32  # type: ignore[attr-defined]
    except Exception as exc:
        raise RuntimeError("Default mail client is unavailable on this system.") from exc

    send_mail_w = getattr(mapi, "MAPISendMailW", None)
    send_mail_a = getattr(mapi, "MAPISendMail", None)
    if send_mail_w:
        send_mail = send_mail_w
        backend = "mapi_w"
        use_unicode = True
    elif send_mail_a:
        send_mail = send_mail_a
        backend = "mapi_a"
        use_unicode = False
    else:
        raise RuntimeError("MAPI is unavailable; cannot open the email client.")

    buffers: list[ctypes.Array] = []

    if use_unicode:
        class MapiFileDesc(ctypes.Structure):
            _fields_ = [
                ("ulReserved", ctypes.c_ulong),
                ("flFlags", ctypes.c_ulong),
                ("nPosition", ctypes.c_long),
                ("lpszPathName", ctypes.c_wchar_p),
                ("lpszFileName", ctypes.c_wchar_p),
                ("lpFileType", ctypes.c_void_p),
            ]

        class MapiMessage(ctypes.Structure):
            _fields_ = [
                ("ulReserved", ctypes.c_ulong),
                ("lpszSubject", ctypes.c_wchar_p),
                ("lpszNoteText", ctypes.c_wchar_p),
                ("lpszMessageType", ctypes.c_wchar_p),
                ("lpszDateReceived", ctypes.c_wchar_p),
                ("lpszConversationID", ctypes.c_wchar_p),
                ("flFlags", ctypes.c_ulong),
                ("lpOriginator", ctypes.c_void_p),
                ("nRecipCount", ctypes.c_ulong),
                ("lpRecips", ctypes.c_void_p),
                ("nFileCount", ctypes.c_ulong),
                ("lpFiles", ctypes.POINTER(MapiFileDesc)),
            ]

        def to_buffer(value: str) -> ctypes.c_wchar_p:
            buf = ctypes.create_unicode_buffer(value)
            buffers.append(buf)
            return ctypes.cast(buf, ctypes.c_wchar_p)
    else:
        class MapiFileDesc(ctypes.Structure):
            _fields_ = [
                ("ulReserved", ctypes.c_ulong),
                ("flFlags", ctypes.c_ulong),
                ("nPosition", ctypes.c_long),
                ("lpszPathName", ctypes.c_char_p),
                ("lpszFileName", ctypes.c_char_p),
                ("lpFileType", ctypes.c_void_p),
            ]

        class MapiMessage(ctypes.Structure):
            _fields_ = [
                ("ulReserved", ctypes.c_ulong),
                ("lpszSubject", ctypes.c_char_p),
                ("lpszNoteText", ctypes.c_char_p),
                ("lpszMessageType", ctypes.c_char_p),
                ("lpszDateReceived", ctypes.c_char_p),
                ("lpszConversationID", ctypes.c_char_p),
                ("flFlags", ctypes.c_ulong),
                ("lpOriginator", ctypes.c_void_p),
                ("nRecipCount", ctypes.c_ulong),
                ("lpRecips", ctypes.c_void_p),
                ("nFileCount", ctypes.c_ulong),
                ("lpFiles", ctypes.POINTER(MapiFileDesc)),
            ]

        def to_buffer(value: str) -> ctypes.c_char_p:
            try:
                encoded = value.encode("mbcs")
            except UnicodeEncodeError as exc:
                raise RuntimeError("Attachment path could not be encoded for ANSI MAPI.") from exc
            buf = ctypes.create_string_buffer(encoded)
            buffers.append(buf)
            return ctypes.cast(buf, ctypes.c_char_p)

    send_mail.argtypes = [ctypes.c_ulong, ctypes.c_ulong, ctypes.POINTER(MapiMessage), ctypes.c_ulong, ctypes.c_ulong]
    send_mail.restype = ctypes.c_ulong

    absolute_targets = [path.resolve() for path in targets]
    count = len(absolute_targets)
    file_array_type = MapiFileDesc * count
    attachments = file_array_type(
        *[
            MapiFileDesc(0, 0, -1, to_buffer(str(path)), to_buffer(path.name), None)
            for path in absolute_targets
        ]
    )
    message = MapiMessage(0, None, None, None, None, None, 0, None, 0, None, count, attachments)
    flags = 0x00000001 | 0x00000008  # MAPI_LOGON_UI | MAPI_DIALOG

    if _email_debug_enabled():
        logger = logging.getLogger("qualifile")
        logger.info("Email debug: backend=%s count=%s", backend, count)
        for path in absolute_targets:
            logger.info("Email debug: attachment=%s", path)

    result: dict[str, object] = {"code": None, "error": None}
    call_state = {"message": message, "attachments": attachments, "buffers": buffers}

    def _send() -> None:
        try:
            result["code"] = int(send_mail(0, 0, ctypes.byref(message), flags, 0))
        except Exception as exc:  # pragma: no cover - defensive
            result["error"] = exc
        finally:
            try:
                _ACTIVE_MAPI_CALLS.remove(call_state)
            except ValueError:
                pass

    _ACTIVE_MAPI_CALLS.append(call_state)
    thread = threading.Thread(target=_send, daemon=True)
    thread.start()
    thread.join(timeout=3.0)

    if result["error"]:
        raise RuntimeError(f"Unable to open the email client: {result['error']}") from result["error"]  # type: ignore[arg-type]
    if not thread.is_alive() and result["code"] not in (None, 0):
        code = int(result["code"])
        raise RuntimeError(f"{backend} failed with code {code}: {_describe_mapi_error(code)}")

    if _email_debug_enabled() and not thread.is_alive():
        logging.getLogger("qualifile").info("Email debug: %s result=%s", backend, result["code"])


def _launch_email_windows(targets: list[Path]) -> None:
    """Use Simple MAPI to open the configured Windows mail client."""

    backend_override = _email_backend_override()
    if backend_override == "outlookcom":
        _launch_email_outlook_com(targets)
        return
    if backend_override == "mapi":
        _launch_email_windows_mapi(targets)
        return

    prefer_outlook = _is_default_mail_client_outlook()
    if prefer_outlook:
        try:
            _launch_email_outlook_com(targets)
            return
        except Exception as exc:
            if _email_debug_enabled():
                logging.getLogger("qualifile").info("Email debug: outlookcom failed, falling back to mapi: %s", exc)
    try:
        _launch_email_windows_mapi(targets)
        return
    except RuntimeError as exc:
        if _email_debug_enabled():
            logging.getLogger("qualifile").info("Email debug: falling back to outlookcom after %s", exc)
        try:
            _launch_email_outlook_com(targets)
        except Exception as fallback_exc:
            raise RuntimeError(f"Unable to open the email client via MAPI or Outlook: {fallback_exc}") from fallback_exc


def _launch_email_macos(targets: list[Path]) -> None:
    """Use AppleScript to attach *targets* to a new Mail message."""

    script = r"""
on run argv
    tell application "Mail"
        activate
        set newMessage to make new outgoing message with properties {visible:true}
        repeat with rawPath in argv
            set theFile to POSIX file rawPath
            tell content of newMessage
                make new attachment with properties {file name:theFile} at after the last paragraph
            end tell
        end repeat
    end tell
end run
"""
    try:
        result = subprocess.run(
            ["osascript", "-"],
            input=script.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("AppleScript runtime is unavailable; cannot open the mail client.") from exc
    if result.returncode != 0:
        stderr = (result.stderr or b"").decode("utf-8", errors="ignore").strip()
        message = stderr or "Unable to open the mail client."
        raise RuntimeError(message)


def _launch_email_linux(targets: list[Path]) -> None:
    """Launch the default Linux mail client using xdg-email."""

    command = ["xdg-email"]
    for path in targets:
        command.extend(["--attach", str(path)])
    try:
        subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except FileNotFoundError as exc:
        raise RuntimeError("xdg-email is unavailable. Install xdg-utils to send files via email.") from exc
    except OSError as exc:
        raise RuntimeError(f"Unable to launch the email client: {exc}") from exc


def _preview_cache_dir() -> Path:
    """Return the preview cache directory configured for this instance."""

    configured = current_app.config.get("PREVIEW_CACHE_DIR")
    if configured:
        return Path(configured)
    return Path(current_app.instance_path) / "preview_cache"


def _office_cache_dir() -> Path:
    """Return the Office cache directory configured for this instance."""

    configured = current_app.config.get("OFFICE_CACHE_DIR")
    if configured:
        return Path(configured)
    return _preview_cache_dir()


def _apply_tags(payload, store: TagStore, assignments=None):
    """Attach tag assignments to listing responses."""

    if assignments is None:
        assignments = store.assignments
    if isinstance(payload, list):
        for entry in payload:
            if not isinstance(entry, dict):
                continue
            rel = TagStore.normalize_path(entry.get("path"))
            entry["tags"] = assignments.get(rel, [])
        return payload
    if isinstance(payload, dict):
        entries = payload.get("entries")
        if isinstance(entries, list):
            _apply_tags(entries, store, assignments)
        subfolders = payload.get("subfolders")
        if isinstance(subfolders, list):
            for block in subfolders:
                if not isinstance(block, dict):
                    continue
                folder_meta = block.get("folder")
                if isinstance(folder_meta, dict):
                    _apply_tags([folder_meta], store, assignments)
                children = block.get("children")
                if isinstance(children, list):
                    _apply_tags(children, store, assignments)
                elif isinstance(children, dict):
                    _apply_tags(children, store, assignments)
        return payload
    return payload


def _apply_notes(payload, store: NoteStore, cache=None):
    """Attach note metadata (notes + summary) to listing responses."""

    if cache is None:
        cache = {}
    if isinstance(payload, list):
        for entry in payload:
            if not isinstance(entry, dict):
                continue
            rel = NoteStore.normalize_path(entry.get("path"))
            if rel not in cache:
                try:
                    notes = store.get_notes(rel)
                    cache[rel] = {"notes": notes, "summary": store.summarize(notes)}
                except Exception:
                    cache[rel] = {
                        "notes": [],
                        "summary": {
                            "open_count": 0,
                            "closed_count": 0,
                            "has_overdue": False,
                            "has_high_priority": False,
                            "has_status": False,
                        },
                    }
            cached = cache.get(rel) or {"notes": [], "summary": {}}
            entry["notes"] = cached.get("notes", [])
            entry["note_summary"] = cached.get("summary", {})
            if entry.get("is_dir"):
                entry["note_children"] = bool(store.has_descendant_open_notes(rel))
            else:
                entry["note_children"] = False
        return payload
    if isinstance(payload, dict):
        entries = payload.get("entries")
        if isinstance(entries, list):
            _apply_notes(entries, store, cache)
        subfolders = payload.get("subfolders")
        if isinstance(subfolders, list):
            for block in subfolders:
                if not isinstance(block, dict):
                    continue
                folder_meta = block.get("folder")
                if isinstance(folder_meta, dict):
                    _apply_notes([folder_meta], store, cache)
                children = block.get("children")
                if isinstance(children, list):
                    _apply_notes(children, store, cache)
                elif isinstance(children, dict):
                    _apply_notes(children, store, cache)
        return payload
    return payload


def _apply_validation(payload, store: ValidationStore, assignments=None):
    """Attach validation flags to listing responses."""

    if assignments is None:
        assignments = store.assignments

    def _mark(entry):
        if not isinstance(entry, dict):
            return
        rel = ValidationStore.normalize_path(entry.get("path"))
        entry["validated"] = False
        if entry.get("is_dir"):
            return
        if rel and rel != ".":
            entry["validated"] = bool(assignments.get(rel, False))

    if isinstance(payload, list):
        for entry in payload:
            _mark(entry)
        return payload
    if isinstance(payload, dict):
        entries = payload.get("entries")
        if isinstance(entries, list):
            _apply_validation(entries, store, assignments)
        subfolders = payload.get("subfolders")
        if isinstance(subfolders, list):
            for block in subfolders:
                if not isinstance(block, dict):
                    continue
                folder_meta = block.get("folder")
                if isinstance(folder_meta, dict):
                    _apply_validation([folder_meta], store, assignments)
                children = block.get("children")
                if isinstance(children, list):
                    _apply_validation(children, store, assignments)
                elif isinstance(children, dict):
                    _apply_validation(children, store, assignments)
        return payload
    return payload


_NUMBERED_LINE = re.compile(r"^(?P<prefix>\d+(?:\.\d+)*)(?:\s+(?P<label>.*))?$")


def _parse_template(text: str, *, label_mode: str = "full") -> List[Dict[str, Any]]:
    """Parse the structure import template into creation instructions."""

    plan: List[Dict[str, Any]] = []
    outline_paths: Dict[tuple[int, ...], Path] = {(): Path("")}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("-"):
            line = line[1:].strip()
        if not line:
            continue
        match = _NUMBERED_LINE.match(line)
        if not match:
            raise ValueError("Each line must start with a numeric outline such as '3.1 Title'.")
        prefix = match.group("prefix")
        label = (match.group("label") or "").strip()
        numbers = tuple(int(part) for part in prefix.split("."))
        parent_key = numbers[:-1]
        if parent_key not in outline_paths:
            missing = ".".join(str(part) for part in parent_key) or "root level"
            raise ValueError(f"Parent entry '{missing}' is missing for '{prefix}'.")
        segment = _render_segment(prefix, label, label_mode)
        current_path = outline_paths[parent_key] / segment
        plan.append({"path": current_path, "is_dir": True})
        outline_paths[numbers] = current_path
    unique: List[Dict[str, Any]] = []
    seen = set()
    for item in plan:
        key = (str(item["path"]), item["is_dir"])
        if key in seen:
            continue
        seen.add(key)
        unique.append({"path": item["path"].as_posix(), "is_dir": item["is_dir"]})
    return unique


def _render_segment(prefix: str, label: str, label_mode: str) -> str:
    """Return the folder name according to the chosen label mode."""

    if label_mode == "numeric" or not label:
        base = prefix
    else:
        base = f"{prefix} {label}".strip()
    return _sanitize_segment(base)


_TEMPLATE_MAX_SEGMENT = 120
_TEMPLATE_REPLACEMENTS = {
    ":": " - ",
    "*": "_",
    "?": "",
    "\"": "'",
    "<": "(",
    ">": ")",
    "|": "-",
    "/": "-",
    "\\": "-",
}


def _sanitize_segment(token: str) -> str:
    """Ensure template segments are valid folder/file names."""

    from ...features.filesystem.service import safe_secure_filename

    candidate = (token or "").replace("\0", "")
    for bad, replacement in _TEMPLATE_REPLACEMENTS.items():
        candidate = candidate.replace(bad, replacement)
    candidate = re.sub(r"\s+", " ", candidate).strip()
    if not candidate:
        raise ValueError("Name cannot be empty.")
    candidate = safe_secure_filename(candidate)
    candidate = re.sub(r"\s+", " ", candidate).strip()
    if len(candidate) > _TEMPLATE_MAX_SEGMENT:
        candidate = candidate[:_TEMPLATE_MAX_SEGMENT].rstrip(" ._-")
    if not candidate:
        raise ValueError("Name cannot be empty.")
    return candidate


def _auto_rename(path: Path) -> Path:
    """Return a non-colliding path by appending a numeric suffix."""

    stem = path.stem if path.suffix else path.name
    suffix = path.suffix
    counter = 1
    candidate = path
    while candidate.exists():
        candidate = path.with_name(f"{stem} ({counter}){suffix}")
        counter += 1
    return candidate
