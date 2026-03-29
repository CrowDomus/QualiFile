"""Helpers to migrate legacy notes/tags/validation into sidecar files."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict

from ...features.metadata.sidecar import (
    SCHEMA_VERSION,
    cleanup_item,
    ensure_item,
    load_sidecar,
    resolve_item_location,
    sidecar_path,
    write_sidecar,
)
from ...features.notes.store import NOTES_FILENAME, Note
from ...features.tags.store import TagStore


def _read_json(path: Path, default: object) -> object:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _merge_notes_containers(notes_file: Path, containers: dict) -> dict:
    merged = dict(containers)
    root_container = merged.get(".", {"path": ".", "notes": []})
    for key in list(merged.keys()):
        if key == ".":
            continue
        target = notes_file.parent / key
        if not target.exists():
            child = merged.pop(key, {})
            child_notes = child.get("notes", []) if isinstance(child, dict) else []
            if isinstance(root_container, dict):
                root_container.setdefault("notes", [])
                if isinstance(root_container.get("notes"), list):
                    root_container["notes"].extend(child_notes)
    merged["."] = root_container
    return merged


def load_validation_map(data_dir: Path) -> dict[str, dict[str, bool]]:
    path = Path(data_dir) / ".qualifile_internal" / "validation" / "validation_state.json"
    raw = _read_json(path, {})
    if not isinstance(raw, dict):
        return {}
    roots = raw.get("roots") if isinstance(raw.get("roots"), dict) else None
    if roots is None:
        roots = {k: v for k, v in raw.items() if isinstance(v, dict)}
    cleaned: dict[str, dict[str, bool]] = {}
    for root_key, mapping in roots.items():
        if not isinstance(root_key, str) or not isinstance(mapping, dict):
            continue
        resolved_root = str(Path(root_key).resolve())
        valid: dict[str, bool] = {}
        for path_key, flag in mapping.items():
            if not flag or not isinstance(path_key, str):
                continue
            valid[path_key] = True
        if valid:
            cleaned[resolved_root] = valid
    return cleaned


def _normalize_notes(notes_raw: object) -> list[dict]:
    if not isinstance(notes_raw, list):
        return []
    normalized: list[dict] = []
    for entry in notes_raw:
        note = Note.from_raw(entry)
        if note:
            normalized.append(note.as_dict())
    return normalized


def load_notes_by_folder(root: Path) -> dict[Path, dict[str, dict[str, object]]]:
    folder_map: dict[Path, dict[str, dict[str, object]]] = {}
    for notes_file in Path(root).rglob(NOTES_FILENAME):
        raw = _read_json(notes_file, {"containers": {}})
        containers = raw.get("containers", {}) if isinstance(raw, dict) else {}
        if not isinstance(containers, dict):
            continue
        containers = _merge_notes_containers(notes_file, containers)
        folder = notes_file.parent.resolve()
        bucket = folder_map.setdefault(folder, {})
        for key, container in containers.items():
            if not isinstance(container, dict):
                continue
            notes = _normalize_notes(container.get("notes"))
            if not notes:
                continue
            entry = bucket.setdefault(str(key), {})
            entry["notes"] = notes
    return folder_map


def apply_tags(root: Path, folder_map: dict[Path, dict[str, dict[str, object]]]) -> None:
    store = TagStore(Path(root))
    for relative, tags in store.assignments.items():
        folder, key = resolve_item_location(Path(root), relative)
        bucket = folder_map.setdefault(folder.resolve(), {})
        entry = bucket.setdefault(str(key), {})
        entry["tags"] = list(tags)


def apply_validation(
    root: Path,
    validation_map: dict[str, dict[str, bool]],
    folder_map: dict[Path, dict[str, dict[str, object]]],
) -> None:
    root_key = str(Path(root).resolve())
    root_entries = validation_map.get(root_key, {})
    for relative, flag in root_entries.items():
        if not flag:
            continue
        try:
            folder, key = resolve_item_location(Path(root), relative)
        except Exception:
            continue
        if folder.is_dir() and key == ".":
            continue
        bucket = folder_map.setdefault(folder.resolve(), {})
        entry = bucket.setdefault(str(key), {})
        entry["validation"] = True


def write_sidecars(folder_map: dict[Path, dict[str, dict[str, object]]]) -> tuple[int, int]:
    written = 0
    items_written = 0
    for folder, items in folder_map.items():
        if not items:
            continue
        path = sidecar_path(folder)
        result = load_sidecar(path)
        data = result.data
        data["schema_version"] = SCHEMA_VERSION
        sidecar_items = data.get("items")
        if not isinstance(sidecar_items, dict):
            sidecar_items = {}
            data["items"] = sidecar_items
        for key, desired in items.items():
            entry = ensure_item(sidecar_items, str(key))
            if "notes" in desired:
                entry["notes"] = desired["notes"]
            if "tags" in desired:
                entry["tags"] = desired["tags"]
            if "validation" in desired:
                entry["validation"] = desired["validation"]
            cleanup_item(sidecar_items, str(key))
            items_written += 1
        write_sidecar(path, data)
        written += 1
    return written, items_written


def migrate_legacy_metadata(
    data_dir: Path,
    roots: list[Path],
    *,
    include_notes: bool = True,
    include_tags: bool = True,
    include_validation: bool = True,
) -> tuple[int, int]:
    validation_map: dict[str, dict[str, bool]] = {}
    if include_validation:
        validation_map = load_validation_map(data_dir)
    total_written = 0
    total_items = 0
    for root in roots:
        folder_map: dict[Path, dict[str, dict[str, object]]] = {}
        if include_notes:
            folder_map = load_notes_by_folder(root)
        if include_tags:
            apply_tags(root, folder_map)
        if include_validation:
            apply_validation(root, validation_map, folder_map)
        written, items_written = write_sidecars(folder_map)
        total_written += written
        total_items += items_written
    return total_written, total_items


__all__ = [
    "apply_tags",
    "apply_validation",
    "load_notes_by_folder",
    "load_validation_map",
    "migrate_legacy_metadata",
    "write_sidecars",
]
