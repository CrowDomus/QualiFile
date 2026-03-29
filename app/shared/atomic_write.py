"""Helpers for safe atomic writes with cleanup and retry."""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

_TMP_PREFIX = ".qualifile_tmp_"
_REPLACE_RETRIES = 3
_REPLACE_DELAY_SECONDS = 0.05


def _replace_with_retry(src: Path, dest: Path) -> None:
    last_exc: Exception | None = None
    for attempt in range(_REPLACE_RETRIES):
        try:
            src.replace(dest)
            return
        except Exception as exc:  # noqa: BLE001 - fallback to retry for transient locks
            last_exc = exc
            if attempt + 1 < _REPLACE_RETRIES:
                time.sleep(_REPLACE_DELAY_SECONDS * (2 ** attempt))
            else:
                raise
    if last_exc is not None:
        raise last_exc


def atomic_write_text(path: Path | str, text: str, *, encoding: str = "utf-8") -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            delete=False,
            encoding=encoding,
            dir=str(target.parent),
            prefix=_TMP_PREFIX,
        ) as temp:
            temp_path = Path(temp.name)
            temp.write(text)
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


def atomic_write_json(path: Path | str, payload: Any, *, encoding: str = "utf-8", **dump_kwargs: Any) -> None:
    text = json.dumps(payload, **dump_kwargs)
    atomic_write_text(path, text, encoding=encoding)

