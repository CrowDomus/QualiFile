"""Helpers for parsing and shaping profile API payloads."""

from __future__ import annotations

from typing import Any, Mapping, Optional

from .allowlist import filter_portable_preferences
from .contract import ANNOTATE_TOOL_COLORS_FIELD, PORTABLE_PREFERENCES_FIELD, PROFILE_SCHEMA_VERSION

LOCAL_PROFILE_ID = "local"
_NO_CHANGE = object()


def _normalize_optional_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_required_text(value: Any, field: str) -> str:
    if value is None:
        raise ValueError(f"{field} is required.")
    text = str(value).strip()
    if not text:
        raise ValueError(f"{field} is required.")
    return text


def _parse_profile_block(profile: Mapping[str, Any], *, allow_partial: bool) -> dict[str, Any]:
    updates: dict[str, Any] = {}
    if "display_name" in profile:
        updates["display_name"] = _normalize_required_text(profile.get("display_name"), "display_name")
    elif not allow_partial:
        raise ValueError("display_name is required.")
    if "email" in profile:
        updates["email"] = _normalize_optional_text(profile.get("email"))
    if "avatar" in profile:
        updates["avatar_ref"] = _normalize_optional_text(profile.get("avatar"))
    return updates


def parse_profile_payload(payload: Mapping[str, Any], *, allow_partial: bool) -> tuple[dict[str, Any], object]:
    """Return (profile_updates, portable_preferences) from a JSON payload."""

    if not isinstance(payload, Mapping):
        raise ValueError("Request body must be a JSON object.")
    profile_updates: dict[str, Any] = {}
    if "profile" in payload:
        profile_block = payload.get("profile")
        if not isinstance(profile_block, Mapping):
            raise ValueError("profile must be a JSON object.")
        profile_updates = _parse_profile_block(profile_block, allow_partial=allow_partial)
    elif not allow_partial:
        raise ValueError("profile is required.")

    if "portable_preferences" in payload:
        raw_portable = payload.get("portable_preferences")
        if raw_portable is None:
            portable = None
        elif isinstance(raw_portable, Mapping):
            portable = filter_portable_preferences(raw_portable)
        else:
            raise ValueError("portable_preferences must be an object or null.")
    else:
        portable = _NO_CHANGE

    if allow_partial and not profile_updates and portable is _NO_CHANGE:
        raise ValueError("No changes provided.")

    return profile_updates, portable


def merge_profile_updates(current: Mapping[str, Any], updates: Mapping[str, Any]) -> dict[str, Any]:
    """Merge partial profile updates with the current profile."""

    display_name = updates.get("display_name")
    if display_name is None:
        display_name = current.get("display_name")
    display_name = _normalize_required_text(display_name, "display_name")
    email = updates.get("email", current.get("email"))
    avatar_ref = updates.get("avatar_ref", current.get("avatar_ref"))
    return {
        "display_name": display_name,
        "email": email,
        "avatar_ref": avatar_ref,
    }


def build_profile_response(profile: Mapping[str, Any] | None) -> dict[str, Any]:
    """Return the API response payload for a profile."""

    if not profile:
        return {"profile": None, "portable_preferences": {}}
    portable = profile.get("portable_preferences")
    portable_payload = filter_portable_preferences(portable) if isinstance(portable, Mapping) else {}
    return {
        "profile": {
            "id": profile.get("id"),
            "display_name": profile.get("display_name"),
            "email": profile.get("email"),
            "avatar": profile.get("avatar_ref"),
            "schema_version": profile.get("schema_version"),
            "created_at": profile.get("created_at"),
            "updated_at": profile.get("updated_at"),
        },
        "portable_preferences": portable_payload,
    }


def build_export_payload(profile: Mapping[str, Any]) -> dict[str, Any]:
    """Return an export-ready profile payload."""

    portable = profile.get("portable_preferences")
    portable_payload = filter_portable_preferences(portable) if isinstance(portable, Mapping) else {}
    return {
        "schema_version": PROFILE_SCHEMA_VERSION,
        "profile": {
            "display_name": profile.get("display_name"),
            "email": profile.get("email"),
            "avatar": profile.get("avatar_ref"),
        },
        PORTABLE_PREFERENCES_FIELD: portable_payload,
        ANNOTATE_TOOL_COLORS_FIELD: None,
    }


__all__ = [
    "LOCAL_PROFILE_ID",
    "build_export_payload",
    "build_profile_response",
    "merge_profile_updates",
    "parse_profile_payload",
    "NO_CHANGE",
]

NO_CHANGE = _NO_CHANGE
