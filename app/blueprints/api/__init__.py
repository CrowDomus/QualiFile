from __future__ import annotations

import logging

from flask import Blueprint, Response
from werkzeug.exceptions import HTTPException

from .helpers import _error_response, _map_known_error, _validate_origin_and_csrf

api_bp = Blueprint("api", __name__)


@api_bp.before_request
def _api_before_request():
    """Apply CSRF/origin protections to mutating API calls."""

    check = _validate_origin_and_csrf()
    if check:
        return check


@api_bp.app_errorhandler(Exception)
def _handle_api_error(exc: Exception) -> Response:
    """Centralized API error handler with friendly responses and logging."""

    mapped = _map_known_error(exc)
    if mapped:
        status, code, message, log_level = mapped
        return _error_response(code, message, status, log_level=log_level)
    if isinstance(exc, HTTPException):
        status = exc.code or 500
        if status >= 500:
            return _error_response("server-error", "An unexpected error occurred. Please try again.", status, log_level=logging.ERROR, exc=exc)
        code = "invalid" if 400 <= status < 500 else "error"
        return _error_response(code, "Request cannot be processed.", status, log_level=logging.WARNING)
    return _error_response("server-error", "An unexpected error occurred. Please try again.", 500, log_level=logging.ERROR, exc=exc)


# Import API route modules to register handlers on the shared blueprint.
from . import filesystem_routes as _filesystem_routes  # noqa: E402,F401
from . import preview_routes as _preview_routes  # noqa: E402,F401
from . import image_history_routes as _image_history_routes  # noqa: E402,F401
from . import projects_routes as _projects_routes  # noqa: E402,F401
from . import project_browse_routes as _project_browse_routes  # noqa: E402,F401
from . import notes_routes as _notes_routes  # noqa: E402,F401
from . import linked_notes_routes as _linked_notes_routes  # noqa: E402,F401
from . import tags_routes as _tags_routes  # noqa: E402,F401
from . import validation_routes as _validation_routes  # noqa: E402,F401
from . import system_routes as _system_routes  # noqa: E402,F401
from . import profile_routes as _profile_routes  # noqa: E402,F401
from . import alerts_routes as _alerts_routes  # noqa: E402,F401
from . import git_sync_routes as _git_sync_routes  # noqa: E402,F401

__all__ = ["api_bp"]
