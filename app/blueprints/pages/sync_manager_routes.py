from __future__ import annotations

from flask import Response, render_template

from . import page_bp


@page_bp.route("/sync-manager")
def sync_manager_page() -> Response:
    """Render the Git Sync Manager page."""

    return render_template("pages/sync_manager.html")
