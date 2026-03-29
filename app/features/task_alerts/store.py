"""SQLite persistence helpers for task reminder alert state."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import sqlite3
from typing import Optional

ALERTS_LAST_OPENED_AT_KEY = "task_alerts_last_opened_at"


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class TaskAlertState:
    task_id: str
    active_started_at: Optional[str]
    snooze_until: Optional[str]
    dismissed: bool
    dismissed_at: Optional[str]
    cleared_at: Optional[str]
    created_at: str
    updated_at: str

    def as_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "active_started_at": self.active_started_at,
            "snooze_until": self.snooze_until,
            "dismissed": self.dismissed,
            "dismissed_at": self.dismissed_at,
            "cleared_at": self.cleared_at,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class TaskAlertStateStore:
    """Persistence adapter for task alert lifecycle state."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    @staticmethod
    def _row_to_state(row: tuple) -> TaskAlertState:
        (
            task_id,
            active_started_at,
            snooze_until,
            dismissed,
            dismissed_at,
            cleared_at,
            created_at,
            updated_at,
        ) = row
        return TaskAlertState(
            task_id=task_id,
            active_started_at=active_started_at,
            snooze_until=snooze_until,
            dismissed=bool(dismissed),
            dismissed_at=dismissed_at,
            cleared_at=cleared_at,
            created_at=created_at,
            updated_at=updated_at,
        )

    def get_task_state(self, task_id: str) -> TaskAlertState | None:
        row = self._conn.execute(
            """
            SELECT task_id, active_started_at, snooze_until, dismissed, dismissed_at, cleared_at, created_at, updated_at
            FROM task_alert_state
            WHERE task_id = ?
            """,
            (task_id,),
        ).fetchone()
        if not row:
            return None
        return self._row_to_state(row)

    def upsert_task_state(
        self,
        task_id: str,
        *,
        active_started_at: Optional[str] = None,
        snooze_until: Optional[str] = None,
        dismissed: bool = False,
        dismissed_at: Optional[str] = None,
        cleared_at: Optional[str] = None,
    ) -> TaskAlertState:
        timestamp = _now_utc()
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO task_alert_state (
                    task_id,
                    active_started_at,
                    snooze_until,
                    dismissed,
                    dismissed_at,
                    cleared_at,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(task_id) DO UPDATE SET
                    active_started_at = excluded.active_started_at,
                    snooze_until = excluded.snooze_until,
                    dismissed = excluded.dismissed,
                    dismissed_at = excluded.dismissed_at,
                    cleared_at = excluded.cleared_at,
                    updated_at = excluded.updated_at
                """,
                (
                    task_id,
                    active_started_at,
                    snooze_until,
                    1 if dismissed else 0,
                    dismissed_at,
                    cleared_at,
                    timestamp,
                    timestamp,
                ),
            )
        state = self.get_task_state(task_id)
        if not state:  # pragma: no cover - defensive
            raise RuntimeError(f"Expected task alert state for '{task_id}' after upsert.")
        return state

    def clear_task_state(self, task_id: str) -> None:
        with self._conn:
            self._conn.execute("DELETE FROM task_alert_state WHERE task_id = ?", (task_id,))

    def get_alerts_last_opened_at(self) -> str | None:
        row = self._conn.execute(
            "SELECT value FROM profile_preferences WHERE key = ?",
            (ALERTS_LAST_OPENED_AT_KEY,),
        ).fetchone()
        if not row:
            return None
        value = row[0]
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    def set_alerts_last_opened_at(self, timestamp: str | None) -> None:
        with self._conn:
            if timestamp is None:
                self._conn.execute(
                    "DELETE FROM profile_preferences WHERE key = ?",
                    (ALERTS_LAST_OPENED_AT_KEY,),
                )
                return
            self._conn.execute(
                """
                INSERT INTO profile_preferences (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value
                """,
                (ALERTS_LAST_OPENED_AT_KEY, timestamp),
            )


__all__ = ["ALERTS_LAST_OPENED_AT_KEY", "TaskAlertState", "TaskAlertStateStore"]
