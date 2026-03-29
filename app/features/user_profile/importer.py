"""Import payload validation for local user profiles."""

from __future__ import annotations

from typing import Any, Mapping

from .contract import (
    ANNOTATE_TOOL_COLORS_FIELD,
    PROFILE_IDENTITY_KEYS,
    PROFILE_PAYLOAD_KEYS,
    PROFILE_SCHEMA_VERSION,
)
from .payloads import parse_profile_payload


def parse_import_payload(payload: Mapping[str, Any]) -> tuple[dict[str, Any], object]:
    """Validate and normalize a profile import payload."""

    if not isinstance(payload, Mapping):
        raise ValueError("Import payload must be a JSON object.")
    unknown_keys = set(payload.keys()) - set(PROFILE_PAYLOAD_KEYS)
    if unknown_keys:
        unknown = ", ".join(sorted(unknown_keys))
        raise ValueError(f"Unknown keys in payload: {unknown}.")

    if "schema_version" not in payload:
        raise ValueError("schema_version is required.")
    version = payload.get("schema_version")
    if not isinstance(version, int):
        raise ValueError("schema_version must be an integer.")
    if version != PROFILE_SCHEMA_VERSION:
        raise ValueError(f"Unsupported schema_version: {version}.")

    if "profile" not in payload:
        raise ValueError("profile is required.")
    profile_block = payload.get("profile")
    if not isinstance(profile_block, Mapping):
        raise ValueError("profile must be a JSON object.")
    unknown_profile_keys = set(profile_block.keys()) - set(PROFILE_IDENTITY_KEYS)
    if unknown_profile_keys:
        unknown = ", ".join(sorted(unknown_profile_keys))
        raise ValueError(f"Unknown keys in profile: {unknown}.")
    if "display_name" not in profile_block:
        raise ValueError("display_name is required.")

    if ANNOTATE_TOOL_COLORS_FIELD in payload and payload.get(ANNOTATE_TOOL_COLORS_FIELD) is not None:
        raise ValueError("annotate_tool_colors is not supported in v1.")

    profile_updates, portable = parse_profile_payload(payload, allow_partial=True)
    if not profile_updates:
        raise ValueError("profile is required.")
    return profile_updates, portable


__all__ = ["parse_import_payload"]
