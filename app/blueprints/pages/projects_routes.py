from __future__ import annotations

from flask import Response, render_template

from . import page_bp


@page_bp.route("/")
@page_bp.route("/projects")
def projects_home() -> Response:
    """Render the Projects dashboard."""

    return render_template("pages/projects.html")
