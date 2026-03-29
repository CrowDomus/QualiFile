"""Dry-run migration coordinator."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..atomic_write import atomic_write_json
from ..data_contract.registry import load_registry
from ..db_validation import db_path_for_data_dir, validate_db_path
from .backup import BackupResult, restore_sqlite_backup, snapshot_sqlite_backup
from .lock import MigrationLockError, acquire_lock, release_lock
from .version_probe import detect_schema_versions

REPORT_SCHEMA_VERSION = 1
PROGRESS_SCHEMA_VERSION = 1


class SimulatedMigrationError(RuntimeError):
    """Raised when a migration failure is intentionally simulated."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_diagnostics_dir(data_dir: Path) -> Path:
    diagnostics_dir = Path(data_dir) / "diagnostics"
    diagnostics_dir.mkdir(parents=True, exist_ok=True)
    return diagnostics_dir


def run_migration_dry_run(
    data_dir: Path,
    *,
    registry_path: str | Path | None = None,
    workspace_root: Path | None = None,
    simulate_failure: bool = False,
    enable_backup: bool = True,
) -> dict[str, Any]:
    data_dir = Path(data_dir)
    diagnostics_dir = _ensure_diagnostics_dir(data_dir)
    progress_path = diagnostics_dir / "upgrade_in_progress.json"
    report_path = diagnostics_dir / "last_migration_report.json"
    started_at = _now_iso()
    lock_path = acquire_lock(data_dir, holder="dry-run")
    backup_result: BackupResult | None = None

    progress_payload = {
        "schema_version": PROGRESS_SCHEMA_VERSION,
        "status": "running",
        "dry_run": True,
        "started_at": started_at,
        "pid": os.getpid(),
        "data_dir": str(data_dir),
    }
    atomic_write_json(progress_path, progress_payload, indent=2, sort_keys=True)

    report: dict[str, Any] = {}
    try:
        if enable_backup:
            backup_result = snapshot_sqlite_backup(data_dir)
        pre_validation = validate_db_path(db_path_for_data_dir(data_dir))
        registry = load_registry(registry_path)
        schemas = detect_schema_versions(registry, data_dir, workspace_root=workspace_root)
        if simulate_failure:
            raise SimulatedMigrationError("Simulated migration failure.")
        post_validation = validate_db_path(db_path_for_data_dir(data_dir))
        report = {
            "schema_version": REPORT_SCHEMA_VERSION,
            "status": "ok",
            "dry_run": True,
            "generated_at": _now_iso(),
            "data_dir": str(data_dir),
            "registry": {
                "path": str(registry_path) if registry_path else None,
                "registry_version": registry.registry_version,
            },
            "schemas": schemas,
            "db_validation": {
                "pre": pre_validation,
                "post": post_validation,
            },
        }
        if backup_result is not None:
            report["backup"] = {
                "path": str(backup_result.backup_dir),
                "manifest": str(backup_result.manifest_path),
                "created_at": backup_result.created_at,
            }
        atomic_write_json(report_path, report, indent=2, sort_keys=True)
    except MigrationLockError:
        raise
    except Exception as exc:  # pragma: no cover - error path
        restored = []
        if backup_result is not None:
            restored = restore_sqlite_backup(backup_result.backup_dir, data_dir)
        report = {
            "schema_version": REPORT_SCHEMA_VERSION,
            "status": "error",
            "dry_run": True,
            "generated_at": _now_iso(),
            "data_dir": str(data_dir),
            "error": type(exc).__name__,
            "message": str(exc),
        }
        if backup_result is not None:
            report["backup"] = {
                "path": str(backup_result.backup_dir),
                "manifest": str(backup_result.manifest_path),
                "created_at": backup_result.created_at,
                "restored": bool(restored),
            }
        atomic_write_json(report_path, report, indent=2, sort_keys=True)
        raise
    finally:
        try:
            progress_path.unlink()
        except FileNotFoundError:
            pass
        except Exception:
            pass
        release_lock(lock_path)

    return report


__all__ = [
    "run_migration_dry_run",
    "REPORT_SCHEMA_VERSION",
    "PROGRESS_SCHEMA_VERSION",
    "SimulatedMigrationError",
]
