"""Profile payload schema contract (v1)."""

PROFILE_SCHEMA_VERSION = 1

PROFILE_PAYLOAD_KEYS = (
    "schema_version",
    "profile",
    "portable_preferences",
    "annotate_tool_colors",
)

PROFILE_IDENTITY_KEYS = (
    "display_name",
    "email",
    "avatar",
)

PORTABLE_PREFERENCES_FIELD = "portable_preferences"
ANNOTATE_TOOL_COLORS_FIELD = "annotate_tool_colors"

__all__ = [
    "ANNOTATE_TOOL_COLORS_FIELD",
    "PORTABLE_PREFERENCES_FIELD",
    "PROFILE_IDENTITY_KEYS",
    "PROFILE_PAYLOAD_KEYS",
    "PROFILE_SCHEMA_VERSION",
]
