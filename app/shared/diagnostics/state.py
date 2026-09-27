"""Write a minimal diagnostics snapshot of the data state."""

from __future__ import annotations

import os
import platform
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from ..atomic_write import atomic_write_json
from ..db import resolve_db_path
from ..db_migrations import MIGRATIONS
from ..root_marker import SCHEMA_VERSION as ROOT_MARKER_SCHEMA_VERSION
from ..version import get_version
from ...features.metadata.sidecar import SCHEMA_VERSION as SIDECAR_SCHEMA_VERSION
from ...features.user_profile.contract import PROFILE_SCHEMA_VERSION

DATA_STATE_SCHEMA_VERSION = 2


def _get_app_version(config: Mapping[str, Any] | None, env: Mapping[str, str]) -> str:
    config_values = config or {}
    for key in ("QUALIFILE_VERSION", "APP_VERSION", "QUALIFILE_APP_VERSION"):
        value = env.get(key)
        if value:
            return str(value)
        config_value = config_values.get(key)
        if config_value:
            return str(config_value)
    return get_version()


def _db_schema_state(data_dir: Path) -> dict[str, object]:
    db_path = resolve_db_path(data_dir)
    expected_ids = [migration.migration_id for migration in MIGRATIONS]
    latest_id = expected_ids[-1] if expected_ids else None
    state: dict[str, object] = {
        "path": f"<data-dir>/{db_path.name}",
        "status": "missing",
        "latest_id": latest_id,
        "expected_ids": expected_ids,
        "applied_ids": [],
        "pending_ids": expected_ids,
    }
    if not db_path.exists():
        return state

    state["status"] = "present"
    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(str(db_path))
        table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
        ).fetchone()
        if not table:
            state["status"] = "no_migrations_table"
            return state
        rows = conn.execute("SELECT id FROM schema_migrations ORDER BY applied_at").fetchall()
        applied_ids = [row[0] for row in rows if row and row[0]]
        state["applied_ids"] = applied_ids
        pending_ids = [migration_id for migration_id in expected_ids if migration_id not in set(applied_ids)]
        state["pending_ids"] = pending_ids
        if applied_ids:
            state["current_id"] = applied_ids[-1]
    except Exception as exc:  # pragma: no cover - depends on filesystem state
        state["status"] = "error"
        state["error"] = type(exc).__name__
    finally:
        if conn is not None:
            conn.close()
    return state


def collect_data_state(data_dir: Path, config: Mapping[str, Any] | None = None) -> dict[str, object]:
    env_values = os.environ
    data_dir = Path(data_dir)
    generated_at = datetime.now(timezone.utc).isoformat()
    payload: dict[str, object] = {
        "schema_version": DATA_STATE_SCHEMA_VERSION,
        "generated_at": generated_at,
        "data_dir": "<data-dir>",
        "app_version": _get_app_version(config, env_values),
        "platform": {
            "os": os.name,
            "platform": platform.platform(),
            "python": platform.python_version(),
        },
        "schema_versions": {
            "qualifile_db": _db_schema_state(data_dir),
            "sidecar_metadata": {"current_version": SIDECAR_SCHEMA_VERSION},
            "root_marker": {"current_version": ROOT_MARKER_SCHEMA_VERSION},
            "user_profile": {"current_version": PROFILE_SCHEMA_VERSION},
        },
    }
    return payload


def write_data_state(data_dir: Path, config: Mapping[str, Any] | None = None) -> Path:
    target = Path(data_dir) / "diagnostics" / "data_state.json"
    payload = collect_data_state(data_dir, config)
    atomic_write_json(target, payload, indent=2, sort_keys=True)
    return target


__all__ = ["collect_data_state", "write_data_state", "DATA_STATE_SCHEMA_VERSION"]
