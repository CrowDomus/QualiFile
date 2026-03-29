"""Portable preference allowlist contract (v1)."""

from __future__ import annotations

from typing import Any, Mapping

PORTABLE_ALLOWLIST: Mapping[str, object] = {
    "theme": None,
    "categorizeFiles": None,
    "sidebarPinned": None,
    "sidebarCompactLocked": None,
    "viewMode": None,
    "sort": {
        "key": None,
        "direction": None,
    },
    "tagDisplayMode": None,
    "columns": {
        "name": None,
        "type": None,
        "size": None,
        "created": None,
        "modified": None,
    },
    "layout": {
        "tree": None,
        "list": None,
        "preview": None,
    },
    "designMode": None,
    "preview": {
        "showMetadata": None,
        "officeQuality": None,
    },
    "tags": {
        "hierarchyView": None,
    },
    "softDelete": None,
    "mergeDefaults": {
        "paperSize": None,
        "orientation": None,
        "margin": None,
        "fit": None,
        "phraseAlignment": None,
        "pageNumbers": None,
        "captionFontSizePt": None,
    },
}

DEFERRED_TOP_LEVEL_KEYS = {
    "projects",
    "screenshot",
}


def filter_portable_preferences(payload: Mapping[str, Any] | None) -> dict[str, Any]:
    """Return a filtered payload containing only allowlisted keys."""

    if not isinstance(payload, Mapping):
        return {}
    return _filter_mapping(payload, PORTABLE_ALLOWLIST)


def _filter_mapping(payload: Mapping[str, Any], allowlist: Mapping[str, object]) -> dict[str, Any]:
    filtered: dict[str, Any] = {}
    for key, allowed in allowlist.items():
        if key not in payload:
            continue
        value = payload[key]
        if value is None or allowed is None:
            filtered[key] = value
            continue
        if isinstance(allowed, Mapping):
            if isinstance(value, Mapping):
                filtered[key] = _filter_mapping(value, allowed)
            continue
        filtered[key] = value
    return filtered


__all__ = [
    "DEFERRED_TOP_LEVEL_KEYS",
    "PORTABLE_ALLOWLIST",
    "filter_portable_preferences",
]
