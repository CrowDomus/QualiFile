"""Read model helpers for task-alert header and dropdown views."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
import json
import sqlite3
from typing import Any

from .store import TaskAlertStateStore

_DEFAULT_REMINDER_MODE = "on_end_date"
_DEFAULT_SUMMARY_LIMIT = 20
_MAX_SUMMARY_LIMIT = 500


def _parse_iso_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _parse_date(value: Any) -> date | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def _parse_payload(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except Exception:
        return {}
    if isinstance(payload, dict):
        return payload
    return {}


def _normalize_status(value: Any) -> str:
    if value is None:
        return "none"
    text = str(value).strip().lower()
    return text or "none"


@dataclass(frozen=True)
class TaskAlertHeaderItem:
    task_id: str
    project_id: str
    title: str
    end_date: str | None
    reminder_mode: str
    reminder_days_before: int | None
    active_started_at: str
    snooze_until: str | None
    dismissed: bool
    is_snoozed: bool
    is_new: bool
    state: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "project_id": self.project_id,
            "title": self.title,
            "end_date": self.end_date,
            "reminder_mode": self.reminder_mode,
            "reminder_days_before": self.reminder_days_before,
            "active_started_at": self.active_started_at,
            "snooze_until": self.snooze_until,
            "dismissed": self.dismissed,
            "is_snoozed": self.is_snoozed,
            "is_new": self.is_new,
            "state": self.state,
        }


@dataclass(frozen=True)
class TaskAlertHeaderSummary:
    icon_visible: bool
    badge_count: int
    new_count: int
    last_opened_at: str | None
    alerts: list[TaskAlertHeaderItem]

    def as_dict(self) -> dict[str, Any]:
        return {
            "icon_visible": self.icon_visible,
            "badge_count": self.badge_count,
            "new_count": self.new_count,
            "last_opened_at": self.last_opened_at,
            "alerts": [item.as_dict() for item in self.alerts],
        }


class TaskAlertHeaderService:
    """Compute header/dropdown alert view data."""

    def __init__(self, conn: sqlite3.Connection, *, now_provider=None) -> None:
        self._conn = conn
        self._store = TaskAlertStateStore(conn)
        self._now_provider = now_provider or (lambda: datetime.now(timezone.utc))

    def _query_active_rows(self) -> list[sqlite3.Row | tuple]:
        return self._conn.execute(
            """
            SELECT
                e.entry_id,
                e.project_id,
                e.payload_json,
                s.active_started_at,
                s.snooze_until,
                s.dismissed
            FROM task_alert_state AS s
            JOIN entries AS e ON e.entry_id = s.task_id
            WHERE e.kind = 'task'
              AND s.active_started_at IS NOT NULL
              AND s.cleared_at IS NULL
            """
        ).fetchall()

    @staticmethod
    def _resolve_state(*, is_new: bool, is_snoozed: bool, dismissed: bool) -> str:
        if is_snoozed:
            return "snoozed"
        if dismissed:
            return "dismissed"
        if is_new:
            return "new"
        return "active"

    @staticmethod
    def _sort_key(item: TaskAlertHeaderItem, *, today: date) -> tuple[int, int, datetime, str]:
        end_date = _parse_date(item.end_date)
        if end_date is None:
            urgency_rank = 2
            urgency_day = date.max.toordinal()
        elif end_date < today:
            urgency_rank = 0
            urgency_day = end_date.toordinal()
        else:
            urgency_rank = 1
            urgency_day = end_date.toordinal()
        active_started_at = _parse_iso_utc(item.active_started_at) or datetime.max.replace(tzinfo=timezone.utc)
        return (urgency_rank, urgency_day, active_started_at, item.title.lower())

    def _build_item(
        self,
        row: sqlite3.Row | tuple,
        *,
        now_utc: datetime,
        last_opened_at: datetime | None,
    ) -> TaskAlertHeaderItem | None:
        task_id = str(row[0])
        project_id = str(row[1] or "")
        payload = _parse_payload(str(row[2] or ""))
        status = _normalize_status(payload.get("status"))
        if status == "closed":
            return None

        active_started_at = str(row[3] or "").strip()
        if not active_started_at:
            return None
        active_started_dt = _parse_iso_utc(active_started_at)
        if active_started_dt is None:
            return None

        snooze_until = str(row[4] or "").strip() or None
        snooze_until_dt = _parse_iso_utc(snooze_until)
        is_snoozed = bool(snooze_until_dt and snooze_until_dt > now_utc)
        dismissed = bool(row[5])
        is_new = True if last_opened_at is None else active_started_dt > last_opened_at

        title = str(payload.get("title") or payload.get("text") or "(Untitled task)").strip() or "(Untitled task)"
        reminder_mode = str(payload.get("reminder_mode") or _DEFAULT_REMINDER_MODE).strip() or _DEFAULT_REMINDER_MODE
        reminder_days_before = payload.get("reminder_days_before")
        if not isinstance(reminder_days_before, int):
            reminder_days_before = None

        return TaskAlertHeaderItem(
            task_id=task_id,
            project_id=project_id,
            title=title,
            end_date=str(payload.get("end_date") or "").strip() or None,
            reminder_mode=reminder_mode,
            reminder_days_before=reminder_days_before,
            active_started_at=active_started_at,
            snooze_until=snooze_until,
            dismissed=dismissed,
            is_snoozed=is_snoozed,
            is_new=is_new,
            state=self._resolve_state(is_new=is_new, is_snoozed=is_snoozed, dismissed=dismissed),
        )

    def build_summary(self, *, limit: int = _DEFAULT_SUMMARY_LIMIT) -> TaskAlertHeaderSummary:
        requested_limit = max(1, min(int(limit), _MAX_SUMMARY_LIMIT))
        now_utc = self._now_provider()
        if now_utc.tzinfo is None:
            now_utc = now_utc.replace(tzinfo=timezone.utc)
        else:
            now_utc = now_utc.astimezone(timezone.utc)
        last_opened_raw = self._store.get_alerts_last_opened_at()
        last_opened_at = _parse_iso_utc(last_opened_raw)

        items: list[TaskAlertHeaderItem] = []
        for row in self._query_active_rows():
            item = self._build_item(row, now_utc=now_utc, last_opened_at=last_opened_at)
            if item is not None:
                items.append(item)
        today = now_utc.date()
        items.sort(key=lambda item: self._sort_key(item, today=today))

        badge_count = sum(1 for item in items if not item.dismissed and not item.is_snoozed)
        new_count = sum(1 for item in items if item.is_new)
        return TaskAlertHeaderSummary(
            icon_visible=bool(items),
            badge_count=badge_count,
            new_count=new_count,
            last_opened_at=last_opened_raw,
            alerts=items[:requested_limit],
        )

    def acknowledge_open(self) -> str:
        now_utc = self._now_provider()
        if now_utc.tzinfo is None:
            now_utc = now_utc.replace(tzinfo=timezone.utc)
        else:
            now_utc = now_utc.astimezone(timezone.utc)
        timestamp = now_utc.isoformat()
        self._store.set_alerts_last_opened_at(timestamp)
        return timestamp


__all__ = ["TaskAlertHeaderItem", "TaskAlertHeaderService", "TaskAlertHeaderSummary"]
