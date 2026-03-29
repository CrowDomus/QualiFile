"""Backup helpers for migration safety (DB-first)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import shutil

from ..atomic_write import atomic_write_json
from ..db import DB_FILENAME, INTERNAL_DIRNAME

BACKUP_DIRNAME = "backups"
MANIFEST_FILENAME = "manifest.json"
MANIFEST_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class BackupResult:
    backup_dir: Path
    manifest_path: Path
    created_at: str
    backup_id: str
    items: list[dict[str, Any]]
    missing: list[str]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_compact() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def backup_root(data_dir: Path) -> Path:
    return Path(data_dir) / INTERNAL_DIRNAME / BACKUP_DIRNAME


def create_backup_dir(data_dir: Path, *, timestamp: str | None = None) -> tuple[Path, str]:
    root = backup_root(data_dir)
    root.mkdir(parents=True, exist_ok=True)
    backup_id = timestamp or _now_compact()
    candidate = root / backup_id
    if not candidate.exists():
        candidate.mkdir(parents=True, exist_ok=True)
        return candidate, backup_id

    suffix = 1
    while True:
        attempt_id = f"{backup_id}-{suffix}"
        attempt = root / attempt_id
        if not attempt.exists():
            attempt.mkdir(parents=True, exist_ok=True)
            return attempt, attempt_id
        suffix += 1


def _relative_to_data_dir(path: Path, data_dir: Path) -> str:
    try:
        return str(path.resolve().relative_to(Path(data_dir).resolve()))
    except Exception:
        return str(path)


def snapshot_sqlite_backup(data_dir: Path) -> BackupResult:
    data_dir = Path(data_dir)
    backup_dir, backup_id = create_backup_dir(data_dir)
    created_at = _now_iso()

    db_dir = data_dir / INTERNAL_DIRNAME
    sources = [
        db_dir / DB_FILENAME,
        db_dir / f"{DB_FILENAME}-wal",
        db_dir / f"{DB_FILENAME}-shm",
    ]

    items: list[dict[str, Any]] = []
    missing: list[str] = []

    for source in sources:
        if not source.exists():
            missing.append(_relative_to_data_dir(source, data_dir))
            continue
        if not source.is_file():
            missing.append(_relative_to_data_dir(source, data_dir))
            continue
        destination = backup_dir / source.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        items.append(
            {
                "source": _relative_to_data_dir(source, data_dir),
                "dest": str(destination.name),
                "size_bytes": destination.stat().st_size,
            }
        )

    manifest = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "backup_id": backup_id,
        "created_at": created_at,
        "data_dir": str(data_dir),
        "items": items,
        "missing": missing,
    }
    manifest_path = backup_dir / MANIFEST_FILENAME
    atomic_write_json(manifest_path, manifest, indent=2, sort_keys=True)
    return BackupResult(
        backup_dir=backup_dir,
        manifest_path=manifest_path,
        created_at=created_at,
        backup_id=backup_id,
        items=items,
        missing=missing,
    )


def restore_sqlite_backup(backup_dir: Path, data_dir: Path) -> list[Path]:
    backup_dir = Path(backup_dir)
    data_dir = Path(data_dir)
    restored: list[Path] = []
    if not backup_dir.exists():
        return restored

    db_dir = data_dir / INTERNAL_DIRNAME
    db_dir.mkdir(parents=True, exist_ok=True)
    for name in (DB_FILENAME, f"{DB_FILENAME}-wal", f"{DB_FILENAME}-shm"):
        source = backup_dir / name
        if not source.exists():
            continue
        destination = db_dir / name
        shutil.copy2(source, destination)
        restored.append(destination)
    return restored


__all__ = [
    "BACKUP_DIRNAME",
    "MANIFEST_FILENAME",
    "BackupResult",
    "backup_root",
    "create_backup_dir",
    "restore_sqlite_backup",
    "snapshot_sqlite_backup",
]
