"""Deterministic JSON serialization helpers for Git Sync PPS files."""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

PPS_JSON_ENCODING = "utf-8"
PPS_NEWLINE = "\n"
PPS_INDENT = 2

_TMP_PREFIX = ".qualifile_tmp_"
_REPLACE_RETRIES = 3
_REPLACE_DELAY_SECONDS = 0.05


def _normalize_encoding(encoding: str) -> str:
    text = (encoding or "").strip().lower()
    if text in {"utf-8", "utf8"}:
        return PPS_JSON_ENCODING
    raise ValueError("PPS JSON encoding must be UTF-8.")


def _validate_newline(newline: str) -> str:
    if newline != PPS_NEWLINE:
        raise ValueError("PPS JSON newline must be LF ('\\n').")
    return newline


def _replace_with_retry(src: Path, dest: Path) -> None:
    last_exc: Exception | None = None
    for attempt in range(_REPLACE_RETRIES):
        try:
            src.replace(dest)
            return
        except Exception as exc:  # noqa: BLE001 - retry handles transient file locks
            last_exc = exc
            if attempt + 1 < _REPLACE_RETRIES:
                time.sleep(_REPLACE_DELAY_SECONDS * (2 ** attempt))
            else:
                raise
    if last_exc is not None:
        raise last_exc


def _atomic_write_bytes(path: Path | str, payload: bytes) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)

    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", delete=False, dir=str(target.parent), prefix=_TMP_PREFIX) as temp:
            temp_path = Path(temp.name)
            temp.write(payload)
            temp.flush()
            os.fsync(temp.fileno())
        _replace_with_retry(temp_path, target)
    except Exception:
        if temp_path and temp_path.exists():
            try:
                temp_path.unlink()
            except Exception:
                pass
        raise


def serialize_pps_json(payload: Any, *, encoding: str = PPS_JSON_ENCODING, newline: str = PPS_NEWLINE) -> bytes:
    """Serialize a PPS JSON payload deterministically."""

    _normalize_encoding(encoding)
    _validate_newline(newline)

    try:
        text = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            indent=PPS_INDENT,
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise ValueError("PPS payload must be JSON-serializable and JSON-compliant.") from exc

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.endswith(PPS_NEWLINE):
        text = f"{text}{PPS_NEWLINE}"
    return text.encode(PPS_JSON_ENCODING)


def write_pps_json(path: Path | str, payload: Any, *, encoding: str = PPS_JSON_ENCODING, newline: str = PPS_NEWLINE) -> None:
    """Write a PPS JSON payload with deterministic formatting and atomic replace semantics."""

    serialized = serialize_pps_json(payload, encoding=encoding, newline=newline)
    _atomic_write_bytes(path, serialized)


__all__ = [
    "PPS_INDENT",
    "PPS_JSON_ENCODING",
    "PPS_NEWLINE",
    "serialize_pps_json",
    "write_pps_json",
]
