"""SQLite connection helpers for the data persistence migration."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional

from flask import Flask, g

INTERNAL_DIRNAME = ".qualifile_internal"
DB_FILENAME = "qualifile.db"
DEFAULT_BUSY_TIMEOUT_MS = 5000
DEFAULT_JOURNAL_MODE = "wal"


@dataclass(frozen=True)
class DBSettings:
    path: Path
    busy_timeout_ms: int
    journal_mode: str


def resolve_db_path(data_dir: Path) -> Path:
    return Path(data_dir) / INTERNAL_DIRNAME / DB_FILENAME


def _normalize_journal_mode(value: Optional[str]) -> str:
    normalized = (value or "").strip().lower()
    if normalized in {"wal", "delete"}:
        return normalized
    return DEFAULT_JOURNAL_MODE


def load_db_settings(app: Flask) -> DBSettings:
    data_dir = Path(app.config["DATA_DIR"])
    path = resolve_db_path(data_dir)
    busy_timeout_ms = int(app.config.get("DB_BUSY_TIMEOUT_MS", DEFAULT_BUSY_TIMEOUT_MS))
    journal_mode = _normalize_journal_mode(app.config.get("DB_JOURNAL_MODE", DEFAULT_JOURNAL_MODE))
    return DBSettings(path=path, busy_timeout_ms=busy_timeout_ms, journal_mode=journal_mode)


def load_db_settings_from_config(data_dir: Path, config: Mapping[str, object]) -> DBSettings:
    busy_timeout_ms = int(config.get("DB_BUSY_TIMEOUT_MS", DEFAULT_BUSY_TIMEOUT_MS))
    journal_mode = _normalize_journal_mode(config.get("DB_JOURNAL_MODE", DEFAULT_JOURNAL_MODE))
    return DBSettings(path=resolve_db_path(data_dir), busy_timeout_ms=busy_timeout_ms, journal_mode=journal_mode)


def open_connection(settings: DBSettings) -> sqlite3.Connection:
    settings.path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(settings.path))
    conn.execute(f"PRAGMA journal_mode = {settings.journal_mode}")
    conn.execute(f"PRAGMA busy_timeout = {settings.busy_timeout_ms}")
    return conn


def get_db(app: Flask) -> sqlite3.Connection:
    conn = getattr(g, "db", None)
    if conn is None:
        settings = load_db_settings(app)
        conn = open_connection(settings)
        g.db = conn
    return conn


def close_db(error: Exception | None = None) -> None:
    _ = error
    conn = getattr(g, "db", None)
    if conn is not None:
        conn.close()
        g.db = None


__all__ = [
    "DBSettings",
    "DEFAULT_BUSY_TIMEOUT_MS",
    "DEFAULT_JOURNAL_MODE",
    "DB_FILENAME",
    "INTERNAL_DIRNAME",
    "close_db",
    "get_db",
    "load_db_settings",
    "load_db_settings_from_config",
    "open_connection",
    "resolve_db_path",
]
