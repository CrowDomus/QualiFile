"""SQLite-backed read helpers for project entries."""

from __future__ import annotations

import json
import sqlite3
from typing import Optional

from .entries_store import ProjectEntryStore


def _task_with_defaults(payload: dict) -> dict:
    cleaned = dict(payload)
    if "auto_rollup_dates" not in cleaned:
        cleaned["auto_rollup_dates"] = False
    if "parent_project_id" not in cleaned:
        cleaned["parent_project_id"] = None
    if "parent_task_id" not in cleaned:
        cleaned["parent_task_id"] = None
    if "reminder_enabled" not in cleaned:
        cleaned["reminder_enabled"] = False
    if "reminder_mode" not in cleaned:
        cleaned["reminder_mode"] = "on_end_date"
    if "reminder_days_before" not in cleaned:
        cleaned["reminder_days_before"] = None
    return cleaned


class ProjectEntryDBStore:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def _load_entries(self, project_id: str, kind: Optional[str]) -> dict:
        if kind:
            normalized = ProjectEntryStore.normalize_kind(kind)
            rows = self._conn.execute(
                """
                SELECT entry_id, kind, payload_json, created_at, updated_at
                FROM entries
                WHERE project_id = ? AND kind = ?
                ORDER BY rowid ASC
                """,
                (project_id, normalized),
            ).fetchall()
        else:
            rows = self._conn.execute(
                """
                SELECT entry_id, kind, payload_json, created_at, updated_at
                FROM entries
                WHERE project_id = ?
                ORDER BY rowid ASC
                """,
                (project_id,),
            ).fetchall()
        buckets: dict[str, list] = {"note": [], "task": []}
        for entry_id, entry_kind, payload_json, created_at, updated_at in rows:
            payload = {}
            if payload_json:
                try:
                    payload = json.loads(payload_json)
                except Exception:
                    payload = {}
            payload.setdefault("id", entry_id)
            payload.setdefault("created_at", created_at)
            payload.setdefault("updated_at", updated_at)
            if entry_kind == "task":
                payload = _task_with_defaults(payload)
            buckets.setdefault(entry_kind, []).append(payload)
        return buckets

    def list_entries(self, project_id: str, kind: Optional[str] = None) -> dict:
        buckets = self._load_entries(project_id, kind)
        if kind:
            normalized = ProjectEntryStore.normalize_kind(kind)
            if normalized == "task":
                return {"task": buckets.get("task", [])}
            return {normalized: buckets.get(normalized, [])}
        return {
            "note": buckets.get("note", []),
            "task": buckets.get("task", []),
        }

    def upsert_entry(self, project_id: str, kind: str, payload: dict, root_id: str | None = None) -> None:
        normalized = ProjectEntryStore.normalize_kind(kind)
        entry_id = payload.get("id")
        if not entry_id:
            raise ValueError("Entry id is required.")
        created_at = payload.get("created_at") or payload.get("created")
        updated_at = payload.get("updated_at") or payload.get("updated")
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO entries (
                    entry_id, project_id, root_id, kind, payload_json, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(entry_id) DO UPDATE SET
                    project_id = excluded.project_id,
                    root_id = excluded.root_id,
                    kind = excluded.kind,
                    payload_json = excluded.payload_json,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at
                """,
                (
                    str(entry_id),
                    project_id,
                    root_id,
                    normalized,
                    json.dumps(payload, ensure_ascii=False),
                    created_at,
                    updated_at,
                ),
            )

    def delete_entry(self, project_id: str, entry_id: str) -> None:
        with self._conn:
            self._conn.execute(
                "DELETE FROM entries WHERE entry_id = ? AND project_id = ?",
                (entry_id, project_id),
            )

    def clear_task_parent_links(self, project_id: str, task_id: str) -> None:
        rows = self._conn.execute(
            "SELECT entry_id, payload_json FROM entries WHERE kind = 'task'",
        ).fetchall()
        with self._conn:
            for entry_id, payload_json in rows:
                if not payload_json:
                    continue
                try:
                    payload = json.loads(payload_json)
                except Exception:
                    continue
                if (
                    payload.get("parent_project_id") == project_id
                    and payload.get("parent_task_id") == task_id
                ):
                    payload["parent_project_id"] = None
                    payload["parent_task_id"] = None
                    self._conn.execute(
                        "UPDATE entries SET payload_json = ? WHERE entry_id = ?",
                        (json.dumps(payload, ensure_ascii=False), entry_id),
                    )


__all__ = ["ProjectEntryDBStore"]
