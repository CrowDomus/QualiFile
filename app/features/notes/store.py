"""Local note storage for files and folders."""

from __future__ import annotations

import json
import re
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
from uuid import uuid4

from ..filesystem.service import PathOutsideRootError, is_within_root, resolve_within_root
from ...shared.atomic_write import atomic_write_json

NOTES_FILENAME = ".qualifile_notes.json"

PRIORITIES = {"high", "medium", "low", None}
STATUSES = {"none", "in_progress", "closed"}
HEX_COLOR = re.compile(r"^#?[0-9a-fA-F]{6}$")


def _normalize_path(value: str | Path | None) -> str:
    text = str(value or ".").replace("\\", "/")
    text = re.sub(r"^(\./)+", "", text)
    text = text.strip("/")
    return text or "."


def _now() -> str:
    return datetime.utcnow().isoformat()


def _normalize_color(value: str | None) -> str | None:
    """Return a normalized 6-char hex color (uppercase) or None."""

    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if not HEX_COLOR.match(text):
        raise ValueError("Invalid color format. Use a 6-digit hex value.")
    if not text.startswith("#"):
        text = f"#{text}"
    return text.upper()


@dataclass
class Note:
    """Represents a single note entry."""

    id: str
    text: str
    created_at: str
    updated_at: str
    deadline: Optional[str] = None
    priority: Optional[str] = None
    status: str = "none"
    color: Optional[str] = None

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "text": self.text,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "deadline": self.deadline,
            "priority": self.priority,
            "status": self.status,
            "color": self.color,
        }

    @classmethod
    def from_raw(cls, payload: dict) -> Optional["Note"]:
        if not isinstance(payload, dict):
            return None
        note_id = payload.get("id")
        text = payload.get("text", "")
        created = payload.get("created_at") or payload.get("created")
        updated = payload.get("updated_at") or payload.get("updated")
        if not isinstance(note_id, str) or not note_id.strip():
            return None
        if not isinstance(text, str) or not text.strip():
            return None
        priority = payload.get("priority")
        if priority not in PRIORITIES:
            priority = None
        status = payload.get("status") or "none"
        if status not in STATUSES:
            status = "none"
        deadline = payload.get("deadline")
        if isinstance(deadline, str) and deadline.strip():
            deadline = deadline.strip()
        else:
            deadline = None
        color = payload.get("color")
        try:
            color_value = _normalize_color(color)
        except ValueError:
            color_value = None
        created_at = created if isinstance(created, str) and created.strip() else _now()
        updated_at = updated if isinstance(updated, str) and updated.strip() else created_at
        return cls(
            id=str(note_id),
            text=text.strip(),
            created_at=created_at,
            updated_at=updated_at,
            deadline=deadline,
            priority=priority,
            status=status,
            color=color_value,
        )


