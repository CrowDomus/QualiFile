"""Helpers for building filesystem + sidecar snapshots for index rebuilds."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable

from .internal_paths import INTERNAL_EXACT_NAMES, is_internal_name
SIDECAR_FILENAME = ".qualifile_meta.json"
INTERNAL_NAMES = set(INTERNAL_EXACT_NAMES)
INTERNAL_DIRS = {
    ".git",
    ".qualifile_sync",
    ".qualifile_trash",
    ".qualifile_internal",
}
EMPTY_NOTE_SUMMARY = {
    "has_high_priority": False,
    "has_overdue": False,
    "open_count": 0,
    "closed_count": 0,
    "has_status": False,
}


@dataclass(frozen=True)
class IndexEntry:
    path: str
    parent_path: str | None
    name: str
    is_dir: bool
    size: int
    created_at: str
    modified_at: str
    extension: str | None


@dataclass(frozen=True)
class NoteEntry:
    path: str
    payload: dict


@dataclass(frozen=True)
class SidecarSnapshot:
    notes: dict[str, list[dict]]
    note_summaries: dict[str, dict]
    note_children: set[str]
    tags: dict[str, list[str]]
    validation: dict[str, bool]
    note_entries: list[NoteEntry]


def normalize_rel_path(value: str | Path | None) -> str:
    text = str(value or ".").replace("\\", "/").strip()
    while text.startswith("./"):
        text = text[2:]
    text = text.strip("/")
    return text or "."


def parent_path(value: str) -> str | None:
    if value in {"", "."}:
        return None
    parts = value.split("/")
    if len(parts) <= 1:
        return "."
    return "/".join(parts[:-1])


def _load_sidecar(path: Path) -> dict:
    if not path.exists():
        return {"schema_version": 1, "items": {}}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"schema_version": 1, "items": {}}
    if not isinstance(raw, dict):
        return {"schema_version": 1, "items": {}}
    if not isinstance(raw.get("schema_version"), int):
        raw["schema_version"] = 1
    if not isinstance(raw.get("items"), dict):
        raw["items"] = {}
    return raw


def _iter_sidecar_files(root: Path) -> Iterable[Path]:
    for path in root.rglob(SIDECAR_FILENAME):
        try:
            rel = path.parent.resolve().relative_to(root.resolve())
        except ValueError:
            continue
        if any(is_internal_name(part) for part in rel.parts):
            continue
        yield path


def _merge_sidecar_notes(sidecar_file: Path, items: dict) -> dict:
    merged: dict[str, dict] = {}
    for key, item in items.items():
        if isinstance(item, dict):
            merged[str(key)] = dict(item)
    root_item = merged.get(".", {})
    if not isinstance(root_item, dict):
        root_item = {}
    root_notes = root_item.get("notes")
    if not isinstance(root_notes, list):
        root_notes = []
    for key in list(merged.keys()):
        if key == ".":
            continue
        item = merged.get(key)
        if not isinstance(item, dict):
            continue
        notes = item.get("notes")
        if not (isinstance(notes, list) and notes):
            continue
        target = sidecar_file.parent / key
        if not target.exists():
            root_notes.extend([note for note in notes if isinstance(note, dict)])
            item.pop("notes", None)
            if not item:
                merged.pop(key, None)
    if root_notes:
        root_item["notes"] = root_notes
        merged["."] = root_item
    return merged


def _summarize_notes(notes: Iterable[dict]) -> dict:
    now = datetime.utcnow()
    has_high = False
    overdue = False
    open_count = 0
    closed_count = 0
    has_status = False
    for note in notes:
        if not isinstance(note, dict):
            continue
        status = note.get("status") or "none"
        if status == "closed":
            closed_count += 1
        else:
            open_count += 1
        if status and status != "none":
            has_status = True
        if note.get("priority") == "high":
            has_high = True
        deadline_raw = note.get("deadline")
        if deadline_raw:
            try:
                deadline_dt = datetime.fromisoformat(str(deadline_raw).replace("Z", "+00:00"))
            except Exception:
                continue
            if deadline_dt.date() < now.date():
                overdue = True
            elif deadline_dt.date() == now.date() and deadline_dt < now:
                overdue = True
    return {
        "has_high_priority": has_high,
        "has_overdue": overdue,
        "open_count": open_count,
        "closed_count": closed_count,
        "has_status": has_status,
    }


def iter_filesystem_entries(root: Path) -> list[IndexEntry]:
    root = Path(root).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise FileNotFoundError(f"Root not found: {root}")
    entries: list[IndexEntry] = []
    entries.append(_entry_for_path(root, root))
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not is_internal_name(d)]
        base_path = Path(base)
        for dirname in sorted(dirs):
            path = base_path / dirname
            entries.append(_entry_for_path(root, path))
        for filename in sorted(files):
            if is_internal_name(filename):
                continue
            path = base_path / filename
            entries.append(_entry_for_path(root, path))
    return entries


def _entry_for_path(root: Path, path: Path) -> IndexEntry:
    stat = path.stat()
    rel = "." if path.resolve() == root.resolve() else normalize_rel_path(path.relative_to(root))
    parent = None if rel == "." else parent_path(rel)
    name = path.name if rel != "." else (path.name or path.anchor or str(path))
    extension = None
    if path.is_file():
        suffix = path.suffix.lower().lstrip(".")
        extension = suffix or None
    return IndexEntry(
        path=rel,
        parent_path=parent,
        name=name,
        is_dir=path.is_dir(),
        size=int(stat.st_size),
        created_at=datetime.fromtimestamp(stat.st_ctime).isoformat(),
        modified_at=datetime.fromtimestamp(stat.st_mtime).isoformat(),
        extension=extension,
    )


def load_sidecar_snapshot(root: Path) -> SidecarSnapshot:
    root = Path(root).expanduser().resolve()
    notes: dict[str, list[dict]] = {}
    tags: dict[str, set[str]] = {}
    validation: dict[str, bool] = {}
    note_entries: list[NoteEntry] = []

    for sidecar_file in _iter_sidecar_files(root):
        data = _load_sidecar(sidecar_file)
        items = data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, dict):
            continue
        items = _merge_sidecar_notes(sidecar_file, items)
        relative_folder = sidecar_file.parent.relative_to(root)
        for key, item in items.items():
            if not isinstance(item, dict):
                continue
            rel_path = _rel_path_for_item(relative_folder, str(key))
            notes_list = item.get("notes")
            if isinstance(notes_list, list) and notes_list:
                filtered_notes = [note for note in notes_list if isinstance(note, dict)]
                if filtered_notes:
                    notes.setdefault(rel_path, []).extend(filtered_notes)
                    for note in filtered_notes:
                        note_id = note.get("id")
                        if isinstance(note_id, str):
                            note_entries.append(NoteEntry(path=rel_path, payload=note))
            tags_list = item.get("tags")
            if isinstance(tags_list, list) and tags_list:
                if rel_path and rel_path != ".":
                    tags.setdefault(rel_path, set()).update(
                        str(tag) for tag in tags_list if isinstance(tag, str)
                    )
            if item.get("validation") is True:
                if rel_path and rel_path != ".":
                    validation[rel_path] = True

    note_summaries = {path: _summarize_notes(notes_list) for path, notes_list in notes.items()}
    note_children: set[str] = set()
    for path, notes_list in notes.items():
        if path == ".":
            continue
        if not any((note.get("status") or "none") != "closed" for note in notes_list if isinstance(note, dict)):
            continue
        parent = parent_path(path)
        while parent:
            note_children.add(parent)
            if parent == ".":
                break
            parent = parent_path(parent)

    tag_map = {path: sorted(values) for path, values in tags.items()}

    return SidecarSnapshot(
        notes=notes,
        note_summaries=note_summaries,
        note_children=note_children,
        tags=tag_map,
        validation=validation,
        note_entries=note_entries,
    )


def _rel_path_for_item(relative_folder: Path, key: str) -> str:
    if key == ".":
        return normalize_rel_path(relative_folder)
    return normalize_rel_path(relative_folder / key)


__all__ = [
    "EMPTY_NOTE_SUMMARY",
    "INTERNAL_NAMES",
    "IndexEntry",
    "NoteEntry",
    "SidecarSnapshot",
    "iter_filesystem_entries",
    "load_sidecar_snapshot",
    "normalize_rel_path",
    "parent_path",
]
