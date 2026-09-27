"""Service facade for file-bound metadata (notes, tags, validation)."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Iterable, Mapping
from uuid import uuid4

from ..notes.store import Note, NoteStore, PRIORITIES, STATUSES, _normalize_color
from ..tags.db_store import TagDefinitionDBStore
from ..tags.store import TagStore
from ..validation.store import ValidationStore
from .sidecar import (
    SIDECAR_FILENAME,
    SidecarLoadResult,
    cleanup_item,
    ensure_item,
    load_sidecar,
    resolve_item_location,
    sidecar_path,
    write_sidecar,
)


SIDECAR_READ_ERROR_MESSAGE = (
    "Metadata file is locked or unreadable; changes were not saved. "
    "Close other programs and try again."
)


class SidecarReadError(RuntimeError):
    def __init__(self, path: Path, message: str | None = None):
        super().__init__(message or SIDECAR_READ_ERROR_MESSAGE)
        self.path = path


class MetadataService:
    """Read/write metadata through legacy stores and sidecar files."""

    def __init__(
        self,
        root: Path,
        data_dir: Path | str | None,
        *,
        config: Mapping[str, object] | None = None,
        db_conn: sqlite3.Connection | None = None,
    ):
        self.root = Path(root)
        self.data_dir = Path(data_dir) if data_dir is not None else self.root
        self.config = config or {}
        self._db_conn = db_conn
        self._note_store = NoteStore(self.root)
        self._sidecar_tag_assignments: dict[str, list[str]] | None = None
        self._sidecar_validation_assignments: dict[str, bool] | None = None
        self._sidecar_files_cache: list[Path] | None = None
        self._sidecar_cache: dict[Path, dict] = {}
        self._sidecar_result_cache: dict[Path, SidecarLoadResult] = {}

    @property
    def tag_definitions(self) -> list[dict]:
        if not self._db_conn:
            return []
        return TagDefinitionDBStore(self._db_conn, self.root).list_tags()

    @property
    def tag_assignments(self) -> dict[str, list[str]]:
        return self._load_sidecar_tag_assignments()

    @property
    def validation_assignments(self) -> dict[str, bool]:
        return self._load_sidecar_validation_assignments()

    def is_validated(self, relative: str | Path) -> bool:
        return self._sidecar_validation_for_path(relative)

    def get_notes(self, relative: str | Path) -> list[dict]:
        return self._sidecar_notes_for_path(relative)

    def summarize(self, notes: list[dict]) -> dict:
        return self._note_store.summarize(notes)

    def has_descendant_open_notes(self, relative: str | Path) -> bool:
        return self._sidecar_has_descendant_open_notes(relative)

    def _iter_sidecar_files(self) -> list[Path]:
        if self._sidecar_files_cache is None:
            self._sidecar_files_cache = list(self.root.rglob(SIDECAR_FILENAME))
        return list(self._sidecar_files_cache)

    def _relative_path_for_item(self, folder: Path, key: str) -> str | None:
        try:
            rel_folder = folder.resolve().relative_to(self.root.resolve())
        except ValueError:
            return None
        if key == ".":
            rel = str(rel_folder).replace("\\", "/").strip("/")
            return rel or "."
        rel = str(rel_folder / key).replace("\\", "/").strip("/")
        return rel or "."

    def _load_sidecar_tag_assignments(self) -> dict[str, list[str]]:
        if self._sidecar_tag_assignments is not None:
            return self._sidecar_tag_assignments
        assignments: dict[str, list[str]] = {}
        for sidecar_file in self._iter_sidecar_files():
            result = self._load_sidecar_result(sidecar_file)
            data = result.data
            items = data.get("items") if isinstance(data, dict) else None
            if not isinstance(items, dict):
                continue
            folder = sidecar_file.parent
            for key, item in items.items():
                if not isinstance(item, dict):
                    continue
                tags = item.get("tags")
                if not isinstance(tags, list) or not tags:
                    continue
                rel = self._relative_path_for_item(folder, str(key))
                if not rel or rel == ".":
                    continue
                assignments[rel] = sorted({str(tag) for tag in tags if isinstance(tag, str)})
        self._sidecar_tag_assignments = assignments
        return assignments

    def _load_sidecar_validation_assignments(self) -> dict[str, bool]:
        if self._sidecar_validation_assignments is not None:
            return self._sidecar_validation_assignments
        assignments: dict[str, bool] = {}
        for sidecar_file in self._iter_sidecar_files():
            result = self._load_sidecar_result(sidecar_file)
            data = result.data
            items = data.get("items") if isinstance(data, dict) else None
            if not isinstance(items, dict):
                continue
            folder = sidecar_file.parent
            for key, item in items.items():
                if not isinstance(item, dict):
                    continue
                if item.get("validation") is not True:
                    continue
                if str(key) == ".":
                    continue
                rel = self._relative_path_for_item(folder, str(key))
                if not rel or rel == ".":
                    continue
                assignments[rel] = True
        self._sidecar_validation_assignments = assignments
        return assignments

    def _sidecar_items_for_folder(self, relative: str | Path) -> dict:
        try:
            folder, _ = resolve_item_location(self.root, str(relative))
        except Exception:
            return {}
        path = sidecar_path(folder)
        if not path.exists():
            return {}
        result = self._load_sidecar_result(path)
        data = result.data
        items = data.get("items") if isinstance(data, dict) else None
        return items if isinstance(items, dict) else {}

    def _sidecar_tags_for_item(self, item: dict | None) -> list[str]:
        tags = item.get("tags") if isinstance(item, dict) else None
        if not isinstance(tags, list) or not tags:
            return []
        return sorted({str(tag) for tag in tags if isinstance(tag, str)})

    def _sidecar_notes_for_item(self, item: dict | None) -> list[dict]:
        notes = item.get("notes") if isinstance(item, dict) else None
        return notes if isinstance(notes, list) else []

    def apply_listing_metadata(self, entries: list[dict], relative: str | Path) -> dict[str, bool]:
        items = self._sidecar_items_for_folder(relative)
        validation_map: dict[str, bool] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name")
            item = None
            if isinstance(items, dict) and isinstance(name, str):
                item = items.get(name)
            if entry.get("is_dir"):
                rel_path = entry.get("path")
                if isinstance(rel_path, str):
                    folder_items = self._sidecar_items_for_folder(rel_path)
                    folder_item = folder_items.get(".") if isinstance(folder_items, dict) else None
                    if isinstance(folder_item, dict):
                        item = folder_item
            entry["tags"] = self._sidecar_tags_for_item(item)
            validated = bool(item.get("validation") is True) if isinstance(item, dict) else False
            if entry.get("is_dir"):
                validated = False
            entry["validated"] = validated
            if validated:
                rel_path = entry.get("path")
                if isinstance(rel_path, str):
                    validation_map[rel_path] = True
            notes = self._sidecar_notes_for_item(item)
            entry["notes"] = notes
            entry["note_summary"] = self.summarize(notes)
            if entry.get("is_dir"):
                rel_path = entry.get("path") or "."
                entry["note_children"] = bool(self.has_descendant_open_notes(rel_path))
            else:
                entry["note_children"] = False
        return validation_map

    def _sidecar_validation_for_path(self, relative: str | Path) -> bool:
        try:
            folder, key = resolve_item_location(self.root, str(relative))
        except Exception:
            return False
        if key == ".":
            return False
        path = sidecar_path(folder)
        if not path.exists():
            return False
        data = self._load_sidecar_result(path).data
        items = data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, dict):
            return False
        item = items.get(key)
        if not isinstance(item, dict):
            return False
        return item.get("validation") is True

    def _sidecar_notes_for_path(self, relative: str | Path) -> list[dict]:
        try:
            folder, key = resolve_item_location(self.root, str(relative))
        except Exception:
            return []
        path = sidecar_path(folder)
        if not path.exists():
            return []
        result = self._load_sidecar_result(path)
        data = result.data
        items = data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, dict):
            return []
        if result.status == "read_error":
            if key == ".":
                root_item = items.get(".") if isinstance(items.get("."), dict) else {}
                root_notes = root_item.get("notes")
                return root_notes if isinstance(root_notes, list) else []
            item = items.get(key) if isinstance(items.get(key), dict) else {}
            notes = item.get("notes")
            return notes if isinstance(notes, list) else []
        changed = False
        if key == ".":
            root_item = items.get(".") if isinstance(items.get("."), dict) else {}
            root_notes = root_item.get("notes")
            if not isinstance(root_notes, list):
                root_notes = []
            for child_key, child_item in list(items.items()):
                if child_key == "." or not isinstance(child_item, dict):
                    continue
                child_notes = child_item.get("notes")
                if not (isinstance(child_notes, list) and child_notes):
                    continue
                target = folder / str(child_key)
                if not target.exists():
                    root_notes.extend(child_notes)
                    child_item.pop("notes", None)
                    cleanup_item(items, str(child_key))
                    changed = True
            if root_notes:
                root_item["notes"] = root_notes
                items["."] = root_item
            else:
                root_item.pop("notes", None)
                cleanup_item(items, ".")
            notes = root_notes
        else:
            item = items.get(key) if isinstance(items.get(key), dict) else {}
            notes = item.get("notes") if isinstance(item.get("notes"), list) else []
            target = folder / str(key)
            if not target.exists() and notes:
                root_item = ensure_item(items, ".")
                root_notes = root_item.get("notes")
                if not isinstance(root_notes, list):
                    root_notes = []
                root_notes.extend(notes)
                root_item["notes"] = root_notes
                item.pop("notes", None)
                cleanup_item(items, str(key))
                cleanup_item(items, ".")
                notes = root_notes
                changed = True
        if changed:
            self._write_sidecar(path, data)
        return notes if isinstance(notes, list) else []

    def _sidecar_has_descendant_open_notes(self, relative: str | Path) -> bool:
        try:
            target = self.root / str(relative)
            target = target.resolve()
        except Exception:
            return False
        if not target.exists():
            return False
        for sidecar_file in target.rglob(SIDECAR_FILENAME):
            data = self._load_sidecar_result(sidecar_file).data
            items = data.get("items") if isinstance(data, dict) else None
            if not isinstance(items, dict):
                continue
            is_root_sidecar = sidecar_file.parent.resolve() == target
            for key, item in items.items():
                if not isinstance(item, dict):
                    continue
                if is_root_sidecar and str(key) == ".":
                    continue
                notes = item.get("notes")
                if not isinstance(notes, list):
                    continue
                for note in notes:
                    if not isinstance(note, dict):
                        continue
                    status = note.get("status") or "none"
                    if status != "closed":
                        return True
        return False

    def _now(self) -> str:
        return datetime.utcnow().isoformat()

    def _invalidate_sidecar_caches(self) -> None:
        self._sidecar_tag_assignments = None
        self._sidecar_validation_assignments = None
        self._sidecar_files_cache = None
        self._sidecar_result_cache = {}

    def _load_sidecar_result(self, path: Path) -> SidecarLoadResult:
        cached = self._sidecar_result_cache.get(path)
        if cached is not None:
            return cached
        result = load_sidecar(path)
        if result.status == "read_error":
            cached = self._sidecar_cache.get(path)
            if cached is not None:
                cached_result = SidecarLoadResult(cached, "read_error")
                self._sidecar_result_cache[path] = cached_result
                return cached_result
            self._sidecar_result_cache[path] = result
            return result
        self._sidecar_cache[path] = result.data
        self._sidecar_result_cache[path] = result
        return result

    def _load_sidecar_for_write(self, path: Path) -> dict:
        result = self._load_sidecar_result(path)
        if result.status == "read_error":
            raise SidecarReadError(path)
        return result.data

    def _write_sidecar(self, path: Path, data: dict) -> None:
        write_sidecar(path, data)
        self._sidecar_cache[path] = data
        self._sidecar_result_cache[path] = SidecarLoadResult(data, "ok")

    def _normalize_rel_path(self, value: str | Path | None) -> str:
        text = str(value or ".").replace("\\", "/").strip()
        while text.startswith("./"):
            text = text[2:]
        text = text.strip("/")
        return text or "."

    def _filter_tag_ids(self, tag_ids: Iterable[str]) -> list[str]:
        valid_ids = {tag.get("id") for tag in self.tag_definitions if isinstance(tag, dict)}
        selection = [tag_id for tag_id in tag_ids if tag_id in valid_ids]
        return sorted(set(selection))

    def _sidecar_set_tags(self, relative: str | Path, tags: Iterable[str]) -> list[str]:
        normalized = TagStore.normalize_path(relative)
        if not normalized or normalized == ".":
            raise ValueError("A valid path is required.")
        folder, key = resolve_item_location(self.root, str(relative))
        path = sidecar_path(folder)
        data = self._load_sidecar_for_write(path)
        items = data.get("items")
        if not isinstance(items, dict):
            items = {}
            data["items"] = items
        item = ensure_item(items, str(key))
        tags_list = sorted(set(tags))
        if tags_list:
            item["tags"] = tags_list
        else:
            item.pop("tags", None)
            cleanup_item(items, str(key))
        self._write_sidecar(path, data)
        self._invalidate_sidecar_caches()
        return tags_list

    def _sidecar_set_validation(self, relative: str | Path, validated: bool) -> bool:
        normalized = ValidationStore.normalize_path(relative)
        if not normalized or normalized == ".":
            raise ValueError("A valid file path is required.")
        folder, key = resolve_item_location(self.root, str(relative))
        if key == ".":
            raise ValueError("A valid file path is required.")
        path = sidecar_path(folder)
        data = self._load_sidecar_for_write(path)
        items = data.get("items")
        if not isinstance(items, dict):
            items = {}
            data["items"] = items
        item = ensure_item(items, str(key))
        if validated:
            item["validation"] = True
        else:
            item.pop("validation", None)
            cleanup_item(items, str(key))
        self._write_sidecar(path, data)
        self._invalidate_sidecar_caches()
        return bool(validated)

    def _sidecar_add_note_payload(self, relative: str | Path, note: dict) -> dict:
        folder, key = resolve_item_location(self.root, str(relative))
        path = sidecar_path(folder)
        data = self._load_sidecar_for_write(path)
        items = data.get("items")
        if not isinstance(items, dict):
            items = {}
            data["items"] = items
        item = ensure_item(items, str(key))
        notes = item.get("notes")
        if not isinstance(notes, list):
            notes = []
        item["notes"] = [note] + notes
        self._write_sidecar(path, data)
        return note

    def _sidecar_update_note_payload(
        self,
        relative: str | Path,
        note_id: str,
        *,
        text: str | None = None,
        deadline: str | None = None,
        priority: str | None = None,
        status: str | None = None,
        color: str | None = None,
    ) -> dict:
        folder, key = resolve_item_location(self.root, str(relative))
        path = sidecar_path(folder)
        data = self._load_sidecar_for_write(path)
        items = data.get("items")
        if not isinstance(items, dict):
            raise KeyError("Note not found.")
        item = items.get(str(key))
        if not isinstance(item, dict):
            raise KeyError("Note not found.")
        notes = item.get("notes")
        if not isinstance(notes, list):
            raise KeyError("Note not found.")
        updated = False
        for note in notes:
            if note.get("id") != note_id:
                continue
            if text is not None:
                cleaned = text.strip()
                if not cleaned:
                    raise ValueError("Note text cannot be empty.")
                note["text"] = cleaned
                updated = True
            if deadline is not None:
                note["deadline"] = deadline.strip() if isinstance(deadline, str) and deadline.strip() else None
                updated = True
            if priority is not None:
                if priority not in PRIORITIES:
                    raise ValueError("Invalid priority.")
                note["priority"] = priority
                updated = True
            if status is not None:
                if status not in STATUSES:
                    raise ValueError("Invalid status.")
                note["status"] = status
                updated = True
            if color is not None:
                note["color"] = _normalize_color(color)
                updated = True
            if updated:
                note["updated_at"] = self._now()
                break
        else:
            raise KeyError("Note not found.")
        item["notes"] = notes
        self._write_sidecar(path, data)
        return note

    def _sidecar_replace_note_payload(self, relative: str | Path, payload: dict) -> dict:
        note_id = payload.get("id")
        if not isinstance(note_id, str) or not note_id:
            raise KeyError("Note not found.")
        folder, key = resolve_item_location(self.root, str(relative))
        path = sidecar_path(folder)
        data = self._load_sidecar_for_write(path)
        items = data.get("items")
        if not isinstance(items, dict):
            raise KeyError("Note not found.")
        item = items.get(str(key))
        if not isinstance(item, dict):
            raise KeyError("Note not found.")
        notes = item.get("notes")
        if not isinstance(notes, list):
            raise KeyError("Note not found.")
        for index, note in enumerate(notes):
            if note.get("id") == note_id:
                notes[index] = payload
                item["notes"] = notes
                self._write_sidecar(path, data)
                return payload
        raise KeyError("Note not found.")
    def _sidecar_delete_note_payload(self, relative: str | Path, note_id: str) -> None:
        folder, key = resolve_item_location(self.root, str(relative))
        path = sidecar_path(folder)
        if not path.exists():
            return
        data = self._load_sidecar_for_write(path)
        items = data.get("items")
        if not isinstance(items, dict):
            return
        item = items.get(str(key))
        if not isinstance(item, dict):
            return
        notes = item.get("notes")
        if not isinstance(notes, list):
            return
        remaining = [note for note in notes if note.get("id") != note_id]
        if remaining:
            item["notes"] = remaining
        else:
            item.pop("notes", None)
            cleanup_item(items, str(key))
        self._write_sidecar(path, data)

    def assign_tags(self, relative: str | Path, tag_ids: Iterable[str]) -> list[str]:
        filtered = self._filter_tag_ids(tag_ids)
        return self._sidecar_set_tags(relative, filtered)

    def add_note(
        self,
        relative: str | Path,
        *,
        text: str,
        deadline: str | None = None,
        priority: str | None = None,
        status: str = "none",
        color: str | None = None,
    ) -> dict:
        cleaned_text = (text or "").strip()
        if not cleaned_text:
            raise ValueError("Note text cannot be empty.")
        priority_value = priority if priority in PRIORITIES else None
        status_value = status if status in STATUSES else "none"
        color_value = _normalize_color(color)
        now = self._now()
        note = Note(
            id=f"note-{uuid4().hex[:12]}",
            text=cleaned_text,
            created_at=now,
            updated_at=now,
            deadline=deadline.strip() if isinstance(deadline, str) and deadline.strip() else None,
            priority=priority_value,
            status=status_value,
            color=color_value,
        ).as_dict()
        return self._sidecar_add_note_payload(relative, note)

    def update_note(
        self,
        relative: str | Path,
        note_id: str,
        *,
        text: str | None = None,
        deadline: str | None = None,
        priority: str | None = None,
        status: str | None = None,
        color: str | None = None,
    ) -> dict:
        return self._sidecar_update_note_payload(
            relative,
            note_id,
            text=text,
            deadline=deadline,
            priority=priority,
            status=status,
            color=color,
        )

    def delete_note(self, relative: str | Path, note_id: str) -> None:
        self._sidecar_delete_note_payload(relative, note_id)

    def set_validation(self, relative: str | Path, validated: bool) -> bool:
        return self._sidecar_set_validation(relative, bool(validated))

    def toggle_validation(self, relative: str | Path) -> bool:
        current = self._sidecar_validation_for_path(relative)
        return self._sidecar_set_validation(relative, not current)

    def reassign_path(self, old_path: str | Path, new_path: str | Path, *, is_dir: bool | None = None) -> None:
        if self._db_conn is not None:
            from ..preview.image_history import ImageHistory
            ImageHistory(self._db_conn, self.root, self.data_dir).reassign(old_path, new_path)
        is_directory = bool(is_dir)
        self._sidecar_reassign_tags(old_path, new_path, is_directory)
        self._sidecar_reassign_notes(old_path, new_path, is_directory)
        self._sidecar_reassign_validation(old_path, new_path, is_directory)

    def clear_path(self, relative: str | Path) -> None:
        self._sidecar_clear_path(relative, {"tags", "notes", "validation"})

    def remove_tag_assignments(self, tag_id: str) -> None:
        """Remove a tag id from all sidecar assignments."""

        if not tag_id:
            return
        touched = False
        for sidecar_file in self._iter_sidecar_files():
            data = self._load_sidecar_for_write(sidecar_file)
            items = data.get("items")
            if not isinstance(items, dict):
                continue
            changed = False
            for key, item in list(items.items()):
                if not isinstance(item, dict):
                    continue
                tags = item.get("tags")
                if not isinstance(tags, list) or tag_id not in tags:
                    continue
                remaining = [tid for tid in tags if tid != tag_id]
                if remaining:
                    item["tags"] = remaining
                else:
                    item.pop("tags", None)
                    cleanup_item(items, str(key))
                changed = True
            if changed:
                self._write_sidecar(sidecar_file, data)
                touched = True
        if touched:
            self._invalidate_sidecar_caches()

    def _sidecar_reassign_tags(self, old_path: str | Path, new_path: str | Path, is_dir: bool) -> None:
        if is_dir:
            return
        old_folder, old_key = resolve_item_location(self.root, str(old_path))
        new_folder, new_key = resolve_item_location(self.root, str(new_path))
        if old_folder == new_folder and old_key == new_key:
            return
        old_sidecar = sidecar_path(old_folder)
        if not old_sidecar.exists():
            return
        old_data = self._load_sidecar_for_write(old_sidecar)
        old_items = old_data.get("items")
        if not isinstance(old_items, dict):
            return
        old_item = old_items.get(str(old_key))
        if not isinstance(old_item, dict):
            return
        tags = old_item.get("tags")
        if not isinstance(tags, list) or not tags:
            return
        old_item.pop("tags", None)
        cleanup_item(old_items, str(old_key))
        if old_folder == new_folder:
            new_item = ensure_item(old_items, str(new_key))
            new_item["tags"] = tags
            self._write_sidecar(old_sidecar, old_data)
        else:
            new_sidecar = sidecar_path(new_folder)
            new_data = self._load_sidecar_for_write(new_sidecar)
            new_items = new_data.get("items")
            if not isinstance(new_items, dict):
                new_items = {}
                new_data["items"] = new_items
            new_item = ensure_item(new_items, str(new_key))
            new_item["tags"] = tags
            self._write_sidecar(old_sidecar, old_data)
            self._write_sidecar(new_sidecar, new_data)
        self._invalidate_sidecar_caches()

    def _sidecar_reassign_validation(self, old_path: str | Path, new_path: str | Path, is_dir: bool) -> None:
        if is_dir:
            return
        old_folder, old_key = resolve_item_location(self.root, str(old_path))
        new_folder, new_key = resolve_item_location(self.root, str(new_path))
        if old_folder == new_folder and old_key == new_key:
            return
        old_sidecar = sidecar_path(old_folder)
        if not old_sidecar.exists():
            return
        old_data = self._load_sidecar_for_write(old_sidecar)
        old_items = old_data.get("items")
        if not isinstance(old_items, dict):
            return
        old_item = old_items.get(str(old_key))
        if not isinstance(old_item, dict):
            return
        if old_item.get("validation") is not True:
            return
        old_item.pop("validation", None)
        cleanup_item(old_items, str(old_key))
        if old_folder == new_folder:
            new_item = ensure_item(old_items, str(new_key))
            new_item["validation"] = True
            self._write_sidecar(old_sidecar, old_data)
        else:
            new_sidecar = sidecar_path(new_folder)
            new_data = self._load_sidecar_for_write(new_sidecar)
            new_items = new_data.get("items")
            if not isinstance(new_items, dict):
                new_items = {}
                new_data["items"] = new_items
            new_item = ensure_item(new_items, str(new_key))
            new_item["validation"] = True
            self._write_sidecar(old_sidecar, old_data)
            self._write_sidecar(new_sidecar, new_data)
        self._invalidate_sidecar_caches()

    def _sidecar_reassign_notes(self, old_path: str | Path, new_path: str | Path, is_dir: bool) -> None:
        if is_dir:
            return
        old_folder, old_key = resolve_item_location(self.root, str(old_path))
        new_folder, new_key = resolve_item_location(self.root, str(new_path))
        if old_folder == new_folder and old_key == new_key:
            return
        old_sidecar = sidecar_path(old_folder)
        if not old_sidecar.exists():
            return
        old_data = self._load_sidecar_for_write(old_sidecar)
        old_items = old_data.get("items")
        if not isinstance(old_items, dict):
            return
        old_item = old_items.get(str(old_key))
        if not isinstance(old_item, dict):
            return
        notes = old_item.get("notes")
        if not isinstance(notes, list) or not notes:
            return
        old_item.pop("notes", None)
        cleanup_item(old_items, str(old_key))
        if old_folder == new_folder:
            new_item = ensure_item(old_items, str(new_key))
            existing = new_item.get("notes")
            if not isinstance(existing, list):
                existing = []
            new_item["notes"] = existing + notes
            self._write_sidecar(old_sidecar, old_data)
        else:
            new_sidecar = sidecar_path(new_folder)
            new_data = self._load_sidecar_for_write(new_sidecar)
            new_items = new_data.get("items")
            if not isinstance(new_items, dict):
                new_items = {}
                new_data["items"] = new_items
            new_item = ensure_item(new_items, str(new_key))
            existing = new_item.get("notes")
            if not isinstance(existing, list):
                existing = []
            new_item["notes"] = existing + notes
            self._write_sidecar(old_sidecar, old_data)
            self._write_sidecar(new_sidecar, new_data)

    def _sidecar_clear_path(self, relative: str | Path, fields: Iterable[str]) -> None:
        target = self._normalize_rel_path(relative)
        if not target or target == ".":
            return
        field_set = set(fields)
        touched = False
        for sidecar_file in self._iter_sidecar_files():
            data = self._load_sidecar_for_write(sidecar_file)
            items = data.get("items")
            if not isinstance(items, dict):
                continue
            changed = False
            for key, item in list(items.items()):
                if not isinstance(item, dict):
                    continue
                rel = self._relative_path_for_item(sidecar_file.parent, str(key))
                if not rel:
                    continue
                if rel == target or rel.startswith(f"{target}/"):
                    for field in field_set:
                        item.pop(field, None)
                    cleanup_item(items, str(key))
                    changed = True
            if changed:
                self._write_sidecar(sidecar_file, data)
                touched = True
        if touched and (field_set & {"tags", "validation"}):
            self._invalidate_sidecar_caches()


__all__ = ["MetadataService", "SidecarReadError"]
