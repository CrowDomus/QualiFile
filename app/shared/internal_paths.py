"""Canonical helpers for internal QualiFile paths that stay hidden by default."""

from __future__ import annotations

from pathlib import Path

from .root_marker import MARKER_FILENAME

INTERNAL_EXACT_NAMES = frozenset(
    {
        ".qualifile_tags.json",
        ".qualifile_notes.json",
        ".qualifile_meta.json",
        "qualifile.db",
        "qualifile.db-wal",
        "qualifile.db-shm",
        MARKER_FILENAME,
        ".qualifile_trash",
        ".qualifile_internal",
        ".git",
        ".qualifile_sync",
    }
)

INTERNAL_PREFIXES = (
    ".qualifile_meta.json",
    "qualifile.db",
    ".qualifile_sync.tmp-",
    ".qualifile_sync.bak-",
)


def is_internal_name(name: str) -> bool:
    """Return True when *name* belongs to internal metadata folders/files."""

    normalized = (name or "").strip().lower()
    if normalized in INTERNAL_EXACT_NAMES:
        return True
    return any(normalized.startswith(prefix) for prefix in INTERNAL_PREFIXES)


def is_internal_rel_path(path: str | Path) -> bool:
    """Return True when any segment in *path* is an internal name."""

    text = str(path or ".").replace("\\", "/").strip("/")
    if not text or text == ".":
        return False
    return any(is_internal_name(part) for part in text.split("/") if part and part != ".")


def is_internal_path(root: Path, candidate: Path) -> bool:
    """Return True when *candidate* points inside an internal path under *root*."""

    try:
        relative = candidate.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return is_internal_rel_path(relative)


__all__ = [
    "INTERNAL_EXACT_NAMES",
    "INTERNAL_PREFIXES",
    "is_internal_name",
    "is_internal_rel_path",
    "is_internal_path",
]
