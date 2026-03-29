"""Task alert evaluation orchestration and scheduler hooks."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import threading

from flask import Flask

from ...shared.db import load_db_settings_from_config, open_connection
from .rules import local_timezone
from .store import TaskAlertStateStore
from .transitions import TransitionDecision, build_snapshot, decide_transition


_DEFAULT_EVAL_INTERVAL_SECONDS = 30
_DEFAULT_IDLE_INTERVAL_SECONDS = 300
_DEFAULT_ERROR_RETRY_SECONDS = 60
_SCHEDULER_LOCK = threading.Lock()


@dataclass(frozen=True)
class TaskAlertEvaluationSummary:
    has_candidates: bool
    scanned: int
    activated: int
    cleared: int


class TaskAlertService:
    """Service layer for alert evaluation and activation cadence."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        *,
        now_provider=None,
        timezone_provider=None,
    ) -> None:
        self._conn = conn
        self._store = TaskAlertStateStore(conn)
        self._now_provider = now_provider or (lambda: datetime.now(timezone.utc))
        self._timezone_provider = timezone_provider or local_timezone

    def _has_enabled_reminders(self) -> bool:
        try:
            row = self._conn.execute(
                """
                SELECT 1
                FROM entries
                WHERE kind = 'task'
                  AND json_extract(payload_json, '$.reminder_enabled') = 1
                LIMIT 1
                """
            ).fetchone()
            return bool(row)
        except sqlite3.OperationalError:
            row = self._conn.execute(
                """
                SELECT 1
                FROM entries
                WHERE kind = 'task'
                  AND payload_json LIKE '%"reminder_enabled": true%'
                LIMIT 1
                """
            ).fetchone()
            return bool(row)

    def has_pending_candidates(self) -> bool:
        state_row = self._conn.execute(
            """
            SELECT 1
            FROM task_alert_state
            WHERE active_started_at IS NOT NULL
            LIMIT 1
            """
        ).fetchone()
        if state_row:
            return True
        return self._has_enabled_reminders()

    def _candidate_rows(self) -> list[tuple[str, str]]:
        try:
            rows = self._conn.execute(
                """
                SELECT e.entry_id, e.payload_json
                FROM entries AS e
                LEFT JOIN task_alert_state AS s ON s.task_id = e.entry_id
                WHERE e.kind = 'task'
                  AND (
                    s.task_id IS NOT NULL
                    OR json_extract(e.payload_json, '$.reminder_enabled') = 1
                  )
                """
            ).fetchall()
            return [(str(row[0]), str(row[1] or "")) for row in rows]
        except sqlite3.OperationalError:
            rows = self._conn.execute(
                """
                SELECT e.entry_id, e.payload_json
                FROM entries AS e
                LEFT JOIN task_alert_state AS s ON s.task_id = e.entry_id
                WHERE e.kind = 'task'
                  AND (
                    s.task_id IS NOT NULL
                    OR e.payload_json LIKE '%"reminder_enabled": true%'
                  )
                """
            ).fetchall()
            return [(str(row[0]), str(row[1] or "")) for row in rows]

    @staticmethod
    def _parse_payload(payload_json: str) -> dict:
        if not payload_json:
            return {}
        try:
            raw = json.loads(payload_json)
        except Exception:
            return {}
        if isinstance(raw, dict):
            return raw
        return {}

    def _apply_decision(
        self,
        task_id: str,
        state,
        decision: TransitionDecision,
        *,
        activated_count: int,
        cleared_count: int,
    ) -> tuple[int, int]:
        if decision.action == "activate":
            if state:
                self._store.upsert_task_state(
                    task_id,
                    active_started_at=decision.active_started_at or state.active_started_at,
                    snooze_until=state.snooze_until,
                    dismissed=state.dismissed,
                    dismissed_at=state.dismissed_at,
                    cleared_at=None,
                )
            else:
                self._store.upsert_task_state(task_id, active_started_at=decision.active_started_at)
            return activated_count + 1, cleared_count
        if decision.action == "clear" and state:
            self._store.clear_task_state(task_id)
            return activated_count, cleared_count + 1
        return activated_count, cleared_count

    def evaluate_task(self, task_id: str) -> TransitionDecision:
        row = self._conn.execute(
            """
            SELECT payload_json
            FROM entries
            WHERE entry_id = ? AND kind = 'task'
            """,
            (task_id,),
        ).fetchone()
        state = self._store.get_task_state(task_id)
        if not row:
            if state:
                self._store.clear_task_state(task_id)
                return TransitionDecision(action="clear", reason="task_deleted")
            return TransitionDecision(action="noop", reason="task_missing_no_state")

        payload = self._parse_payload(str(row[0] or ""))
        snapshot = build_snapshot(task_id, payload)
        decision = decide_transition(
            snapshot,
            state,
            now_utc=self._now_provider(),
            zone=self._timezone_provider(),
        )
        self._apply_decision(task_id, state, decision, activated_count=0, cleared_count=0)
        return decision

    def evaluate_all_due_alerts(self) -> TaskAlertEvaluationSummary:
        if not self.has_pending_candidates():
            return TaskAlertEvaluationSummary(
                has_candidates=False,
                scanned=0,
                activated=0,
                cleared=0,
            )

        now_utc = self._now_provider()
        zone = self._timezone_provider()
        rows = self._candidate_rows()
        activated = 0
        cleared = 0
        for task_id, payload_json in rows:
            payload = self._parse_payload(payload_json)
            state = self._store.get_task_state(task_id)
            snapshot = build_snapshot(task_id, payload)
            decision = decide_transition(snapshot, state, now_utc=now_utc, zone=zone)
            activated, cleared = self._apply_decision(
                task_id,
                state,
                decision,
                activated_count=activated,
                cleared_count=cleared,
            )
        return TaskAlertEvaluationSummary(
            has_candidates=True,
            scanned=len(rows),
            activated=activated,
            cleared=cleared,
        )


