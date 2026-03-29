"""SPD event constants and stage identifiers."""

EVENT_PREFIX = "QUALIFILE_EVENT="
LEGACY_LISTENING_PREFIX = "QUALIFILE_LISTENING_URL="

EVENT_TYPES = {
    "stage",
    "info",
    "warn",
    "error",
    "ready",
    "heartbeat",
}

STAGES = (
    "LAUNCHER_INITIALIZING",
    "STARTING_BACKEND",
    "RESOLVING_DATA_DIR",
    "LOADING_CONFIG",
    "PREPARING_STORAGE",
    "STARTING_SERVER",
    "WAITING_READINESS",
    "READY",
)
