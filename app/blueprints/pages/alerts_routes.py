from __future__ import annotations

from flask import Response, render_template

from . import page_bp


@page_bp.route("/alerts")
def alerts_page() -> Response:
    """Render the dedicated task alerts page."""

    return render_template("pages/alerts.html")
