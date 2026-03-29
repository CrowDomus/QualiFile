"""PPS manifest validation and manifest-last export helpers."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .pps_fingerprint import compute_snapshot_fingerprint
from .pps_serializer import PPS_JSON_ENCODING, write_pps_json

MANIFEST_FILENAME = "manifest.json"
PROJECT_FILENAME = "project.json"
TAG_DEFINITIONS_DIRNAME = "tag_definitions"
ENTRIES_DIRNAME = "entries"
DEFAULT_PPS_SCHEMA_VERSION = 1
DEFAULT_FINGERPRINT_ALGO = "sha256"
DIRECTORY_KEEP_FILENAME = ".keep"
MANIFEST_REQUIRED_FIELDS = (
    "pps_schema_version",
    "root_id",
    "project_id",
    "created_at",
    "exported_at",
    "entity_counts",
    "snapshot_fingerprint",
    "fingerprint_algo",
    "app_min_version",
)


class ManifestValidationError(ValueError):
    """Validation error for PPS manifest payloads."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _non_empty_string(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ManifestValidationError("manifest-invalid-field", f"Manifest field '{field}' must be a string.")
    cleaned = value.strip()
    if not cleaned:
        raise ManifestValidationError("manifest-invalid-field", f"Manifest field '{field}' must not be empty.")
    return cleaned


def _validate_entity_counts(value: Any) -> dict[str, int]:
    if not isinstance(value, dict):
        raise ManifestValidationError("manifest-invalid-field", "Manifest field 'entity_counts' must be an object.")
    normalized: dict[str, int] = {}
    for raw_key, raw_count in value.items():
        key = _non_empty_string(raw_key, "entity_counts key")
        if not isinstance(raw_count, int) or isinstance(raw_count, bool) or raw_count < 0:
            raise ManifestValidationError(
                "manifest-invalid-field",
                f"Manifest field 'entity_counts.{key}' must be a non-negative integer.",
            )
        normalized[key] = raw_count
    return normalized


