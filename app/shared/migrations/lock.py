"""Cross-platform migration lock helper."""

from __future__ import annotations

import json
import os
import socket
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


LOCK_FILENAME = "migration.lock"


@dataclass(frozen=True)
class MigrationLockInfo:
    pid: int
    started_at: str
    host: str
    holder: str | None


class MigrationLockError(RuntimeError):
    def __init__(self, message: str, info: MigrationLockInfo | None = None):
        super().__init__(message)
        self.info = info


def lock_path(data_dir: Path) -> Path:
    return Path(data_dir) / ".qualifile_internal" / LOCK_FILENAME


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_lock_info(path: Path) -> MigrationLockInfo | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    pid = payload.get("pid")
    started_at = payload.get("started_at")
    host = payload.get("host")
    holder = payload.get("holder")
    if not isinstance(pid, int) or not isinstance(started_at, str) or not isinstance(host, str):
        return None
    return MigrationLockInfo(pid=pid, started_at=started_at, host=host, holder=str(holder) if holder else None)


def _format_lock_error(path: Path, info: MigrationLockInfo | None) -> str:
    if info is None:
        return f"Migration lock already held at {path}."
    holder_text = f" holder={info.holder}" if info.holder else ""
    return (
        "Migration lock already held at %s (pid=%s host=%s started_at=%s%s)."
        % (path, info.pid, info.host, info.started_at, holder_text)
    )


def acquire_lock(
    data_dir: Path,
    *,
    holder: str | None = None,
    force: bool = False,
    stale_seconds: int | None = None,
) -> Path:
    path = lock_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)

    if force:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except Exception:
            pass
    elif stale_seconds is not None and stale_seconds >= 0 and path.exists():
        try:
            age_seconds = max(0.0, (datetime.now(timezone.utc) - datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)).total_seconds())
        except Exception:
            age_seconds = 0.0
        if age_seconds >= stale_seconds:
            try:
                path.unlink()
            except Exception:
                pass

    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    try:
        fd = os.open(str(path), flags)
    except FileExistsError:
        info = _read_lock_info(path)
        raise MigrationLockError(_format_lock_error(path, info), info=info)

    payload: dict[str, Any] = {
        "pid": os.getpid(),
        "started_at": _now_iso(),
        "host": socket.gethostname(),
        "holder": holder,
    }
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
    except Exception:
        try:
            os.close(fd)
        except Exception:
            pass
        try:
            path.unlink()
        except Exception:
            pass
        raise

    return path


def release_lock(path: Path) -> None:
    try:
        Path(path).unlink()
    except FileNotFoundError:
        pass


__all__ = [
    "LOCK_FILENAME",
    "MigrationLockError",
    "MigrationLockInfo",
    "acquire_lock",
    "lock_path",
    "release_lock",
]
