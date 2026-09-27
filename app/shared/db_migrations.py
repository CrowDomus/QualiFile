"""Schema migration helpers for the SQLite storage layer."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import sqlite3
from typing import Iterable, Sequence


@dataclass(frozen=True)
class Migration:
    migration_id: str
    description: str
    sql: str


MIGRATIONS: Sequence[Migration] = (
    Migration(
        migration_id="0001_core_schema",
        description="core schema skeleton",
        sql="""
        CREATE TABLE IF NOT EXISTS roots (
            root_id TEXT PRIMARY KEY,
            root_path TEXT,
            created_at TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS projects (
            project_id TEXT PRIMARY KEY,
            root_id TEXT,
            name TEXT NOT NULL,
            description TEXT,
            parent_id TEXT,
            root_path TEXT,
            status TEXT,
            color TEXT,
            entry_mode TEXT,
            created_at TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS entries (
            entry_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            root_id TEXT,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS tag_definitions (
            tag_id TEXT PRIMARY KEY,
            root_id TEXT,
            name TEXT NOT NULL,
            color TEXT,
            show_header INTEGER,
            parent_id TEXT
        );

        CREATE TABLE IF NOT EXISTS profile_preferences (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        """,
    ),
    Migration(
        migration_id="0002_migration_journal",
        description="migration journal table",
        sql="""
        CREATE TABLE IF NOT EXISTS migration_journal (
            journal_id TEXT PRIMARY KEY,
            engine TEXT NOT NULL,
            root_id TEXT,
            root_path TEXT,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            details_json TEXT
        );
        """,
    ),
    Migration(
        migration_id="0003_index_schema",
        description="index cache tables",
        sql="""
        CREATE TABLE IF NOT EXISTS file_index (
            root_id TEXT NOT NULL,
            path TEXT NOT NULL,
            parent_path TEXT,
            name TEXT NOT NULL,
            is_dir INTEGER NOT NULL,
            size INTEGER,
            created_at TEXT,
            modified_at TEXT,
            extension TEXT,
            note_open_count INTEGER,
            note_closed_count INTEGER,
            note_has_overdue INTEGER,
            note_has_high_priority INTEGER,
            note_has_status INTEGER,
            note_children INTEGER,
            tag_count INTEGER,
            validated INTEGER,
            indexed_at TEXT,
            PRIMARY KEY (root_id, path)
        );

        CREATE INDEX IF NOT EXISTS file_index_parent
            ON file_index (root_id, parent_path);
        CREATE INDEX IF NOT EXISTS file_index_name
            ON file_index (root_id, name);

        CREATE TABLE IF NOT EXISTS tag_index (
            root_id TEXT NOT NULL,
            path TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            PRIMARY KEY (root_id, path, tag_id)
        );

        CREATE INDEX IF NOT EXISTS tag_index_tag
            ON tag_index (root_id, tag_id);

        CREATE TABLE IF NOT EXISTS entry_index (
            root_id TEXT NOT NULL,
            entry_id TEXT NOT NULL,
            path TEXT NOT NULL,
            kind TEXT NOT NULL,
            status TEXT,
            priority TEXT,
            deadline TEXT,
            created_at TEXT,
            updated_at TEXT,
            payload_json TEXT,
            PRIMARY KEY (root_id, entry_id)
        );

        CREATE INDEX IF NOT EXISTS entry_index_path
            ON entry_index (root_id, path);
        """,
    ),
    Migration(
        migration_id="0004_user_profiles",
        description="user profile tables",
        sql="""
        CREATE TABLE IF NOT EXISTS user_profiles (
            id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            email TEXT,
            avatar_ref TEXT,
            schema_version INTEGER,
            created_at TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS profile_portable_preferences (
            profile_id TEXT PRIMARY KEY,
            payload_json TEXT,
            updated_at TEXT,
            FOREIGN KEY (profile_id) REFERENCES user_profiles(id)
        );

        CREATE TABLE IF NOT EXISTS app_state (
            state_id TEXT PRIMARY KEY,
            active_profile_id TEXT,
            updated_at TEXT,
            FOREIGN KEY (active_profile_id) REFERENCES user_profiles(id)
        );

        INSERT OR IGNORE INTO app_state (state_id, active_profile_id, updated_at)
        VALUES ('global', NULL, NULL);
        """,
    ),
    Migration(
        migration_id="0005_task_alert_state",
        description="task reminder alert state table",
        sql="""
        CREATE TABLE IF NOT EXISTS task_alert_state (
            task_id TEXT PRIMARY KEY,
            active_started_at TEXT,
            snooze_until TEXT,
            dismissed INTEGER NOT NULL DEFAULT 0 CHECK (dismissed IN (0, 1)),
            dismissed_at TEXT,
            cleared_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (task_id) REFERENCES entries(entry_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS task_alert_state_active_started_idx
            ON task_alert_state (active_started_at);

        CREATE INDEX IF NOT EXISTS task_alert_state_snooze_until_idx
            ON task_alert_state (snooze_until);
        """,
    ),
    Migration(
        migration_id="0006_project_archive_state",
        description="project archive visibility state",
        sql="""
        ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));
        ALTER TABLE projects ADD COLUMN archived_at TEXT;
        """,
    ),
    Migration(
        migration_id="0007_image_history",
        description="editable annotations and focused image history",
        sql="""
        CREATE TABLE image_documents (
            file_id TEXT PRIMARY KEY,
            root_id TEXT NOT NULL,
            path TEXT NOT NULL,
            state_json TEXT NOT NULL,
            UNIQUE(root_id, path)
        );
        CREATE TABLE focused_settings (
            scope_id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 0,
            archive_path TEXT NOT NULL
        );
        CREATE TABLE image_versions (
            version_id TEXT PRIMARY KEY,
            file_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            reason TEXT NOT NULL,
            image_path TEXT NOT NULL,
            state_json TEXT NOT NULL
        );
        CREATE INDEX image_versions_file ON image_versions(file_id, created_at);
        CREATE TABLE image_pending_writes (
            file_id TEXT PRIMARY KEY,
            before_json TEXT NOT NULL,
            after_json TEXT NOT NULL
        );
        """,
    ),
)


def ensure_schema_migrations(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id TEXT PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at TEXT NOT NULL
        )
        """
    )


def _fetch_applied_migrations(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT id FROM schema_migrations").fetchall()
    return {row[0] for row in rows}


def list_pending_migrations(conn: sqlite3.Connection) -> list[Migration]:
    ensure_schema_migrations(conn)
    applied = _fetch_applied_migrations(conn)
    return [migration for migration in MIGRATIONS if migration.migration_id not in applied]


def apply_migrations(conn: sqlite3.Connection, *, dry_run: bool = False) -> list[str]:
    pending = list_pending_migrations(conn)
    if dry_run:
        return [migration.migration_id for migration in pending]

    applied_ids: list[str] = []
    if not pending:
        return applied_ids

    with conn:
        for migration in pending:
            conn.executescript(migration.sql)
            conn.execute(
                "INSERT INTO schema_migrations (id, description, applied_at) VALUES (?, ?, ?)",
                (
                    migration.migration_id,
                    migration.description,
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            applied_ids.append(migration.migration_id)
    return applied_ids


def describe_migrations(migrations: Iterable[Migration] | None = None) -> list[str]:
    items = migrations if migrations is not None else MIGRATIONS
    return [f"{migration.migration_id}: {migration.description}" for migration in items]


__all__ = [
    "Migration",
    "MIGRATIONS",
    "apply_migrations",
    "describe_migrations",
    "ensure_schema_migrations",
    "list_pending_migrations",
]
