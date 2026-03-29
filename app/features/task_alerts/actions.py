"""Mutation helpers for task-alert attention-state actions."""

from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
import json
import sqlite3
from typing import Callable

from .rules import (
    DEFAULT_REMINDER_HOUR_LOCAL,
    DEFAULT_REMINDER_MINUTE_LOCAL,
    REMINDER_MODE_ON_END_DATE,
    compute_reminder_moment_local,
    local_timezone,
)
from .store import TaskAlertState, TaskAlertStateStore

SNOOZE_PRESET_ONE_HOUR = "1h"
SNOOZE_PRESET_FOUR_HOURS = "4h"
SNOOZE_PRESET_TOMORROW_0800 = "tomorrow_0800"
SNOOZE_PRESET_CLEAR = "clear"
DISABLE_ACTIVE_ALERT_ACTION_KEEP = "disable_future_only"
DISABLE_ACTIVE_ALERT_ACTION_CLEAR = "disable_and_clear_active"
_VALID_DISABLE_ACTIVE_ALERT_ACTIONS = {
    DISABLE_ACTIVE_ALERT_ACTION_KEEP,
    DISABLE_ACTIVE_ALERT_ACTION_CLEAR,
}


def _parse_payload(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except Exception:
        return {}
    if isinstance(payload, dict):
        return payload
    return {}


def _normalize_status(value: object) -> str:
    if value is None:
        return "none"
    return str(value).strip().lower() or "none"


class TaskAlertActionService:
    """Apply user actions (dismiss/snooze) to active task alerts."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        *,
        now_provider: Callable[[], datetime] | None = None,
        timezone_provider=None,
    ) -> None:
        self._conn = conn
        self._store = TaskAlertStateStore(conn)
        self._now_provider = now_provider or (lambda: datetime.now(timezone.utc))
        self._timezone_provider = timezone_provider or local_timezone

    def _now_utc(self) -> datetime:
        now_utc = self._now_provider()
        if now_utc.tzinfo is None:
            return now_utc.replace(tzinfo=timezone.utc)
        return now_utc.astimezone(timezone.utc)

    def _require_active_state(self, task_id: str) -> TaskAlertState:
        row = self._conn.execute(
            """
            SELECT e.payload_json
            FROM task_alert_state AS s
            JOIN entries AS e ON e.entry_id = s.task_id
            WHERE s.task_id = ?
              AND e.kind = 'task'
              AND s.active_started_at IS NOT NULL
              AND s.cleared_at IS NULL
            """,
            (task_id,),
        ).fetchone()
        if not row:
            raise KeyError("Alert is not active for this task.")
        payload = _parse_payload(str(row[0] or ""))
        if _normalize_status(payload.get("status")) == "closed":
            self._store.clear_task_state(task_id)
            raise KeyError("Alert is not active for this task.")
        state = self._store.get_task_state(task_id)
        if not state or not state.active_started_at:
            raise KeyError("Alert is not active for this task.")
        return state

    def has_active_alert(self, task_id: str) -> bool:
        try:
            self._require_active_state(task_id)
        except KeyError:
            return False
        return True

    def set_dismissed(self, task_id: str, *, dismissed: bool) -> None:
        state = self._require_active_state(task_id)
        dismissed_at = self._now_utc().isoformat() if dismissed else None
        self._store.upsert_task_state(
            task_id,
            active_started_at=state.active_started_at,
            snooze_until=state.snooze_until,
            dismissed=dismissed,
            dismissed_at=dismissed_at,
            cleared_at=None,
        )

    def clear_active_alert(self, task_id: str) -> None:
        self._require_active_state(task_id)
        self._store.clear_task_state(task_id)

    def _resolve_snooze_until(self, preset: str) -> str | None:
        now_utc = self._now_utc()
        if preset == SNOOZE_PRESET_CLEAR:
            return None
        if preset == SNOOZE_PRESET_ONE_HOUR:
            return (now_utc + timedelta(hours=1)).isoformat()
        if preset == SNOOZE_PRESET_FOUR_HOURS:
            return (now_utc + timedelta(hours=4)).isoformat()
        if preset == SNOOZE_PRESET_TOMORROW_0800:
            zone = self._timezone_provider()
            local_now = now_utc.astimezone(zone)
            tomorrow = local_now.date() + timedelta(days=1)
            local_target = compute_reminder_moment_local(
                tomorrow.isoformat(),
                mode=REMINDER_MODE_ON_END_DATE,
                days_before=None,
                zone=zone,
            )
            if local_target is None:
                local_target = datetime.combine(
                    tomorrow,
                    time(DEFAULT_REMINDER_HOUR_LOCAL, DEFAULT_REMINDER_MINUTE_LOCAL),
                    tzinfo=zone,
                )
            return local_target.astimezone(timezone.utc).isoformat()
        raise ValueError("Unsupported snooze preset.")

    def set_snooze(self, task_id: str, *, preset: str) -> str | None:
        normalized = str(preset or "").strip().lower()
        snooze_until = self._resolve_snooze_until(normalized)
        state = self._require_active_state(task_id)
        self._store.upsert_task_state(
            task_id,
            active_started_at=state.active_started_at,
            snooze_until=snooze_until,
            dismissed=state.dismissed,
            dismissed_at=state.dismissed_at,
            cleared_at=None,
        )
        return snooze_until


def normalize_disable_active_alert_action(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    if text not in _VALID_DISABLE_ACTIVE_ALERT_ACTIONS:
        raise ValueError(
            "disable_active_alert_action must be 'disable_future_only' or "
            "'disable_and_clear_active'."
        )
    return text


__all__ = [
    "DISABLE_ACTIVE_ALERT_ACTION_CLEAR",
    "DISABLE_ACTIVE_ALERT_ACTION_KEEP",
    "SNOOZE_PRESET_CLEAR",
    "SNOOZE_PRESET_FOUR_HOURS",
    "SNOOZE_PRESET_ONE_HOUR",
    "SNOOZE_PRESET_TOMORROW_0800",
    "TaskAlertActionService",
    "normalize_disable_active_alert_action",
]
