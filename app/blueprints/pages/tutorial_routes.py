"""Routes for serving the bundled user tutorial."""

from __future__ import annotations

from flask import abort, send_from_directory

from app.shared.tutorial import resolve_tutorial_root

from . import page_bp


@page_bp.route("/user_tutorial/")
@page_bp.route("/user_tutorial/<path:filename>")
def user_tutorial(filename: str | None = None):
    root = resolve_tutorial_root()
    if root is None:
        abort(404)
    target = filename or "index.html"
    return send_from_directory(root, target)

