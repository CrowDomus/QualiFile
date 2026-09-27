"""Application-origin request boundary for the loopback-only web server."""

from __future__ import annotations

from dataclasses import dataclass
import ipaddress
from typing import Any
from urllib.parse import SplitResult, urlsplit

from flask import Response, current_app, jsonify, make_response, request


_LOOPBACK_NAMES = frozenset({"localhost", "127.0.0.1", "::1"})
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
_SUPPORTED_SCHEMES = frozenset({"http", "https"})


@dataclass(frozen=True)
class Authority:
    host: str
    port: int


def _default_port(scheme: str) -> int | None:
    return {"http": 80, "https": 443}.get(scheme)


def _canonical_loopback_host(hostname: str) -> str | None:
    if not hostname or hostname.endswith("."):
        return None
    lowered = hostname.casefold()
    if lowered == "localhost":
        return lowered
    try:
        address = ipaddress.ip_address(lowered)
    except ValueError:
        return None
    canonical = str(address)
    return canonical if canonical in _LOOPBACK_NAMES else None


def _split_authority(raw: str, *, scheme: str) -> Authority | None:
    if (
        not raw
        or raw != raw.strip()
        or any(character.isspace() for character in raw)
        or "," in raw
        or "/" in raw
        or "\\" in raw
        or "#" in raw
        or "?" in raw
    ):
        return None
    try:
        parsed = urlsplit(f"//{raw}", allow_fragments=True)
        if (
            parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
        ):
            return None
        hostname = parsed.hostname
        port = parsed.port
    except (TypeError, ValueError):
        return None
    if not hostname:
        return None
    # RFC 3986 requires brackets around an IPv6 literal in an authority.
    if ":" in hostname and not raw.startswith("["):
        return None
    canonical = _canonical_loopback_host(hostname)
    if canonical is None:
        return None
    effective_port = port if port is not None else _default_port(scheme)
    if effective_port is None:
        return None
    return Authority(canonical, effective_port)


def configured_authorities(config: dict[str, Any]) -> frozenset[Authority]:
    """Return the exact loopback identities allowed by the server configuration."""

    try:
        port = int(config.get("SERVER_PORT"))
    except (TypeError, ValueError):
        return frozenset()
    if not 1 <= port <= 65535:
        return frozenset()
    return frozenset(Authority(host, port) for host in _LOOPBACK_NAMES)


def request_authority() -> Authority | None:
    raw_host = request.environ.get("HTTP_HOST", "")
    scheme = (request.environ.get("wsgi.url_scheme") or "").casefold()
    if scheme not in _SUPPORTED_SCHEMES:
        return None
    return _split_authority(str(raw_host), scheme=scheme)


def origin_authority(raw_origin: str) -> tuple[str, Authority] | None:
    if (
        not raw_origin
        or raw_origin != raw_origin.strip()
        or any(character.isspace() for character in raw_origin)
        or "," in raw_origin
    ):
        return None
    try:
        parsed: SplitResult = urlsplit(raw_origin, allow_fragments=True)
    except (TypeError, ValueError):
        return None
    scheme = parsed.scheme.casefold()
    if (
        scheme not in _SUPPORTED_SCHEMES
        or not parsed.netloc
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.username is not None
        or parsed.password is not None
    ):
        return None
    authority = _split_authority(parsed.netloc, scheme=scheme)
    return (scheme, authority) if authority is not None else None


def _boundary_error(status: int, code: str, message: str) -> Response:
    if request.path.startswith("/api/"):
        response = jsonify(
            {
                "ok": False,
                "code": code,
                "error": {"code": code, "message": message},
                "error_message": message,
            }
        )
        response.status_code = status
    else:
        response = make_response(message, status)
        response.mimetype = "text/plain"
    response.headers["Cache-Control"] = "no-store"
    return response


def enforce_trusted_authority() -> Response | None:
    """Reject untrusted or wrong-port authorities before any app capability runs."""

    try:
        peer = ipaddress.ip_address(request.remote_addr or "")
    except ValueError:
        peer = None
    if peer is None or not peer.is_loopback:
        return _boundary_error(403, "forbidden", "Remote requests are not allowed.")
    authority = request_authority()
    if authority is None or authority not in configured_authorities(current_app.config):
        return _boundary_error(400, "invalid-host", "Invalid request authority.")
    return None


def validate_request_origin() -> Response | None:
    """Validate browser origin/fetch metadata independently of CSRF."""

    fetch_site = request.headers.get("Sec-Fetch-Site", "").casefold()
    if fetch_site in {"cross-site", "same-site"}:
        return _boundary_error(403, "forbidden", "Cross-origin requests are not allowed.")

    raw_origin = request.headers.get("Origin")
    if raw_origin:
        parsed_origin = origin_authority(raw_origin)
        authority = request_authority()
        scheme = (request.environ.get("wsgi.url_scheme") or "").casefold()
        if parsed_origin is None or authority is None or parsed_origin != (scheme, authority):
            return _boundary_error(403, "forbidden", "Cross-origin requests are not allowed.")
    return None


def is_safe_method() -> bool:
    return request.method in _SAFE_METHODS
