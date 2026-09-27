"""Werkzeug request handling that never persists raw request targets."""

from __future__ import annotations

from werkzeug.serving import WSGIRequestHandler


class PrivacyRequestHandler(WSGIRequestHandler):
    """Suppress request-line logs, including query strings and dynamic tokens."""

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        return None

    def log_error(self, format: str, *args: object) -> None:
        return None


__all__ = ["PrivacyRequestHandler"]