def _validate_warnings(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ManifestValidationError("manifest-invalid-field", "Manifest field 'warnings' must be a list of strings.")
    warnings: list[str] = []
    for index, item in enumerate(value):
        if not isinstance(item, str):
            raise ManifestValidationError(
                "manifest-invalid-field",
                f"Manifest field 'warnings[{index}]' must be a string.",
            )
        cleaned = item.strip()
        if cleaned:
            warnings.append(cleaned)
    return warnings


def build_manifest(
    *,
    root_id: str,
    project_id: str,
    entity_counts: Mapping[str, int],
    snapshot_fingerprint: str,
    app_min_version: str,
    fingerprint_algo: str = DEFAULT_FINGERPRINT_ALGO,
    pps_schema_version: int = DEFAULT_PPS_SCHEMA_VERSION,
    created_at: str | None = None,
    exported_at: str | None = None,
    warnings: Sequence[str] | None = None,
) -> dict[str, Any]:
    """Build and validate a manifest payload."""

    manifest: dict[str, Any] = {
        "pps_schema_version": pps_schema_version,
        "root_id": root_id,
        "project_id": project_id,
        "created_at": created_at or _utc_iso(),
        "exported_at": exported_at or _utc_iso(),
        "entity_counts": dict(entity_counts),
        "snapshot_fingerprint": snapshot_fingerprint,
        "fingerprint_algo": fingerprint_algo,
        "app_min_version": app_min_version,
    }
    if warnings is not None:
        manifest["warnings"] = list(warnings)
    return validate_manifest(manifest, supported_schema_version=pps_schema_version)


def validate_manifest(payload: Any, *, supported_schema_version: int = DEFAULT_PPS_SCHEMA_VERSION) -> dict[str, Any]:
    """Validate a manifest payload and return a normalized copy."""

    if not isinstance(payload, dict):
        raise ManifestValidationError("manifest-invalid-json", "Manifest payload must be a JSON object.")

    for field in MANIFEST_REQUIRED_FIELDS:
        if field not in payload:
            raise ManifestValidationError("manifest-missing-field", f"Manifest field '{field}' is required.")

    schema_version = payload.get("pps_schema_version")
    if not isinstance(schema_version, int) or isinstance(schema_version, bool) or schema_version < 1:
        raise ManifestValidationError(
            "manifest-invalid-field",
            "Manifest field 'pps_schema_version' must be a positive integer.",
        )
    if schema_version > supported_schema_version:
        raise ManifestValidationError(
            "manifest-schema-unsupported",
            f"Manifest schema version {schema_version} is newer than supported version {supported_schema_version}.",
        )

    normalized: dict[str, Any] = {
        "pps_schema_version": schema_version,
        "root_id": _non_empty_string(payload.get("root_id"), "root_id"),
        "project_id": _non_empty_string(payload.get("project_id"), "project_id"),
        "created_at": _non_empty_string(payload.get("created_at"), "created_at"),
        "exported_at": _non_empty_string(payload.get("exported_at"), "exported_at"),
        "entity_counts": _validate_entity_counts(payload.get("entity_counts")),
        "snapshot_fingerprint": _non_empty_string(payload.get("snapshot_fingerprint"), "snapshot_fingerprint"),
        "fingerprint_algo": _non_empty_string(payload.get("fingerprint_algo"), "fingerprint_algo"),
        "app_min_version": _non_empty_string(payload.get("app_min_version"), "app_min_version"),
    }

    if "warnings" in payload:
        normalized["warnings"] = _validate_warnings(payload.get("warnings"))

    return normalized


def load_manifest(snapshot_dir: Path | str, *, supported_schema_version: int = DEFAULT_PPS_SCHEMA_VERSION) -> dict[str, Any]:
    """Load and validate manifest.json from a PPS snapshot directory."""

    return load_manifest_with_integrity(
        snapshot_dir,
        supported_schema_version=supported_schema_version,
        verify_fingerprint=False,
    )


def load_manifest_with_integrity(
    snapshot_dir: Path | str,
    *,
    supported_schema_version: int = DEFAULT_PPS_SCHEMA_VERSION,
    verify_fingerprint: bool = False,
) -> dict[str, Any]:
    """Load manifest and optionally verify snapshot fingerprint integrity."""

    manifest_path = Path(snapshot_dir) / MANIFEST_FILENAME
    if not manifest_path.exists():
        raise ManifestValidationError("manifest-missing", "manifest.json is missing.")

    try:
        payload = json.loads(manifest_path.read_text(encoding=PPS_JSON_ENCODING))
    except Exception as exc:
        raise ManifestValidationError("manifest-invalid-json", "Manifest JSON is invalid.") from exc

    manifest = validate_manifest(payload, supported_schema_version=supported_schema_version)
    if verify_fingerprint:
        validate_manifest_fingerprint(snapshot_dir, manifest)
    return manifest


def validate_manifest_fingerprint(snapshot_dir: Path | str, manifest: Mapping[str, Any]) -> str:
    """Validate that current snapshot contents match manifest fingerprint."""

    expected = _non_empty_string(manifest.get("snapshot_fingerprint"), "snapshot_fingerprint")
    actual = compute_snapshot_fingerprint(snapshot_dir)
    if actual != expected:
        raise ManifestValidationError(
            "manifest-fingerprint-mismatch",
            "Manifest fingerprint mismatch; snapshot is incomplete or corrupt.",
        )
    return actual


def _normalize_entities(items: Sequence[Mapping[str, Any]] | None, *, label: str) -> list[Mapping[str, Any]]:
    if items is None:
        return []
    normalized: list[Mapping[str, Any]] = []
    for index, item in enumerate(items):
        if not isinstance(item, Mapping):
            raise ValueError(f"{label}[{index}] must be an object.")
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id.strip():
            raise ValueError(f"{label}[{index}] is missing a valid 'id'.")
        normalized.append(item)
    return sorted(normalized, key=lambda value: str(value["id"]))


def export_pps_snapshot(
    snapshot_dir: Path | str,
    *,
    root_id: str,
    project_id: str,
    project: Mapping[str, Any],
    snapshot_fingerprint: str | None = None,
    app_min_version: str,
    tag_definitions: Sequence[Mapping[str, Any]] | None = None,
    entries: Sequence[Mapping[str, Any]] | None = None,
    fingerprint_algo: str = DEFAULT_FINGERPRINT_ALGO,
    created_at: str | None = None,
    exported_at: str | None = None,
    warnings: Sequence[str] | None = None,
    write_json: Callable[[Path | str, Any], None] = write_pps_json,
    on_write: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Export a PPS snapshot with guaranteed manifest-last ordering."""

    target = Path(snapshot_dir)
    tags = _normalize_entities(tag_definitions, label="tag_definitions")
    entry_items = _normalize_entities(entries, label="entries")

    tags_dir = target / TAG_DEFINITIONS_DIRNAME
    entries_dir = target / ENTRIES_DIRNAME
    tags_dir.mkdir(parents=True, exist_ok=True)
    entries_dir.mkdir(parents=True, exist_ok=True)

    # Keep files preserve required directories across Git clone/pull even when
    # a snapshot currently has zero tag or entry entities.
    for directory in (tags_dir, entries_dir):
        keep_file = directory / DIRECTORY_KEEP_FILENAME
        with keep_file.open("w", encoding=PPS_JSON_ENCODING, newline="\n") as handle:
            handle.write("qualifile-keep\n")

    def _write(path: Path, payload: Mapping[str, Any], relpath: str) -> None:
        write_json(path, payload)
        if on_write is not None:
            on_write(relpath)

    _write(target / PROJECT_FILENAME, project, PROJECT_FILENAME)
    for tag in tags:
        relpath = f"{TAG_DEFINITIONS_DIRNAME}/{tag['id']}.json"
        _write(target / relpath, tag, relpath)
    for entry in entry_items:
        relpath = f"{ENTRIES_DIRNAME}/{entry['id']}.json"
        _write(target / relpath, entry, relpath)

    resolved_fingerprint = snapshot_fingerprint or compute_snapshot_fingerprint(target)
    manifest = build_manifest(
        root_id=root_id,
        project_id=project_id,
        entity_counts={"tags": len(tags), "entries": len(entry_items)},
        snapshot_fingerprint=resolved_fingerprint,
        fingerprint_algo=fingerprint_algo,
        app_min_version=app_min_version,
        created_at=created_at,
        exported_at=exported_at,
        warnings=warnings,
    )
    _write(target / MANIFEST_FILENAME, manifest, MANIFEST_FILENAME)
    return manifest


__all__ = [
    "DEFAULT_FINGERPRINT_ALGO",
    "DEFAULT_PPS_SCHEMA_VERSION",
    "ENTRIES_DIRNAME",
    "MANIFEST_FILENAME",
    "MANIFEST_REQUIRED_FIELDS",
    "PROJECT_FILENAME",
    "TAG_DEFINITIONS_DIRNAME",
    "ManifestValidationError",
    "build_manifest",
    "export_pps_snapshot",
    "load_manifest",
    "load_manifest_with_integrity",
    "validate_manifest_fingerprint",
    "validate_manifest",
]
