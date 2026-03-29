"""Alert-state transition rules for task reminders."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone, tzinfo
from typing import Literal

from .rules import (
    REMINDER_MODE_ON_END_DATE,
    ReminderConfig,
    build_reminder_config,
    compute_reminder_moment_utc,
)
from .store import TaskAlertState

TransitionAction = Literal["activate", "clear", "keep", "noop"]


@dataclass(frozen=True)
class TaskReminderSnapshot:
    task_id: str
    status: str
    reminder: ReminderConfig


@dataclass(frozen=True)
class TransitionDecision:
    action: TransitionAction
    reason: str
    active_started_at: str | None = None


def _normalize_status(value: object) -> str:
    if value is None:
        return "none"
    return str(value).strip().lower() or "none"


def build_snapshot(task_id: str, payload: dict) -> TaskReminderSnapshot:
    return TaskReminderSnapshot(
        task_id=task_id,
        status=_normalize_status(payload.get("status")),
        reminder=build_reminder_config(payload),
    )


def has_active_alert(state: TaskAlertState | None) -> bool:
    return bool(state and state.active_started_at and not state.cleared_at)


def _to_iso_utc(now_utc: datetime) -> str:
    if now_utc.tzinfo is None:
        return now_utc.replace(tzinfo=timezone.utc).isoformat()
    return now_utc.astimezone(timezone.utc).isoformat()


def decide_transition(
    snapshot: TaskReminderSnapshot,
    state: TaskAlertState | None,
    *,
    now_utc: datetime,
    zone: tzinfo,
) -> TransitionDecision:
    if snapshot.status == "closed":
        if state:
            return TransitionDecision(action="clear", reason="task_closed")
        return TransitionDecision(action="noop", reason="task_closed_no_state")

    if has_active_alert(state):
        return TransitionDecision(action="keep", reason="active_persists_until_closed")

    if not snapshot.reminder.enabled:
        if state:
            return TransitionDecision(action="clear", reason="reminder_disabled_pre_activation")
        return TransitionDecision(action="noop", reason="reminder_disabled_no_state")

    reminder_moment_utc = compute_reminder_moment_utc(
        snapshot.reminder.end_date,
        mode=snapshot.reminder.mode or REMINDER_MODE_ON_END_DATE,
        days_before=snapshot.reminder.days_before,
        zone=zone,
    )
    if reminder_moment_utc is None:
        if state:
            return TransitionDecision(action="clear", reason="invalid_reminder_config")
        return TransitionDecision(action="noop", reason="invalid_reminder_no_state")

    candidate_now = now_utc if now_utc.tzinfo is not None else now_utc.replace(tzinfo=timezone.utc)
    if candidate_now.astimezone(timezone.utc) >= reminder_moment_utc:
        active_started_at = state.active_started_at if state and state.active_started_at else _to_iso_utc(now_utc)
        return TransitionDecision(
            action="activate",
            reason="reminder_due",
            active_started_at=active_started_at,
        )

    if state:
        return TransitionDecision(action="clear", reason="not_due_and_not_active")
    return TransitionDecision(action="noop", reason="not_due_no_state")


__all__ = [
    "TaskReminderSnapshot",
    "TransitionDecision",
    "build_snapshot",
    "decide_transition",
    "has_active_alert",
]
