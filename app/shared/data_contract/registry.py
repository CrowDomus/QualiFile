"""Schema registry loader and validator."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .errors import RegistryValidationError
from .models import SchemaRegistry
from .yaml_loader import load_yaml


_REQUIRED_SCHEMA_FIELDS: dict[str, type] = {
    "id": str,
    "kind": str,
    "lifecycle": str,
    "current_version": int,
    "version_field": dict,
    "locations": list,
    "authoritative": bool,
    "rebuildable": bool,
    "privacy_class": str,
}

_VALID_VERSION_TYPES = {"schema_migrations_table", "json_field", "none"}


def default_registry_path() -> Path:
    return Path(__file__).resolve().parents[3] / "docs" / "data" / "02_SCHEMA_REGISTRY.yaml"


def load_registry(path: str | Path | None = None) -> SchemaRegistry:
    registry_path = Path(path) if path is not None else default_registry_path()
    if not registry_path.exists():
        raise RegistryValidationError(f"Registry file not found: {registry_path}")
    data = load_yaml(registry_path)
    return validate_registry(data, source=str(registry_path))


def validate_registry(payload: Any, *, source: str = "<registry>") -> SchemaRegistry:
    errors: list[str] = []
    if not isinstance(payload, dict):
        raise RegistryValidationError("Registry must be a mapping", errors=[source])

    registry_version = payload.get("registry_version")
    if not isinstance(registry_version, int):
        errors.append("registry_version must be an integer")

    schemas = payload.get("schemas")
    if not isinstance(schemas, list):
        errors.append("schemas must be a list")
        schemas = []

    seen_ids: set[str] = set()
    for index, schema in enumerate(schemas):
        if not isinstance(schema, dict):
            errors.append(f"schemas[{index}] must be a mapping")
            continue
        schema_id = schema.get("id")
        if not isinstance(schema_id, str) or not schema_id.strip():
            errors.append(f"schemas[{index}].id must be a non-empty string")
            continue
        if schema_id in seen_ids:
            errors.append(f"schemas[{index}].id '{schema_id}' is duplicated")
        seen_ids.add(schema_id)

        _validate_required_fields(schema, index, errors)
        _validate_version_field(schema, index, errors)
        _validate_locations(schema, index, errors)
        _validate_migrations(schema, index, errors)

    if errors:
        raise RegistryValidationError(f"Registry validation failed for {source}", errors=errors)

    return SchemaRegistry(registry_version=registry_version, schemas=list(schemas))


def _validate_required_fields(schema: dict[str, Any], index: int, errors: list[str]) -> None:
    for field, expected_type in _REQUIRED_SCHEMA_FIELDS.items():
        value = schema.get(field)
        if not isinstance(value, expected_type):
            errors.append(f"schemas[{index}].{field} must be {expected_type.__name__}")


def _validate_version_field(schema: dict[str, Any], index: int, errors: list[str]) -> None:
    version_field = schema.get("version_field")
    if not isinstance(version_field, dict):
        return
    field_type = version_field.get("type")
    if not isinstance(field_type, str):
        errors.append(f"schemas[{index}].version_field.type must be a string")
        return
    if field_type not in _VALID_VERSION_TYPES:
        errors.append(f"schemas[{index}].version_field.type '{field_type}' is not supported")
        return
    if field_type == "schema_migrations_table":
        for key in ("table", "id_column", "ordered_ids", "latest_id"):
            if key not in version_field:
                errors.append(f"schemas[{index}].version_field.{key} is required")
    elif field_type == "json_field":
        if "field" not in version_field:
            errors.append(f"schemas[{index}].version_field.field is required")


def _validate_locations(schema: dict[str, Any], index: int, errors: list[str]) -> None:
    locations = schema.get("locations")
    if not isinstance(locations, list):
        return
    for loc_index, location in enumerate(locations):
        if not isinstance(location, dict):
            errors.append(f"schemas[{index}].locations[{loc_index}] must be a mapping")
            continue
        scope = location.get("scope")
        pattern = location.get("pattern")
        if not isinstance(scope, str) or not scope.strip():
            errors.append(f"schemas[{index}].locations[{loc_index}].scope must be a string")
        if not isinstance(pattern, str) or not pattern.strip():
            errors.append(f"schemas[{index}].locations[{loc_index}].pattern must be a string")


def _validate_migrations(schema: dict[str, Any], index: int, errors: list[str]) -> None:
    migrations = schema.get("migrations")
    if migrations is None:
        return
    if not isinstance(migrations, list):
        errors.append(f"schemas[{index}].migrations must be a list")
        return
    for mig_index, migration in enumerate(migrations):
        if not isinstance(migration, dict):
            errors.append(f"schemas[{index}].migrations[{mig_index}] must be a mapping")
            continue
        migration_id = migration.get("id")
        if not isinstance(migration_id, str) or not migration_id.strip():
            errors.append(f"schemas[{index}].migrations[{mig_index}].id must be a string")


__all__ = ["SchemaRegistry", "default_registry_path", "load_registry", "validate_registry"]
