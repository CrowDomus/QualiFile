"""Root table helpers for SQLite persistence."""

from __future__ import annotations

import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from uuid import uuid4

from .root_marker import ensure_root_marker, read_root_marker

def get_root_id(conn: sqlite3.Connection, root_path: Optional[str]) -> Optional[str]:
    if not root_path:
        return None
    marker_id = _marker_id_for_path(root_path)
    if marker_id:
        reconciled = _reconcile_marker_root(conn, str(root_path), marker_id)
        if reconciled:
            return reconciled
    row = conn.execute(
        "SELECT root_id FROM roots WHERE root_path = ?",
        (root_path,),
    ).fetchone()
    if row:
        return str(row[0])
    return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _marker_id_for_path(root_path: str) -> Optional[str]:
    try:
        return read_root_marker(Path(root_path))
    except Exception:
        return None


def _update_root_path_refs(conn: sqlite3.Connection, root_id: str, old_path: str, new_path: str) -> None:
    if not old_path or old_path == new_path:
        return
    conn.execute(
        "UPDATE projects SET root_path = ? WHERE root_id = ? AND root_path = ?",
        (new_path, root_id, old_path),
    )
    conn.execute(
        "UPDATE migration_journal SET root_path = ? WHERE root_id = ? AND root_path = ?",
        (new_path, root_id, old_path),
    )


def _reassign_root_id(conn: sqlite3.Connection, source_root_id: str, target_root_id: str) -> None:
    if source_root_id == target_root_id:
        return
    # Derived index rows can collide on (root_id, path); drop target rows before reassignment.
    for table in ("file_index", "tag_index", "entry_index"):
        conn.execute(f"DELETE FROM {table} WHERE root_id = ?", (target_root_id,))
    for table in (
        "projects",
        "entries",
        "tag_definitions",
        "migration_journal",
        "file_index",
        "tag_index",
        "entry_index",
    ):
        conn.execute(
            f"UPDATE {table} SET root_id = ? WHERE root_id = ?",
            (target_root_id, source_root_id),
        )


def _reconcile_marker_root(conn: sqlite3.Connection, root_path: str, marker_id: str) -> Optional[str]:
    row = conn.execute(
        "SELECT root_path FROM roots WHERE root_id = ?",
        (marker_id,),
    ).fetchone()
    if not row:
        return None
    stored_path = row[0]
    if stored_path == root_path:
        with conn:
            conn.execute(
                "UPDATE roots SET updated_at = ? WHERE root_id = ?",
                (_now(), marker_id),
            )
        return marker_id
    with conn:
        duplicate_row = conn.execute(
            "SELECT root_id FROM roots WHERE root_path = ?",
            (root_path,),
        ).fetchone()
        duplicate_id = str(duplicate_row[0]) if duplicate_row else None
        if duplicate_id and duplicate_id != marker_id:
            _reassign_root_id(conn, duplicate_id, marker_id)
            conn.execute("DELETE FROM roots WHERE root_id = ?", (duplicate_id,))
        conn.execute(
            "UPDATE roots SET root_path = ?, updated_at = ? WHERE root_id = ?",
            (root_path, _now(), marker_id),
        )
        if isinstance(stored_path, str):
            _update_root_path_refs(conn, marker_id, stored_path, root_path)
    return marker_id


def _try_write_marker(root_path: str, root_id: str) -> None:
    try:
        path = Path(root_path)
    except Exception:
        return
    if not path.exists() or not path.is_dir():
        return
    try:
        ensure_root_marker(path, root_id)
    except Exception as exc:
        logging.getLogger(__name__).warning(
            "Unable to write root marker for %s: %s",
            root_path,
            exc,
        )


def ensure_root(conn: sqlite3.Connection, root_path: Optional[str]) -> Optional[str]:
    if not root_path:
        return None
    root_id = get_root_id(conn, root_path)
    if root_id:
        conn.execute(
            "UPDATE roots SET updated_at = ? WHERE root_id = ?",
            (_now(), root_id),
        )
        _try_write_marker(root_path, str(root_id))
        return str(root_id)
    root_id = f"root-{uuid4().hex[:12]}"
    now = _now()
    conn.execute(
        "INSERT INTO roots (root_id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (root_id, root_path, now, now),
    )
    _try_write_marker(root_path, root_id)
    return root_id


__all__ = ["ensure_root", "get_root_id"]
