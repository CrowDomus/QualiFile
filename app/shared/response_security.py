"""Response classification, CSP, and browser isolation headers."""

from __future__ import annotations

import secrets
import json

from flask import Response, current_app, g, request
from .redaction import redact_value


_DOCUMENT_CSP = (
    "default-src 'self'; "
    "base-uri 'none'; "
    "object-src 'none'; "
    "frame-ancestors 'none'; "
    "form-action 'self'; "
    "script-src 'self' 'nonce-{nonce}' https://cdn.jsdelivr.net; "
    "style-src-elem 'self' 'nonce-{nonce}' https://cdn.jsdelivr.net; "
    "style-src-attr 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "font-src 'self' data: https://cdn.jsdelivr.net; "
    "connect-src 'self' https://cdn.jsdelivr.net; "
    "frame-src 'self' blob: data:; "
    "worker-src 'self' blob:"
)
_INERT_CSP = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; sandbox"
_PDF_CSP = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; sandbox"


def new_csp_nonce() -> str:
    return secrets.token_urlsafe(24)


def _set_csp(response: Response, policy: str) -> None:
    header = (
        "Content-Security-Policy-Report-Only"
        if current_app.config.get("CSP_REPORT_ONLY", False)
        else "Content-Security-Policy"
    )
    response.headers[header] = policy


def secure_response(response: Response) -> Response:
    """Apply headers according to the trusted-document/user-content boundary."""

    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = (
        "accelerometer=(), camera=(), geolocation=(), gyroscope=(), "
        "magnetometer=(), microphone=(), payment=(), usb=()"
    )
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    if response.status_code >= 400 and response.is_json:
        payload = response.get_json(silent=True)
        if payload is not None:
            response.set_data(
                json.dumps(
                    redact_value(payload),
                    ensure_ascii=True,
                    separators=(",", ":"),
                )
            )
            response.mimetype = "application/json"

    endpoint = request.endpoint or ""
    path = request.path
    is_pdf = response.mimetype == "application/pdf"
    is_user_file = endpoint in {
        "api.api_file",
        "api.api_preview_artifact",
        "api.api_get_profile_avatar",
    }
    is_static = endpoint == "static" or path.startswith("/static/")
    is_tutorial_asset = endpoint == "pages.user_tutorial" and response.mimetype != "text/html"
    is_document = response.mimetype == "text/html" and not is_user_file

    if response.status_code >= 400:
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Cache-Control"] = "no-store"
        _set_csp(response, _INERT_CSP)
    elif is_user_file and is_pdf:
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Cache-Control"] = "no-store"
        _set_csp(response, _PDF_CSP)
    elif is_user_file:
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Cache-Control"] = "no-store"
        _set_csp(response, _INERT_CSP)
    elif is_document:
        nonce = getattr(g, "csp_nonce", None) or new_csp_nonce()
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cache-Control"] = "no-store"
        _set_csp(response, _DOCUMENT_CSP.format(nonce=nonce))
    elif is_static or is_tutorial_asset:
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Cache-Control"] = "no-cache"
        _set_csp(response, _INERT_CSP)
    else:
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Cache-Control"] = "no-store"
        _set_csp(response, _INERT_CSP)
    return response
