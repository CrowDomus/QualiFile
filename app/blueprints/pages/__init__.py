"""Page blueprint route modules."""

from __future__ import annotations

from flask import Blueprint

page_bp = Blueprint("pages", __name__)

# Import page route modules to register handlers on the shared blueprint.
from . import home_routes as _home_routes  # noqa: E402,F401
from . import projects_routes as _projects_routes  # noqa: E402,F401
from . import alerts_routes as _alerts_routes  # noqa: E402,F401
from . import sync_manager_routes as _sync_manager_routes  # noqa: E402,F401
from . import root_select_routes as _root_select_routes  # noqa: E402,F401
from . import tutorial_routes as _tutorial_routes  # noqa: E402,F401

__all__ = ["page_bp"]
