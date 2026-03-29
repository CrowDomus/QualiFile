"""Schema registry models."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class SchemaRegistry:
    registry_version: int
    schemas: list[dict[str, Any]]

    @property
    def schemas_by_id(self) -> dict[str, dict[str, Any]]:
        return {schema.get("id", ""): schema for schema in self.schemas if isinstance(schema, dict)}

    def schema_ids(self) -> list[str]:
        return sorted(schema_id for schema_id in self.schemas_by_id.keys() if schema_id)
