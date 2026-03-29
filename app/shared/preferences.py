"""Profile preferences stored in the SQLite persistence layer."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Mapping, Optional

from .db import load_db_settings_from_config, open_connection
from .db_migrations import apply_migrations


def _open_preferences_db(data_dir: Path, config: Mapping[str, object]) -> sqlite3.Connection:
    settings = load_db_settings_from_config(data_dir, config)
    return open_connection(settings)


def get_preference(data_dir: Path, config: Mapping[str, object], key: str) -> Optional[str]:
    conn = _open_preferences_db(data_dir, config)
    try:
        apply_migrations(conn)
        row = conn.execute(
            "SELECT value FROM profile_preferences WHERE key = ?",
            (key,),
        ).fetchone()
        if not row:
            return None
        value = row[0]
        return str(value) if value is not None else None
    finally:
        conn.close()


def set_preference(data_dir: Path, config: Mapping[str, object], key: str, value: str | None) -> None:
    conn = _open_preferences_db(data_dir, config)
    try:
        apply_migrations(conn)
        with conn:
            conn.execute(
                """
                INSERT INTO profile_preferences (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (key, value),
            )
    finally:
        conn.close()


__all__ = ["get_preference", "set_preference"]
