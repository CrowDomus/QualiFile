"""Retention policy enforcement for logs, caches, and backups."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import shutil
import time
from typing import Mapping

from ..data_dir import resolve_paths
from ..migrations.backup import backup_root

DEFAULT_RETENTION_DAYS = 30

STARTUP_LOG_FILES = (
    "portable_startup.log",
    "launcher_startup.log",
    "embedded_backend_startup.log",
    "portable_backend.log",
)


@dataclass(frozen=True)
class RetentionReport:
    startup_logs_removed: int
    cache_files_removed: int
    backup_dirs_removed: int


def _read_int(config: Mapping[str, object] | None, key: str, env_key: str, default: int) -> int:
    if config is not None and key in config:
        raw = config.get(key)
    else:
        raw = os.environ.get(env_key)
    try:
        return min(max(int(raw), 1), 3650)  # type: ignore[arg-type]
    except Exception:
        return default


def _read_bool(config: Mapping[str, object] | None, key: str, env_key: str, default: bool) -> bool:
    if config is not None and key in config:
        raw = config.get(key)
    else:
        raw = os.environ.get(env_key)
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def _cutoff_epoch(days: int) -> float:
    return time.time() - (days * 86400)


def _remove_file(path: Path) -> bool:
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False
    except Exception:
        return False


def _prune_startup_logs(logs_dir: Path, cutoff: float) -> int:
    removed = 0
    for name in STARTUP_LOG_FILES:
        path = logs_dir / name
        if not path.exists():
            continue
        try:
            if path.stat().st_mtime < cutoff:
                if _remove_file(path):
                    removed += 1
        except Exception:
            continue
    return removed


def _prune_cache_dir(cache_dir: Path, cutoff: float) -> int:
    removed = 0
    if not cache_dir.exists():
        return 0
    for path in cache_dir.rglob("*"):
        if not path.is_file():
            continue
        try:
            if path.stat().st_mtime < cutoff:
                if _remove_file(path):
                    removed += 1
        except Exception:
            continue
    # Remove empty directories bottom-up.
    for path in sorted(cache_dir.rglob("*"), reverse=True):
        if path.is_dir():
            try:
                path.rmdir()
            except Exception:
                continue
    return removed


def _backup_created_at(backup_dir: Path) -> float:
    manifest = backup_dir / "manifest.json"
    if manifest.exists():
        try:
            raw = manifest.read_text(encoding="utf-8")
        except Exception:
            raw = ""
        if raw:
            try:
                import json

                payload = json.loads(raw)
                created_at = payload.get("created_at")
                if isinstance(created_at, str):
                    from datetime import datetime

                    return datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp()
            except Exception:
                pass
    try:
        return backup_dir.stat().st_mtime
    except Exception:
        return time.time()


def _prune_backups(backups_dir: Path, cutoff: float) -> int:
    removed = 0
    if not backups_dir.exists():
        return removed
    for backup_dir in backups_dir.iterdir():
        if not backup_dir.is_dir():
            continue
        try:
            created_at = _backup_created_at(backup_dir)
            if created_at < cutoff:
                shutil.rmtree(backup_dir, ignore_errors=True)
                removed += 1
        except Exception:
            continue
    return removed


def apply_retention_policies(data_dir: Path, config: Mapping[str, object] | None = None) -> RetentionReport:
    if not _read_bool(config, "RETENTION_ENABLED", "QUALIFILE_RETENTION_ENABLED", True):
        return RetentionReport(startup_logs_removed=0, cache_files_removed=0, backup_dirs_removed=0)

    startup_days = _read_int(
        config,
        "RETENTION_STARTUP_LOG_DAYS",
        "QUALIFILE_STARTUP_LOG_RETENTION_DAYS",
        DEFAULT_RETENTION_DAYS,
    )
    cache_days = _read_int(
        config,
        "RETENTION_CACHE_DAYS",
        "QUALIFILE_CACHE_RETENTION_DAYS",
        DEFAULT_RETENTION_DAYS,
    )
    backup_days = _read_int(
        config,
        "RETENTION_BACKUP_DAYS",
        "QUALIFILE_BACKUP_RETENTION_DAYS",
        DEFAULT_RETENTION_DAYS,
    )

    paths = resolve_paths(Path(data_dir))

    startup_removed = 0
    if startup_days > 0:
        startup_removed = _prune_startup_logs(paths.logs_dir, _cutoff_epoch(startup_days))

    cache_removed = 0
    if cache_days > 0:
        cache_removed += _prune_cache_dir(paths.preview_cache_dir, _cutoff_epoch(cache_days))
        cache_removed += _prune_cache_dir(paths.office_cache_dir, _cutoff_epoch(cache_days))

    backup_removed = 0
    if backup_days > 0:
        backup_removed = _prune_backups(backup_root(data_dir), _cutoff_epoch(backup_days))

    return RetentionReport(
        startup_logs_removed=startup_removed,
        cache_files_removed=cache_removed,
        backup_dirs_removed=backup_removed,
    )


__all__ = ["RetentionReport", "apply_retention_policies"]
