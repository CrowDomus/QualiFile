from __future__ import annotations

import json
import logging
import traceback
from datetime import datetime
from typing import Any, MutableMapping

from flask import g, has_request_context, request


def _iso_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


class RequestContextFilter(logging.Filter):
    """Attach request metadata to log records when available."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.ts = getattr(record, "ts", _iso_now())
        record.request_id = getattr(record, "request_id", None) if has_request_context() else None
        record.method = record.path = record.endpoint = record.remote_addr = record.user_agent = None
        record.status_code = getattr(record, "status_code", None)
        if has_request_context():
            record.method = request.method
            record.path = request.path
            record.endpoint = request.endpoint
            record.remote_addr = request.remote_addr
            record.user_agent = request.headers.get("User-Agent")
        return True


class JSONFormatter(logging.Formatter):
    """Render log records as JSON lines with stable keys."""

    def format(self, record: logging.LogRecord) -> str:
        payload: MutableMapping[str, Any] = {
            "ts": getattr(record, "ts", _iso_now()),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": getattr(record, "request_id", None),
            "method": getattr(record, "method", None),
            "path": getattr(record, "path", None),
            "endpoint": getattr(record, "endpoint", None),
            "remote_addr": getattr(record, "remote_addr", None),
            "user_agent": getattr(record, "user_agent", None),
            "status_code": getattr(record, "status_code", None),
            "exception_type": None,
            "exception_message": None,
            "stacktrace": None,
        }
        if record.exc_info:
            exc_type = record.exc_info[0]
            payload["exception_type"] = exc_type.__name__ if exc_type else None
            payload["exception_message"] = str(record.exc_info[1]) if record.exc_info[1] else None
            payload["stacktrace"] = "".join(traceback.format_exception(*record.exc_info))
        return json.dumps(payload, ensure_ascii=True)


__all__ = ["JSONFormatter", "RequestContextFilter"]
