"""Bounded, deterministic redaction for logs, diagnostics, and support data."""

from __future__ import annotations

import re
from typing import Any


_URL = re.compile(r"(?i)\b(?:https?|ftp)://[^\s\"'<>]+")
_BEARER = re.compile(r"(?i)\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}")
_ASSIGNMENT = re.compile(
    r"(?i)(?<![A-Za-z0-9_])"
    r"([\"']?[A-Za-z0-9_]*(?:token|password|passwd|secret|api[_-]?key|authorization|cookie)[\"']?)"
    r"(\s*[:=]\s*)(?:\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|[^\s,;\"'{}]+)"
)
_WINDOWS_PATH = re.compile(
    r"(?i)(?:[A-Z]:[\\/]|\\\\[^\\/\s]+[\\/])(?:[^\r\n\"'<>|,;]+)"
)
_PERSONAL_POSIX_PATH = re.compile(
    r"(?i)/(?:home|users|private|root|mnt/[a-z])/[^\r\n\"'<>|,;]+"
)
_SENSITIVE_KEYS = {
    "authorization",
    "cookie",
    "password",
    "passwd",
    "secret",
    "token",
    "access_token",
    "refresh_token",
    "api_key",
}
_SENSITIVE_KEY_PART = re.compile(
    r"(?i)(?:^|[_-])(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|authorization|cookie)(?:$|[_-])"
)


def redact_text(value: object, *, max_chars: int = 2048) -> str:
    text = str(value)
    text = _BEARER.sub("<credential>", text)
    text = _ASSIGNMENT.sub(lambda match: f"{match.group(1)}{match.group(2)}<redacted>", text)
    text = _URL.sub("<url>", text)
    text = _WINDOWS_PATH.sub("<path>", text)
    text = _PERSONAL_POSIX_PATH.sub("<path>", text)
    text = "".join(character for character in text if character in "\n\r\t" or ord(character) >= 32)
    if len(text) > max_chars:
        text = f"{text[:max_chars]}…"
    return text


def redact_value(
    value: Any,
    *,
    depth: int = 0,
    max_depth: int = 6,
    max_items: int = 50,
) -> Any:
    if depth >= max_depth:
        return "<truncated>"
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= max_items:
                result["<truncated>"] = True
                break
            clean_key = redact_text(key, max_chars=128)
            if str(key).casefold() in _SENSITIVE_KEYS or _SENSITIVE_KEY_PART.search(str(key)):
                result[clean_key] = "<redacted>"
            else:
                result[clean_key] = redact_value(
                    item,
                    depth=depth + 1,
                    max_depth=max_depth,
                    max_items=max_items,
                )
        return result
    if isinstance(value, (list, tuple, set)):
        return [
            redact_value(
                item,
                depth=depth + 1,
                max_depth=max_depth,
                max_items=max_items,
            )
            for item in list(value)[:max_items]
        ]
    if isinstance(value, str):
        return redact_text(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return redact_text(value)


__all__ = ["redact_text", "redact_value"]
