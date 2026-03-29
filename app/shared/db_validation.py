"""SQLite schema validation helpers."""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Iterable, Mapping

from .db import load_db_settings_from_config, open_connection, resolve_db_path
from .db_migrations import apply_migrations, list_pending_migrations
from .migrations.lock import MigrationLockError, acquire_lock, release_lock


REQUIRED_TABLES: tuple[str, ...] = (
    "schema_migrations",
    "roots",
    "projects",
    "entries",
    "tag_definitions",
    "profile_preferences",
    "migration_journal",
    "file_index",
    "tag_index",
    "entry_index",
    "user_profiles",
    "profile_portable_preferences",
    "app_state",
    "task_alert_state",
)
INVARIANT_REQUIRED_COLUMNS: dict[str, tuple[str, ...]] = {
    "entries": ("payload_json",),
}
LOCK_RETRIES = 5
LOCK_RETRY_DELAY_SECONDS = 0.2


class DatabaseValidationError(RuntimeError):
    def __init__(self, missing_tables: Iterable[str], message: str | None = None) -> None:
        self.missing_tables = sorted(set(str(table) for table in missing_tables))
        summary = ", ".join(self.missing_tables)
        super().__init__(message or f"Database validation failed; missing tables: {summary}.")


class DatabaseInvariantError(RuntimeError):
    def __init__(self, issues: Iterable[str], message: str | None = None) -> None:
        self.issues = [str(issue) for issue in issues if issue]
        summary = "; ".join(self.issues) if self.issues else "unknown invariant failure"
        super().__init__(message or f"Database invariant validation failed; {summary}.")


class DatabaseMigrationLockError(RuntimeError):
    pass


def _list_tables(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    return {row[0] for row in rows if row and row[0]}


def missing_tables(conn: sqlite3.Connection, *, required: Iterable[str] = REQUIRED_TABLES) -> list[str]:
    required_set = {name for name in required if name}
    present = _list_tables(conn)
    return sorted(required_set - present)


def validate_db_connection(conn: sqlite3.Connection, *, required: Iterable[str] = REQUIRED_TABLES) -> list[str]:
    return missing_tables(conn, required=required)


def _run_integrity_check(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute("PRAGMA quick_check").fetchall()
    failures: list[str] = []
    for row in rows:
        if not row:
            continue
        value = row[0]
        if value != "ok":
            failures.append(str(value))
    return failures


def _pending_migrations(conn: sqlite3.Connection) -> list[str]:
    return [migration.migration_id for migration in list_pending_migrations(conn)]


def _foreign_key_violations(conn: sqlite3.Connection) -> int:
    enabled = conn.execute("PRAGMA foreign_keys").fetchone()
    if not enabled or enabled[0] != 1:
        return 0
    rows = conn.execute("PRAGMA foreign_key_check").fetchall()
    return len(rows)


def _missing_required_columns(conn: sqlite3.Connection) -> list[str]:
    missing: list[str] = []
    for table, columns in INVARIANT_REQUIRED_COLUMNS.items():
        info = conn.execute(f"PRAGMA table_info({table})").fetchall()
        present = {row[1] for row in info if len(row) > 1}
        for column in columns:
            if column not in present:
                missing.append(f"{table}.{column}")
    return missing


def validate_db_invariants(conn: sqlite3.Connection) -> list[str]:
    issues: list[str] = []

    integrity_failures = _run_integrity_check(conn)
    if integrity_failures:
        issues.append("Integrity check failed: " + "; ".join(integrity_failures))

    pending = _pending_migrations(conn)
    if pending:
        issues.append("Pending migrations: " + ", ".join(pending))

    fk_violations = _foreign_key_violations(conn)
    if fk_violations:
        issues.append(f"Foreign key check failed: {fk_violations} violation(s)")

    missing_columns = _missing_required_columns(conn)
    if missing_columns:
        issues.append("Missing required columns: " + ", ".join(missing_columns))

    return issues


def validate_db_path(db_path: Path, *, required: Iterable[str] = REQUIRED_TABLES) -> dict[str, object]:
    db_path = Path(db_path)
    if not db_path.exists():
        return {
            "status": "missing_db",
            "missing_tables": sorted({name for name in required if name}),
        }
    conn: sqlite3.Connection | None = None
    try:
        uri_path = db_path.as_posix()
        conn = sqlite3.connect(f"file:{uri_path}?mode=ro", uri=True)
        missing = missing_tables(conn, required=required)
        if missing:
            return {"status": "missing_tables", "missing_tables": missing}
        return {"status": "ok", "missing_tables": []}
    except Exception as exc:  # pragma: no cover - filesystem dependent
        return {"status": "error", "error": type(exc).__name__}
    finally:
        if conn is not None:
            conn.close()


def acquire_startup_migration_lock(
    data_dir: Path,
    *,
    logger=None,
    retries: int = LOCK_RETRIES,
    delay_seconds: float = LOCK_RETRY_DELAY_SECONDS,
) -> Path:
    attempts = max(1, int(retries))
    for attempt in range(attempts):
        try:
            return acquire_lock(data_dir, holder="startup")
        except MigrationLockError as exc:
            if attempt >= attempts - 1:
                message = "Another instance is upgrading data; please wait and retry."
                if logger is not None:
                    logger.error(message)
                raise DatabaseMigrationLockError(message) from exc
            if logger is not None:
                logger.info("Startup migration lock held; retrying.")
            time.sleep(max(0.0, delay_seconds))
    raise DatabaseMigrationLockError("Unable to acquire startup migration lock.")


def ensure_db_ready(
    data_dir: Path,
    config: Mapping[str, object],
    *,
    logger=None,
) -> None:
    lock_path = acquire_startup_migration_lock(Path(data_dir), logger=logger)
    missing: list[str] = []
    issues: list[str] = []
    conn: sqlite3.Connection | None = None
    try:
        settings = load_db_settings_from_config(Path(data_dir), config)
        conn = open_connection(settings)
        apply_migrations(conn)
        missing = validate_db_connection(conn)
        if not missing:
            issues = validate_db_invariants(conn)
    finally:
        if conn is not None:
            conn.close()
        release_lock(lock_path)
    if missing:
        message = f"Database validation failed; missing tables: {', '.join(missing)}."
        if logger is not None:
            logger.error(message)
        raise DatabaseValidationError(missing, message)
    if issues:
        message = "Database invariant validation failed; " + "; ".join(issues)
        if logger is not None:
            logger.error(message)
        raise DatabaseInvariantError(issues, message)


def db_path_for_data_dir(data_dir: Path) -> Path:
    return resolve_db_path(Path(data_dir))


__all__ = [
    "DatabaseInvariantError",
    "DatabaseMigrationLockError",
    "DatabaseValidationError",
    "REQUIRED_TABLES",
    "acquire_startup_migration_lock",
    "db_path_for_data_dir",
    "ensure_db_ready",
    "missing_tables",
    "validate_db_invariants",
    "validate_db_connection",
    "validate_db_path",
]
