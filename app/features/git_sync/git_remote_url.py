"""Remote URL validation and redaction policy for Git Sync."""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_SCP_RE = re.compile(r"^git@([A-Za-z0-9.-]+):(.+)$")
_WINDOWS_ABS_PATH_RE = re.compile(r"^[A-Za-z]:[\\/]")
_HELPER_PREFIX_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*::")
_SENSITIVE_QUERY_KEYS = {"token", "access_token", "password", "passwd", "pwd", "secret", "auth"}


class RemoteUrlValidationError(ValueError):
    """Raised when a remote URL violates the Git Sync allowlist."""

    def __init__(self, code: str, message: str, *, details: tuple[str, ...] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = tuple(details or ())


@dataclass(frozen=True)
class RemoteUrlValidationResult:
    raw_input: str
    normalized_url: str
    redacted_url: str
    kind: str
    has_embedded_credentials: bool


def _normalize_input(value: str) -> str:
    text = str(value).strip()
    if not text:
        raise RemoteUrlValidationError(
            "remote-url-empty",
            "Remote URL must be a non-empty string.",
        )
    return text


def _reject_local_path_candidate(url: str) -> None:
    if _WINDOWS_ABS_PATH_RE.match(url):
        raise RemoteUrlValidationError("remote-url-local-path-disallowed", "Local filesystem paths are not allowed.")
    if url.startswith(("\\\\", "//", "./", "../", ".\\", "..\\")):
        raise RemoteUrlValidationError("remote-url-local-path-disallowed", "Local filesystem paths are not allowed.")


def _reject_helper_scheme(url: str) -> None:
    lowered = url.lower()
    if _HELPER_PREFIX_RE.match(url) or lowered.startswith("git+ssh://"):
        raise RemoteUrlValidationError(
            "remote-url-helper-scheme-disallowed",
            "Remote helper schemes are not allowed.",
        )


def _redact_query(query: str) -> str:
    if not query:
        return ""
    redacted: list[tuple[str, str]] = []
    for key, value in parse_qsl(query, keep_blank_values=True):
        if key.lower() in _SENSITIVE_QUERY_KEYS:
            redacted.append((key, "***"))
        else:
            redacted.append((key, value))
    return urlencode(redacted, doseq=True)


def _validate_scp(url: str) -> RemoteUrlValidationResult:
    match = _SCP_RE.fullmatch(url)
    if not match:
        raise RemoteUrlValidationError(
            "remote-url-invalid-scp",
            "SCP-like remote must match 'git@<host>:<path>'.",
        )
    host = match.group(1)
    path = match.group(2).strip().replace("\\", "/")
    if not path:
        raise RemoteUrlValidationError(
            "remote-url-invalid-scp",
            "SCP-like remote path must be non-empty.",
        )
    if any(char.isspace() for char in path):
        raise RemoteUrlValidationError(
            "remote-url-invalid-scp",
            "SCP-like remote path must not contain whitespace.",
        )
    normalized = f"git@{host}:{path}"
    return RemoteUrlValidationResult(
        raw_input=url,
        normalized_url=normalized,
        redacted_url=normalized,
        kind="scp",
        has_embedded_credentials=False,
    )


def _normalize_host_port(parsed) -> str:
    host = (parsed.hostname or "").lower()
    if not host:
        raise RemoteUrlValidationError("remote-url-host-missing", "Remote URL host is required.")
    if parsed.port is None:
        return host
    return f"{host}:{parsed.port}"


def _validate_https_or_ssh(url: str) -> RemoteUrlValidationResult:
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme == "file":
        raise RemoteUrlValidationError("remote-url-file-scheme-disallowed", "`file://` is not allowed in v1.")
    if scheme not in {"https", "ssh"}:
        raise RemoteUrlValidationError(
            "remote-url-scheme-not-allowed",
            "Remote URL scheme is not allowlisted; use https://, ssh://, or git@host:path.",
        )
    if not parsed.netloc:
        raise RemoteUrlValidationError("remote-url-host-missing", "Remote URL host is required.")
    if not parsed.path:
        raise RemoteUrlValidationError("remote-url-path-missing", "Remote URL path is required.")

    host_port = _normalize_host_port(parsed)
    username = parsed.username or ""
    password = parsed.password
    has_credentials = bool(username or password)
    auth = ""
    if username:
        auth = username
        if password is not None:
            auth = f"{auth}:{password}"
        auth = f"{auth}@"

    normalized_netloc = f"{auth}{host_port}"
    normalized_url = urlunsplit((scheme, normalized_netloc, parsed.path, parsed.query, parsed.fragment))

    redacted_netloc = f"{'***@' if has_credentials else ''}{host_port}"
    redacted_query = _redact_query(parsed.query)
    redacted_url = urlunsplit((scheme, redacted_netloc, parsed.path, redacted_query, parsed.fragment))
    return RemoteUrlValidationResult(
        raw_input=url,
        normalized_url=normalized_url,
        redacted_url=redacted_url,
        kind=scheme,
        has_embedded_credentials=has_credentials,
    )


def validate_remote_url_policy(value: str) -> RemoteUrlValidationResult:
    """Validate and normalize a Git remote URL according to Git Sync policy."""

    url = _normalize_input(value)
    _reject_local_path_candidate(url)
    _reject_helper_scheme(url)

    if "://" not in url:
        if "@" in url and ":" in url:
            if url.startswith("git@"):
                return _validate_scp(url)
            raise RemoteUrlValidationError(
                "remote-url-invalid-scp",
                "SCP-like remote must match 'git@<host>:<path>'.",
            )
        raise RemoteUrlValidationError(
            "remote-url-format-invalid",
            "Remote URL must use https://, ssh://, or git@host:path format.",
        )

    parsed = urlsplit(url)
    return _validate_https_or_ssh(url)


def redact_remote_url(value: str) -> str:
    """Return a credential-safe remote URL string for UI/logging surfaces."""

    try:
        return validate_remote_url_policy(value).redacted_url
    except Exception:
        text = str(value).strip()
        return "***" if text else text


__all__ = [
    "RemoteUrlValidationError",
    "RemoteUrlValidationResult",
    "redact_remote_url",
    "validate_remote_url_policy",
]
