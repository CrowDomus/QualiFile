"""Helpers for resolving storage mode flags."""

from __future__ import annotations

from typing import Mapping

VALID_MODES = {"legacy", "dual", "new"}
ENGINE_KEYS = {
    "projects": "STORAGE_MODE_PROJECTS",
    "entries": "STORAGE_MODE_ENTRIES",
    "tags": "STORAGE_MODE_TAGS",
    "notes": "STORAGE_MODE_NOTES",
    "validation": "STORAGE_MODE_VALIDATION",
    "root_state": "STORAGE_MODE_ROOT_STATE",
}


def resolve_storage_mode(config: Mapping[str, object], engine: str) -> str:
    key = ENGINE_KEYS.get(engine)
    if key:
        override = config.get(key)
        if isinstance(override, str) and override in VALID_MODES:
            return override
    global_mode = config.get("STORAGE_MODE")
    if isinstance(global_mode, str) and global_mode in VALID_MODES:
        return global_mode
    return "legacy"


__all__ = ["resolve_storage_mode", "VALID_MODES"]