class NoteStore:
    """Encapsulates reading/writing notes stored alongside folders."""

    def __init__(self, root: Path):
        self.root = Path(root)

    @staticmethod
    def normalize_path(value: str | Path | None) -> str:
        return _normalize_path(value)

    def _resolve(self, relative: str, *, require_exists: bool = True) -> Path:
        """Resolve a relative path within the root."""

        try:
            return resolve_within_root(self.root, relative)
        except FileNotFoundError:
            if not require_exists:
                candidate = (self.root / relative).resolve()
                base = self.root.resolve()
                if not is_within_root(base, candidate):
                    raise PathOutsideRootError(f"Path '{candidate}' escapes root '{self.root}'.")
                return candidate
            raise

    def _container_location(self, relative: str, *, require_exists: bool = True) -> Tuple[Path, str]:
        """Return the folder to store notes and the container key."""

        target = self._resolve(relative, require_exists=require_exists)
        if target.is_dir():
            folder = target
            key = "."
        else:
            folder = target.parent
            key = target.name
        return folder, key

    def _notes_file(self, folder: Path) -> Path:
        return Path(folder) / NOTES_FILENAME

    def _read_folder_notes(self, folder: Path) -> Dict[str, object]:
        notes_file = self._notes_file(folder)
        state = {"version": 1, "containers": {}}
        if notes_file.exists():
            try:
                raw = json.loads(notes_file.read_text())
                if isinstance(raw, dict):
                    containers = raw.get("containers", {})
                    if isinstance(containers, dict):
                        cleaned = {}
                        for key, container in containers.items():
                            cleaned[key] = self._normalize_container(container)
                        state["containers"] = cleaned
            except Exception:
                # Corrupt files are treated as empty but left intact.
                pass
        return state

    def _normalize_container(self, container: object) -> dict:
        if not isinstance(container, dict):
            return {"path": ".", "notes": []}
        notes_raw = container.get("notes", [])
        normalized: List[dict] = []
        if isinstance(notes_raw, list):
            for entry in notes_raw:
                note = Note.from_raw(entry)
                if note:
                    normalized.append(note.as_dict())
        return {
            "path": container.get("path") or ".",
            "notes": normalized,
        }

    def _write_folder_notes(self, folder: Path, state: Dict[str, object]) -> None:
        folder_path = Path(folder)
        folder_path.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "containers": state.get("containers", {})}
        notes_file = self._notes_file(folder_path)
        atomic_write_json(notes_file, payload, indent=2, sort_keys=True)

    def get_notes(self, relative: str) -> List[dict]:
        folder, key = self._container_location(relative, require_exists=False)
        state = self._read_folder_notes(folder)
        if key == ".":
            missing_children = []
            for child_key, container in list(state["containers"].items()):
                if child_key == ".":
                    continue
                target = folder / child_key
                if not target.exists():
                    if container.get("notes"):
                        missing_children.append(child_key)
            if missing_children:
                fallback = state["containers"].get(".", {"path": ".", "notes": []})
                for child in missing_children:
                    fallback["notes"].extend(state["containers"][child].get("notes", []))
                    state["containers"].pop(child, None)
                state["containers"]["."] = fallback
                self._write_folder_notes(folder, state)
        container = state["containers"].get(key, {"path": key, "notes": []})
        # Auto-prune notes pointing to missing files when appropriate
        if key != ".":
            target = folder / key
            if not target.exists() and container["notes"]:
                # Fallback to folder container if the file is gone
                fallback = state["containers"].get(".", {"path": ".", "notes": []})
                fallback["notes"].extend(container["notes"])
                state["containers"]["."] = fallback
                state["containers"].pop(key, None)
                self._write_folder_notes(folder, state)
                return fallback["notes"]
        state["containers"][key] = container
        return container.get("notes", [])

    def add_note(
        self,
        relative: str,
        *,
        text: str,
        deadline: Optional[str] = None,
        priority: Optional[str] = None,
        status: str = "none",
        color: Optional[str] = None,
    ) -> dict:
        cleaned_text = (text or "").strip()
        if not cleaned_text:
            raise ValueError("Note text cannot be empty.")
        folder, key = self._container_location(relative)
        state = self._read_folder_notes(folder)
        container = state["containers"].get(key, {"path": key, "notes": []})
        priority_value = priority if priority in PRIORITIES else None
        status_value = status if status in STATUSES else "none"
        color_value = _normalize_color(color)
        now = _now()
        note = Note(
            id=f"note-{uuid4().hex[:12]}",
            text=cleaned_text,
            created_at=now,
            updated_at=now,
            deadline=deadline.strip() if isinstance(deadline, str) and deadline.strip() else None,
            priority=priority_value,
            status=status_value,
            color=color_value,
        )
        container["notes"] = [note.as_dict()] + container.get("notes", [])
        state["containers"][key] = container
        self._write_folder_notes(folder, state)
        return note.as_dict()

    def update_note(
        self,
        relative: str,
        note_id: str,
        *,
        text: Optional[str] = None,
        deadline: Optional[str] = None,
        priority: Optional[str] = None,
        status: Optional[str] = None,
        color: Optional[str] = None,
    ) -> dict:
        folder, key = self._container_location(relative)
        state = self._read_folder_notes(folder)
        container = state["containers"].get(key)
        if not container:
            raise KeyError("Note not found.")
        updated = False
        for note in container.get("notes", []):
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
                note["updated_at"] = _now()
                break
        else:
            raise KeyError("Note not found.")
        state["containers"][key] = container
        self._write_folder_notes(folder, state)
        return note

    def delete_note(self, relative: str, note_id: str) -> None:
        folder, key = self._container_location(relative, require_exists=False)
        state = self._read_folder_notes(folder)
        container = state["containers"].get(key)
        if not container:
            return
        before = list(container.get("notes", []))
        container["notes"] = [note for note in before if note.get("id") != note_id]
        if container["notes"]:
            state["containers"][key] = container
        else:
            state["containers"].pop(key, None)
        self._write_folder_notes(folder, state)

    def reassign_path(self, old_path: str, new_path: str) -> None:
        old_folder, old_key = self._container_location(old_path, require_exists=False)
        new_folder, new_key = self._container_location(new_path, require_exists=False)
        if old_folder == new_folder and old_key == new_key:
            return
        state_old = self._read_folder_notes(old_folder)
        container = state_old["containers"].get(old_key)
        if not container or not container.get("notes"):
            return
        notes_to_move = container.get("notes", [])
        state_old["containers"].pop(old_key, None)
        self._write_folder_notes(old_folder, state_old)

        state_new = self._read_folder_notes(new_folder)
        target_container = state_new["containers"].get(new_key, {"path": new_key, "notes": []})
        target_container["notes"].extend(notes_to_move)
        state_new["containers"][new_key] = target_container
        self._write_folder_notes(new_folder, state_new)

    def clear_path(self, relative: str) -> None:
        normalized = _normalize_path(relative)
        target = self._resolve(normalized, require_exists=False)
        if target.is_dir():
            notes_file = self._notes_file(target)
            with suppress(FileNotFoundError):
                notes_file.unlink()
            return
        folder, key = self._container_location(normalized, require_exists=False)
        state = self._read_folder_notes(folder)
        if key in state["containers"]:
            state["containers"].pop(key, None)
            self._write_folder_notes(folder, state)

    def summarize(self, notes: Iterable[dict]) -> dict:
        """Return quick summary flags for badge rendering."""

        now = datetime.utcnow()
        has_high = False
        overdue = False
        open_count = 0
        closed_count = 0
        has_status = False
        for note in notes:
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
                with suppress(Exception):
                    deadline_dt = datetime.fromisoformat(deadline_raw.replace("Z", "+00:00"))
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

    def has_descendant_notes(self, relative: str) -> bool:
        """Return True if any note exists under ``relative`` (including children)."""

        target = self._resolve(relative, require_exists=False)
        if not target.exists():
            return False
        dirty: list[tuple[Path, dict]] = []
        try:
            for notes_file in target.rglob(NOTES_FILENAME):
                if notes_file.parent == target:
                    continue
                try:
                    raw = json.loads(notes_file.read_text())
                except Exception:
                    continue
                if not isinstance(raw, dict):
                    continue
                containers = raw.get("containers", {})
                if not isinstance(containers, dict):
                    continue
                stale = []
                for key, container in containers.items():
                    if not isinstance(container, dict):
                        continue
                    notes = container.get("notes") if isinstance(container.get("notes"), list) else []
                    if not notes:
                        continue
                    normalized_key = (key or ".").strip() or "."
                    if normalized_key == ".":
                        continue
                    candidate = (notes_file.parent / normalized_key).resolve()
                    if candidate.exists():
                        return True
                    stale.append(key)
                if stale:
                    for key in stale:
                        containers.pop(key, None)
                    dirty.append((notes_file, raw))
        except Exception:
            return False
        for notes_file, raw in dirty:
            try:
                atomic_write_json(notes_file, raw, indent=2, sort_keys=True)
            except Exception:
                continue
        return False

    def has_descendant_open_notes(self, relative: str) -> bool:
        """Return True if any non-closed note exists under ``relative`` (including children)."""

        target = self._resolve(relative, require_exists=False)
        if not target.exists():
            return False
        target_resolved = target.resolve()
        try:
            for notes_file in target.rglob(NOTES_FILENAME):
                try:
                    raw = json.loads(notes_file.read_text())
                except Exception:
                    continue
                if not isinstance(raw, dict):
                    continue
                containers = raw.get("containers", {})
                if not isinstance(containers, dict):
                    continue
                is_root_notes = notes_file.parent.resolve() == target_resolved
                for key, container in containers.items():
                    if not isinstance(container, dict):
                        continue
                    if is_root_notes and key == ".":
                        continue
                    notes = container.get("notes") if isinstance(container.get("notes"), list) else []
                    if any((note.get("status") or "none") != "closed" for note in notes if isinstance(note, dict)):
                        return True
        except Exception:
            return False
        return False


__all__ = ["NoteStore", "NOTES_FILENAME", "PRIORITIES", "STATUSES"]
