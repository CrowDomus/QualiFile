"""API endpoints for task-alert views and actions."""

from __future__ import annotations

from flask import Response, current_app, jsonify, request

from ...features.task_alerts.actions import TaskAlertActionService
from ...features.task_alerts.view import TaskAlertHeaderService
from ...shared.db import get_db
from . import api_bp
from .helpers import _json_body

_DEFAULT_SUMMARY_LIMIT = 20
_PAGE_SUMMARY_LIMIT = 500
_MAX_SUMMARY_LIMIT = 500


def _task_alert_header_service() -> TaskAlertHeaderService:
    return TaskAlertHeaderService(get_db(current_app))


def _task_alert_action_service() -> TaskAlertActionService:
    return TaskAlertActionService(get_db(current_app))


def _summary_limit(*, default: int) -> int:
    limit = request.args.get("limit", default=default, type=int)
    if not isinstance(limit, int):
        limit = default
    return max(1, min(limit, _MAX_SUMMARY_LIMIT))


@api_bp.route("/alerts/summary", methods=["GET"])
def api_alerts_summary() -> Response:
    limit = _summary_limit(default=_DEFAULT_SUMMARY_LIMIT)
    summary = _task_alert_header_service().build_summary(limit=limit)
    return jsonify(summary.as_dict())


@api_bp.route("/alerts/acknowledge", methods=["POST"])
def api_alerts_acknowledge() -> Response:
    limit = _summary_limit(default=_DEFAULT_SUMMARY_LIMIT)
    service = _task_alert_header_service()
    acknowledged_at = service.acknowledge_open()
    summary = service.build_summary(limit=limit).as_dict()
    summary["acknowledged_at"] = acknowledged_at
    return jsonify(summary)


@api_bp.route("/alerts/<task_id>/dismiss", methods=["POST"])
def api_alerts_dismiss(task_id: str) -> Response:
    data = _json_body()
    if isinstance(data, Response):
        return data
    dismissed = bool(data.get("dismissed", True))
    try:
        _task_alert_action_service().set_dismissed(task_id, dismissed=dismissed)
    except KeyError:
        return jsonify({"error": "Alert is not active for this task.", "code": "not-found"}), 404
    limit = _summary_limit(default=_PAGE_SUMMARY_LIMIT)
    summary = _task_alert_header_service().build_summary(limit=limit).as_dict()
    summary["task_id"] = task_id
    summary["dismissed"] = dismissed
    return jsonify(summary)


@api_bp.route("/alerts/<task_id>/snooze", methods=["POST"])
def api_alerts_snooze(task_id: str) -> Response:
    data = _json_body()
    if isinstance(data, Response):
        return data
    preset = str(data.get("preset") or "").strip().lower()
    if not preset:
        return jsonify({"error": "Snooze preset is required.", "code": "invalid"}), 400
    try:
        snooze_until = _task_alert_action_service().set_snooze(task_id, preset=preset)
    except ValueError as exc:
        return jsonify({"error": str(exc), "code": "invalid"}), 400
    except KeyError:
        return jsonify({"error": "Alert is not active for this task.", "code": "not-found"}), 404
    limit = _summary_limit(default=_PAGE_SUMMARY_LIMIT)
    summary = _task_alert_header_service().build_summary(limit=limit).as_dict()
    summary["task_id"] = task_id
    summary["snooze_until"] = snooze_until
    return jsonify(summary)
