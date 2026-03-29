from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import traceback


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_append(path: Path, line: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)
    except Exception:
        return


def append_line(log_dir: str | Path | None, line: str) -> None:
    if not log_dir:
        return
    path = Path(log_dir) / "spd_ui.log"
    _safe_append(path, f"{_timestamp()} {line}\n")


def append_exc(log_dir: str | Path | None, context: str, exc: Exception) -> None:
    if not log_dir:
        return
    summary = f"{context}: {type(exc).__name__}: {exc}"
    _safe_append(Path(log_dir) / "spd_ui.log", f"{_timestamp()} {summary}\n")
    try:
        detail = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        _safe_append(Path(log_dir) / "spd_ui.log", detail)
    except Exception:
        return
