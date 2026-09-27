from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import traceback
from app.shared.redaction import redact_text


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_append(path: Path, line: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(redact_text(line, max_chars=8192))
        if path.stat().st_size > 256_000:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True)
            kept: list[str] = []
            used = 0
            for entry in reversed(lines):
                size = len(entry.encode("utf-8"))
                if kept and used + size > 256_000:
                    break
                kept.append(entry)
                used += size
            path.write_text("".join(reversed(kept)), encoding="utf-8")
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
    summary = redact_text(f"{context}: {type(exc).__name__}: {exc}")
    _safe_append(Path(log_dir) / "spd_ui.log", f"{_timestamp()} {summary}\n")
    try:
        detail = redact_text(
            "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
            max_chars=8192,
        )
        _safe_append(Path(log_dir) / "spd_ui.log", detail)
    except Exception:
        return
