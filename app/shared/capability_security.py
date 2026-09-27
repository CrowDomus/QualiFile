"""Common containment controls for host operating-system capabilities."""

from __future__ import annotations

from collections import deque
from functools import wraps
import math
import os
from pathlib import Path
import threading
import time
from typing import Callable, ParamSpec, TypeVar

from flask import Response, current_app, jsonify, request


P = ParamSpec("P")
R = TypeVar("R")


# ShellExecute/open-with is an execution boundary on Windows. Keep this list
# intentionally narrow: every unlisted or extensionless type is denied.
PASSIVE_OPEN_SUFFIXES = frozenset(
    {
        # Plain data and documentation.
        ".cfg",
        ".conf",
        ".csv",
        ".ini",
        ".json",
        ".json5",
        ".log",
        ".markdown",
        ".md",
        ".properties",
        ".rst",
        ".toml",
        ".tsv",
        ".txt",
        ".yaml",
        ".yml",
        # Inert preview/media formats supported by QualiFile.
        ".bmp",
        ".gif",
        ".ico",
        ".jpeg",
        ".jpg",
        ".pdf",
        ".png",
        ".tif",
        ".tiff",
        ".webp",
        # Macro-free modern Office and OpenDocument formats.
        ".docx",
        ".odp",
        ".ods",
        ".odt",
        ".pptx",
        ".xlsx",
    }
)


DEFAULT_RATE_LIMITS: dict[str, tuple[int, float]] = {
    "preview": (120, 60),
    "preview_cancel": (60, 60),
    "open": (12, 60),
    "reveal": (30, 60),
    "email": (6, 60),
    "greenshot": (10, 60),
    "open_data_dir": (6, 60),
    "screenshot": (10, 60),
    "annotation": (20, 60),
    "merge": (4, 60),
    "pdf_extract": (6, 60),
    "settings": (30, 60),
    "log_write": (60, 60),
    "log_read": (30, 60),
    "cache_clear": (4, 60),
    "shutdown": (1, 60),
}


def cache_root_identity(path: str | os.PathLike[str]) -> str:
    """Return a lexical, case-normalized identity without following links."""

    candidate = Path(path)
    if not candidate.is_absolute():
        raise ValueError("Cache roots must be absolute paths.")
    return os.path.normcase(os.path.abspath(os.fspath(candidate)))


def is_passive_open_path(path: Path) -> bool:
    """Return whether *path* is a deliberately approved passive file type."""

    name = path.name
    if not name or ":" in name or any(ord(character) < 32 for character in name):
        return False
    return path.suffix.casefold() in PASSIVE_OPEN_SUFFIXES


def _error(status: int, code: str, message: str) -> Response:
    response = jsonify(
        {
            "ok": False,
            "code": code,
            "error": {"code": code, "message": message},
            "error_message": message,
        }
    )
    response.status_code = status
    response.headers["Cache-Control"] = "no-store"
    return response


def _limit_for(name: str) -> tuple[int, float] | None:
    configured = current_app.config.get("CAPABILITY_RATE_LIMITS", {})
    value = configured.get(name) if isinstance(configured, dict) else None
    if value is None:
        value = DEFAULT_RATE_LIMITS.get(name)
    if value is None:
        return None
    try:
        count, window = value
        count = int(count)
        window = float(window)
    except (TypeError, ValueError):
        return (0, 60)
    if count < 1 or not math.isfinite(window) or window <= 0:
        return (0, 60)
    return count, window


def _rate_error(name: str) -> Response | None:
    limit = _limit_for(name)
    if limit is None:
        return None
    count, window = limit
    if count == 0:
        return _error(429, "rate-limited", "This action is temporarily unavailable.")
    state = current_app.extensions.setdefault(
        "qualifile_capability_rates",
        {"lock": threading.Lock(), "events": {}},
    )
    now = time.monotonic()
    with state["lock"]:
        events = state["events"].setdefault(name, deque())
        cutoff = now - window
        while events and events[0] <= cutoff:
            events.popleft()
        if len(events) >= count:
            retry_after = max(1, math.ceil(window - (now - events[0])))
            response = _error(429, "rate-limited", "Too many requests. Try again later.")
            response.headers["Retry-After"] = str(retry_after)
            return response
        events.append(now)
    return None


def capability_guard(
    name: str,
    *,
    max_body_bytes: int | None,
) -> Callable[[Callable[P, R]], Callable[P, R | Response]]:
    """Require a local peer, bounded body, and per-capability request budget."""

    def decorator(function: Callable[P, R]) -> Callable[P, R | Response]:
        @wraps(function)
        def wrapped(*args: P.args, **kwargs: P.kwargs) -> R | Response:
            remote = request.remote_addr
            if remote not in {"127.0.0.1", "::1", "localhost"}:
                return _error(403, "forbidden", "This action is only available locally.")
            if (
                max_body_bytes is not None
                and request.content_length is not None
                and request.content_length > max_body_bytes
            ):
                return _error(413, "request-too-large", "Request body exceeds the allowed size.")
            rate_error = _rate_error(name)
            if rate_error is not None:
                return rate_error
            return function(*args, **kwargs)

        return wrapped

    return decorator


def reject_unknown_fields(data: dict, allowed: set[str] | frozenset[str]) -> Response | None:
    if set(data) - set(allowed):
        return _error(400, "invalid", "Request contains unsupported fields.")
    return None
