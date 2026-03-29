"""Version detection helpers for migration dry runs."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable

from ..data_contract.models import SchemaRegistry

_MAX_MATCHES = 500
_MAX_SAMPLE_PATHS = 5
_GLOB_CHARS = set("*?[")


def detect_schema_versions(
    registry: SchemaRegistry,
    data_dir: Path,
    *,
    workspace_root: Path | None = None,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for schema in registry.schemas:
        if not isinstance(schema, dict):
            continue
        results.append(_probe_schema(schema, data_dir, workspace_root))
    return results


def _probe_schema(schema: dict[str, Any], data_dir: Path, workspace_root: Path | None) -> dict[str, Any]:
    schema_id = schema.get("id") if isinstance(schema.get("id"), str) else ""
    version_field = schema.get("version_field") if isinstance(schema.get("version_field"), dict) else {}
    field_type = version_field.get("type") if isinstance(version_field.get("type"), str) else "none"

    result: dict[str, Any] = {
        "id": schema_id,
        "kind": schema.get("kind"),
        "lifecycle": schema.get("lifecycle"),
        "supported_version": schema.get("current_version"),
    }

    if field_type == "schema_migrations_table":
        result.update(_probe_sqlite(schema, data_dir, workspace_root))
    elif field_type == "json_field":
        result.update(_probe_json_field(schema, data_dir, workspace_root))
    else:
        result.update(_probe_unversioned(schema, data_dir, workspace_root))

    return result


def _is_glob(pattern: str) -> bool:
    return any(char in pattern for char in _GLOB_CHARS)


def _collect_paths(base: Path, pattern: str) -> tuple[list[Path], bool]:
    if not _is_glob(pattern):
        return [base / pattern], False
    matches: list[Path] = []
    truncated = False
    for path in base.glob(pattern):
        matches.append(path)
        if len(matches) >= _MAX_MATCHES:
            truncated = True
            break
    return matches, truncated


def _resolve_locations(
    schema: dict[str, Any],
    data_dir: Path,
    workspace_root: Path | None,
) -> tuple[list[Path], bool, set[str]]:
    expected: list[Path] = []
    truncated = False
    skipped_scopes: set[str] = set()
    seen: set[Path] = set()
    for location in schema.get("locations", []):
        if not isinstance(location, dict):
            continue
        scope = location.get("scope")
        pattern = location.get("pattern")
        if not isinstance(scope, str) or not isinstance(pattern, str):
            continue
        base: Path | None = None
        if scope == "data_dir":
            base = data_dir
        elif scope == "workspace_root":
            if workspace_root is None:
                skipped_scopes.add(scope)
                continue
            base = workspace_root
        else:
            skipped_scopes.add(scope)
            continue
        paths, was_truncated = _collect_paths(base, pattern)
        truncated = truncated or was_truncated
        for path in paths:
            if path in seen:
                continue
            seen.add(path)
            expected.append(path)
    return expected, truncated, skipped_scopes


def _missing_status(expected_paths: list[Path], skipped_scopes: set[str]) -> str:
    if not expected_paths and "workspace_root" in skipped_scopes:
        return "skipped_no_workspace_root"
    if not expected_paths:
        return "no_locations"
    return "missing"


def _probe_sqlite(schema: dict[str, Any], data_dir: Path, workspace_root: Path | None) -> dict[str, Any]:
    version_field = schema.get("version_field", {})
    ordered_ids = version_field.get("ordered_ids") if isinstance(version_field.get("ordered_ids"), list) else []
    latest_id = version_field.get("latest_id")
    table = version_field.get("table")
    id_column = version_field.get("id_column")

    expected_paths, truncated, skipped_scopes = _resolve_locations(schema, data_dir, workspace_root)
    db_path = None
    for candidate in expected_paths:
        if candidate.suffix == ".db":
            db_path = candidate
            break
    if db_path is None and expected_paths:
        db_path = expected_paths[0]
    if db_path is None:
        db_path = data_dir / ".qualifile_internal" / "qualifile.db"

    details: dict[str, Any] = {
        "path": str(db_path),
        "expected_ids": ordered_ids,
        "latest_id": latest_id,
        "table": table,
        "id_column": id_column,
        "truncated": truncated,
    }

    if not db_path.exists():
        return {
            "status": _missing_status(expected_paths, skipped_scopes),
            "current_version": None,
            "details": details,
        }

    applied_ids: list[str] = []
    pending_ids: list[str] = list(ordered_ids)
    current_id: str | None = None
    current_version: int | None = None
    conn: sqlite3.Connection | None = None
    try:
        uri_path = db_path.as_posix()
        conn = sqlite3.connect(f"file:{uri_path}?mode=ro", uri=True)
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (table,),
        ).fetchone()
        if not row:
            details["applied_ids"] = []
            details["pending_ids"] = pending_ids
            return {
                "status": "no_migrations_table",
                "current_version": None,
                "details": details,
            }
        rows = conn.execute(f"SELECT {id_column} FROM {table} ORDER BY applied_at").fetchall()
        applied_ids = [item[0] for item in rows if item and item[0]]
        pending_ids = [migration_id for migration_id in ordered_ids if migration_id not in set(applied_ids)]
        if applied_ids:
            current_id = applied_ids[-1]
        if current_id and current_id in ordered_ids:
            current_version = ordered_ids.index(current_id) + 1
        elif applied_ids:
            current_version = len(applied_ids)
    except Exception as exc:  # pragma: no cover - depends on filesystem state
        details["error"] = type(exc).__name__
        return {
            "status": "error",
            "current_version": None,
            "details": details,
        }
    finally:
        if conn is not None:
            conn.close()

    details["applied_ids"] = applied_ids
    details["pending_ids"] = pending_ids
    details["current_id"] = current_id
    return {
        "status": "ok",
        "current_version": current_version,
        "details": details,
    }


def _probe_json_field(schema: dict[str, Any], data_dir: Path, workspace_root: Path | None) -> dict[str, Any]:
    version_field = schema.get("version_field", {})
    field = version_field.get("field")
    expected_paths, truncated, skipped_scopes = _resolve_locations(schema, data_dir, workspace_root)
    if not expected_paths:
        return {
            "status": _missing_status(expected_paths, skipped_scopes),
            "current_version": None,
            "details": {"truncated": truncated},
        }
    if not isinstance(field, str):
        return {
            "status": "invalid_version_field",
            "current_version": None,
            "details": {"field": field},
        }

    existing_files = [path for path in expected_paths if path.exists() and path.is_file()]
    if not existing_files:
        return {
            "status": "missing",
            "current_version": None,
            "details": {
                "expected_paths": [str(path) for path in expected_paths[:_MAX_SAMPLE_PATHS]],
                "truncated": truncated,
            },
        }

    versions: set[int] = set()
    invalid_count = 0
    for path in existing_files:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            invalid_count += 1
            continue
        if not isinstance(raw, dict):
            invalid_count += 1
            continue
        value = raw.get(field)
        if isinstance(value, int):
            versions.add(value)
        else:
            invalid_count += 1

    details: dict[str, Any] = {
        "file_count": len(existing_files),
        "invalid_count": invalid_count,
        "truncated": truncated,
        "sample_paths": [str(path) for path in existing_files[:_MAX_SAMPLE_PATHS]],
    }

    if not versions:
        return {
            "status": "invalid",
            "current_version": None,
            "details": details,
        }
    if len(versions) == 1 and invalid_count == 0:
        version = next(iter(versions))
        return {
            "status": "ok",
            "current_version": version,
            "details": details,
        }
    if len(versions) == 1:
        version = next(iter(versions))
        details["versions"] = sorted(versions)
        return {
            "status": "partial",
            "current_version": version,
            "details": details,
        }

    details["versions"] = sorted(versions)
    return {
        "status": "mixed",
        "current_version": None,
        "details": details,
    }


def _probe_unversioned(schema: dict[str, Any], data_dir: Path, workspace_root: Path | None) -> dict[str, Any]:
    expected_paths, truncated, skipped_scopes = _resolve_locations(schema, data_dir, workspace_root)
    if not expected_paths:
        return {
            "status": _missing_status(expected_paths, skipped_scopes),
            "current_version": None,
            "details": {"truncated": truncated},
        }
    existing = [path for path in expected_paths if path.exists()]
    status = "present_unversioned" if existing else "missing"
    return {
        "status": status,
        "current_version": None,
        "details": {
            "path_count": len(existing),
            "truncated": truncated,
            "sample_paths": [str(path) for path in existing[:_MAX_SAMPLE_PATHS]],
        },
    }


__all__ = ["detect_schema_versions"]
