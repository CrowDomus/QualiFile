from __future__ import annotations

from flask import Response

from . import page_bp


@page_bp.route("/.well-known/appspecific/com.chrome.devtools.json")
def _devtools_probe() -> Response:
    """Gracefully respond to Chrome DevTools discovery pings."""

    return Response(status=204)
