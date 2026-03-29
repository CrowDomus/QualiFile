"""Application version (single source of truth).

Semantic Versioning (SemVer):
- MAJOR.MINOR.PATCH (+ optional pre-release/build metadata).
- "Heavy modification" requires MINOR or MAJOR bump:
  * SQLite migration id increments.
  * docs/data schema registry latest changes.
  * sidecar schema version changes.
  * migration runner/lock/backup behavior changes.
- Otherwise, use PATCH for fixes and non-breaking improvements.
"""

from __future__ import annotations

import re
from typing import Tuple

__version__ = "0.27.16"

_SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$"
)


def get_version() -> str:
    return __version__


def parse_version(value: str | None = None) -> Tuple[int, int, int]:
    version = value or __version__
    match = _SEMVER_RE.match(version)
    if not match:
        raise ValueError(f"Invalid SemVer version: {version}")
    major, minor, patch = match.groups()
    return int(major), int(minor), int(patch)


__all__ = ["__version__", "get_version", "parse_version"]
