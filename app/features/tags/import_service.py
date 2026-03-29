"""Helpers for importing tag definitions between project roots."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterable

from .db_store import TagDefinitionDBStore
from .store import MAX_TAGS

IMPORT_MODE_APPEND = "append"
IMPORT_MODE_REPLACE = "replace"
ALLOWED_IMPORT_MODES = {IMPORT_MODE_APPEND, IMPORT_MODE_REPLACE}


class TagImportLimitError(ValueError):
    """Raised when an import would exceed tag limits."""


def normalize_import_mode(value: object) -> str:
    text = str(value or IMPORT_MODE_APPEND).strip().lower()
    if text not in ALLOWED_IMPORT_MODES:
        raise ValueError("Import mode must be 'append' or 'replace'.")
    return text


def _normalized_tag_name(value: object) -> str:
    return str(value or "").strip().casefold()


def _missing_unique_names(source_tags: Iterable[dict], existing_names: set[str]) -> set[str]:
    missing: set[str] = set()
    for tag in source_tags:
        key = _normalized_tag_name(tag.get("name"))
        if not key or key in existing_names:
            continue
        missing.add(key)
    return missing


def _apply_show_header(store: TagDefinitionDBStore, tag_id: str, source_show_header: object) -> None:
    if source_show_header is None:
        return
    store.update_tag(tag_id, show_header=bool(source_show_header))


def _apply_parent_links(
    store: TagDefinitionDBStore,
    source_tags: list[dict],
    source_to_dest: dict[str, str],
    *,
    source_ids_to_update: set[str] | None = None,
) -> int:
    updated_parents = 0
    for source_tag in source_tags:
        source_id = str(source_tag.get("id") or "").strip()
        if not source_id:
            continue
        if source_ids_to_update is not None and source_id not in source_ids_to_update:
            continue
        source_parent_id = source_tag.get("parent_id")
        if not isinstance(source_parent_id, str) or not source_parent_id:
            continue
        destination_id = source_to_dest.get(source_id)
        destination_parent_id = source_to_dest.get(source_parent_id)
        if not destination_id or not destination_parent_id or destination_id == destination_parent_id:
            continue
        store.update_tag(destination_id, parent_id=destination_parent_id)
        updated_parents += 1
    return updated_parents


def _append_tags(source_store: TagDefinitionDBStore, target_store: TagDefinitionDBStore) -> dict:
    source_tags = source_store.list_tags()
    target_tags = target_store.list_tags()
    existing_by_name = {_normalized_tag_name(tag.get("name")): tag for tag in target_tags}
    missing_names = _missing_unique_names(source_tags, set(existing_by_name.keys()))
    if len(target_tags) + len(missing_names) > MAX_TAGS:
        raise TagImportLimitError(f"Import would exceed the maximum of {MAX_TAGS} tags.")

    source_to_dest: dict[str, str] = {}
    added = 0
    already_present = 0
    new_source_ids: set[str] = set()

    for source_tag in source_tags:
        source_id = str(source_tag.get("id") or "").strip()
        if not source_id:
            continue
        name_key = _normalized_tag_name(source_tag.get("name"))
        if not name_key:
            continue
        existing = existing_by_name.get(name_key)
        if existing:
            source_to_dest[source_id] = str(existing.get("id"))
            already_present += 1
            continue

        created = target_store.create_tag(
            source_tag.get("name", ""),
            source_tag.get("color"),
            None,
        )
        _apply_show_header(target_store, created["id"], source_tag.get("show_header"))
        source_to_dest[source_id] = created["id"]
        existing_by_name[name_key] = created
        new_source_ids.add(source_id)
        added += 1

    updated_parents = _apply_parent_links(
        target_store,
        source_tags,
        source_to_dest,
        source_ids_to_update=new_source_ids,
    )
    return {
        "ok": True,
        "mode": IMPORT_MODE_APPEND,
        "added": added,
        "already_present": already_present,
        "updated_parents": updated_parents,
        "removed": 0,
    }


def _replace_tags(source_store: TagDefinitionDBStore, target_store: TagDefinitionDBStore) -> dict:
    source_tags = source_store.list_tags()
    source_names = {_normalized_tag_name(tag.get("name")) for tag in source_tags if _normalized_tag_name(tag.get("name"))}
    if len(source_names) > MAX_TAGS:
        raise TagImportLimitError(f"Import would exceed the maximum of {MAX_TAGS} tags.")

    existing_target_tags = target_store.list_tags()
    removed = len(existing_target_tags)
    for existing in existing_target_tags:
        target_store.delete_tag(str(existing.get("id")))

    source_to_dest: dict[str, str] = {}
    for source_tag in source_tags:
        source_id = str(source_tag.get("id") or "").strip()
        if not source_id:
            continue
        created = target_store.create_tag(
            source_tag.get("name", ""),
            source_tag.get("color"),
            None,
        )
        _apply_show_header(target_store, created["id"], source_tag.get("show_header"))
        source_to_dest[source_id] = created["id"]

    updated_parents = _apply_parent_links(target_store, source_tags, source_to_dest)
    return {
        "ok": True,
        "mode": IMPORT_MODE_REPLACE,
        "added": len(source_to_dest),
        "already_present": 0,
        "updated_parents": updated_parents,
        "removed": removed,
    }


def import_tags_between_roots(
    conn: sqlite3.Connection,
    source_root: Path,
    target_root: Path,
    mode: object = IMPORT_MODE_APPEND,
) -> dict:
    """Import tag definitions from *source_root* to *target_root*."""

    normalized_mode = normalize_import_mode(mode)
    source_store = TagDefinitionDBStore(conn, source_root)
    target_store = TagDefinitionDBStore(conn, target_root)
    if normalized_mode == IMPORT_MODE_REPLACE:
        return _replace_tags(source_store, target_store)
    return _append_tags(source_store, target_store)


__all__ = [
    "ALLOWED_IMPORT_MODES",
    "IMPORT_MODE_APPEND",
    "IMPORT_MODE_REPLACE",
    "TagImportLimitError",
    "import_tags_between_roots",
    "normalize_import_mode",
]