def _open_service_connection(app: Flask) -> sqlite3.Connection:
    data_dir = Path(app.config["DATA_DIR"])
    settings = load_db_settings_from_config(data_dir, app.config)
    conn = open_connection(settings)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def evaluate_due_alerts_once(app: Flask) -> TaskAlertEvaluationSummary:
    conn = _open_service_connection(app)
    try:
        return TaskAlertService(conn).evaluate_all_due_alerts()
    finally:
        conn.close()


def run_startup_alert_evaluation(app: Flask) -> TaskAlertEvaluationSummary:
    summary = evaluate_due_alerts_once(app)
    app.logger.info(
        "Task alert startup evaluation: candidates=%s scanned=%s activated=%s cleared=%s",
        int(summary.has_candidates),
        summary.scanned,
        summary.activated,
        summary.cleared,
    )
    return summary


def _scheduler_state(app: Flask) -> dict:
    extensions = getattr(app, "extensions", None)
    if extensions is None:
        app.extensions = {}  # type: ignore[attr-defined]
        extensions = app.extensions
    return extensions.setdefault("task_alert_scheduler", {})


def notify_task_alert_scheduler(app: Flask) -> None:
    wake_event = _scheduler_state(app).get("wake_event")
    if isinstance(wake_event, threading.Event):
        wake_event.set()


def _scheduler_worker(
    app: Flask,
    *,
    stop_event: threading.Event,
    wake_event: threading.Event,
    active_interval: int,
    idle_interval: int,
    error_retry_interval: int,
) -> None:
    while not stop_event.is_set():
        try:
            summary = evaluate_due_alerts_once(app)
            sleep_for = active_interval if summary.has_candidates else idle_interval
        except Exception:
            app.logger.exception("Task alert scheduler tick failed.")
            sleep_for = error_retry_interval
        wake_event.wait(timeout=float(sleep_for))
        wake_event.clear()


def ensure_task_alert_scheduler(app: Flask) -> None:
    if not app.config.get("TASK_ALERT_SCHEDULER_ENABLED", True):
        return
    if app.testing and not app.config.get("TASK_ALERT_SCHEDULER_IN_TESTS", False):
        return

    state = _scheduler_state(app)
    with _SCHEDULER_LOCK:
        if state.get("started"):
            return
        stop_event = threading.Event()
        wake_event = threading.Event()
        active_interval = max(1, int(app.config.get("TASK_ALERT_EVAL_INTERVAL_SECONDS", _DEFAULT_EVAL_INTERVAL_SECONDS)))
        idle_interval = max(active_interval, int(app.config.get("TASK_ALERT_IDLE_INTERVAL_SECONDS", _DEFAULT_IDLE_INTERVAL_SECONDS)))
        error_retry_interval = max(
            active_interval,
            int(app.config.get("TASK_ALERT_ERROR_RETRY_SECONDS", _DEFAULT_ERROR_RETRY_SECONDS)),
        )
        worker = threading.Thread(
            target=_scheduler_worker,
            kwargs={
                "app": app,
                "stop_event": stop_event,
                "wake_event": wake_event,
                "active_interval": active_interval,
                "idle_interval": idle_interval,
                "error_retry_interval": error_retry_interval,
            },
            daemon=True,
            name="task-alert-scheduler",
        )
        worker.start()
        state.update(
            {
                "started": True,
                "thread": worker,
                "stop_event": stop_event,
                "wake_event": wake_event,
                "active_interval": active_interval,
                "idle_interval": idle_interval,
            }
        )


__all__ = [
    "TaskAlertEvaluationSummary",
    "TaskAlertService",
    "ensure_task_alert_scheduler",
    "evaluate_due_alerts_once",
    "notify_task_alert_scheduler",
    "run_startup_alert_evaluation",
]
