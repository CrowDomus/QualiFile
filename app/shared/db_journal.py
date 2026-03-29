"""Migration journal helpers for shadow data moves."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _serialize_details(details: Optional[dict[str, Any]]) -> str | None:
    if not details:
        return None
    try:
        return json.dumps(details, sort_keys=True)
    except Exception:
        return None


def start_journal_entry(
    conn: sqlite3.Connection,
    *,
    engine: str,
    root_id: Optional[str] = None,
    root_path: Optional[str] = None,
    details: Optional[dict[str, Any]] = None,
) -> str:
    journal_id = f"journal-{uuid4().hex[:12]}"
    conn.execute(
        """
        INSERT INTO migration_journal (
            journal_id, engine, root_id, root_path, status, started_at, details_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            journal_id,
            engine,
            root_id,
            root_path,
            "started",
            _now(),
            _serialize_details(details),
        ),
    )
    return journal_id


def complete_journal_entry(
    conn: sqlite3.Connection,
    *,
    journal_id: str,
    status: str = "complete",
    details: Optional[dict[str, Any]] = None,
) -> None:
    conn.execute(
        """
        UPDATE migration_journal
        SET status = ?, completed_at = ?, details_json = ?
        WHERE journal_id = ?
        """,
        (
            status,
            _now(),
            _serialize_details(details),
            journal_id,
        ),
    )


__all__ = ["start_journal_entry", "complete_journal_entry"]
