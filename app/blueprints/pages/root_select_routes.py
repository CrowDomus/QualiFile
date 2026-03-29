from __future__ import annotations

from flask import Response, current_app, render_template

from . import page_bp


@page_bp.route("/workspace")
def workspace() -> Response:
    """Render the classic workspace or prompt to configure a root."""

    root = current_app.config.get("QUALIFILE_ROOT")
    if not root:
        return render_template("pages/root_select.html")
    return render_template("pages/index.html", root=str(root))
