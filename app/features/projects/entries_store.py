"""Task and note persistence scoped to projects."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from uuid import uuid4

from ...shared.atomic_write import atomic_write_json
ENTRY_KINDS = {"note", "task"}
PRIORITIES = {"high", "medium", "low", None}
STATUSES = {"none", "in_progress", "closed"}
REMINDER_MODES = {"on_end_date", "days_before_end_date"}
MAX_REMINDER_DAYS_BEFORE = 365
HEX_COLOR = re.compile(r"^#?[0-9a-fA-F]{6}$")


def _now() -> str:
    return datetime.utcnow().isoformat()


def _normalize_color(value: str | None) -> str | None:
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


def _normalize_priority(value: str | None) -> str | None:
    if value in PRIORITIES:
        return value
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in PRIORITIES:
        return text
    return None


def _normalize_status(value: str | None) -> str:
    if value is None:
        return "none"
    text = str(value).strip().lower()
    if text in STATUSES:
        return text
    return "none"


def _normalize_date(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_parent_identifier(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_reminder_mode(value: str | None) -> str:
    if value is None:
        return "on_end_date"
    text = str(value).strip().lower()
    if not text:
        return "on_end_date"
    if text in REMINDER_MODES:
        return text
    raise ValueError("Reminder mode must be 'on_end_date' or 'days_before_end_date'.")


def _normalize_reminder_days_before(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError("Reminder days before must be an integer between 1 and 365.")
    if isinstance(value, int):
        candidate = value
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            candidate = int(text)
        except ValueError as exc:
            raise ValueError("Reminder days before must be an integer between 1 and 365.") from exc
    else:
        raise ValueError("Reminder days before must be an integer between 1 and 365.")
    if candidate < 1 or candidate > MAX_REMINDER_DAYS_BEFORE:
        raise ValueError("Reminder days before must be an integer between 1 and 365.")
    return candidate


@dataclass
class ProjectNote:
    id: str
    text: str
    created_at: str
    updated_at: str
    priority: Optional[str] = None
    color: Optional[str] = None

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "text": self.text,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "priority": self.priority,
            "color": self.color,
        }

    @classmethod
    def from_payload(cls, payload: dict) -> "ProjectNote":
        if not isinstance(payload, dict):
            raise ValueError("Note payload must be an object.")
        note_id = payload.get("id") or f"note-{uuid4().hex[:8]}"
        text = str(payload.get("text", "")).strip()
        if not text:
            raise ValueError("Note text is required.")
        priority = _normalize_priority(payload.get("priority"))
        color = _normalize_color(payload.get("color"))
        created_at = payload.get("created_at") or _now()
        updated_at = payload.get("updated_at") or created_at
        return cls(
            id=str(note_id),
            text=text,
            created_at=created_at,
            updated_at=updated_at,
            priority=priority,
            color=color,
        )


@dataclass
class ProjectTask:
    id: str
    title: Optional[str]
    text: str
    created_at: str
    updated_at: str
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    auto_rollup_dates: bool = False
    priority: Optional[str] = None
    status: str = "none"
    color: Optional[str] = None
    parent_project_id: Optional[str] = None
    parent_task_id: Optional[str] = None
    reminder_enabled: bool = False
    reminder_mode: str = "on_end_date"
    reminder_days_before: Optional[int] = None

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "text": self.text,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "start_date": self.start_date,
            "end_date": self.end_date,
            "auto_rollup_dates": self.auto_rollup_dates,
            "priority": self.priority,
            "status": self.status,
            "color": self.color,
            "parent_project_id": self.parent_project_id,
            "parent_task_id": self.parent_task_id,
            "reminder_enabled": self.reminder_enabled,
            "reminder_mode": self.reminder_mode,
            "reminder_days_before": self.reminder_days_before,
        }

    @classmethod
    def from_payload(cls, payload: dict) -> "ProjectTask":
        if not isinstance(payload, dict):
            raise ValueError("Task payload must be an object.")
        task_id = payload.get("id") or f"task-{uuid4().hex[:8]}"
        text = str(payload.get("text", "")).strip()
        raw_title = payload.get("title", "")
        title = str(raw_title).strip() or None
        if not title:
            raise ValueError("Task title is required.")
        priority = _normalize_priority(payload.get("priority"))
        status = _normalize_status(payload.get("status"))
        start_date = _normalize_date(payload.get("start_date"))
        end_date = _normalize_date(payload.get("end_date"))
        auto_rollup_dates = bool(payload.get("auto_rollup_dates", False))
        color = _normalize_color(payload.get("color"))
        reminder_enabled = bool(payload.get("reminder_enabled", False))
        reminder_mode = _normalize_reminder_mode(payload.get("reminder_mode"))
        reminder_days_before = _normalize_reminder_days_before(payload.get("reminder_days_before"))
        if reminder_mode == "days_before_end_date" and reminder_days_before is None and reminder_enabled:
            raise ValueError("Reminder days before is required for days-before reminders.")
        if reminder_mode != "days_before_end_date":
            reminder_days_before = None
        if reminder_enabled and not end_date:
            raise ValueError("Add an end date to use reminders.")
        created_at = payload.get("created_at") or _now()
        updated_at = payload.get("updated_at") or created_at
        parent_project_id = _normalize_parent_identifier(payload.get("parent_project_id"))
        parent_task_id = _normalize_parent_identifier(payload.get("parent_task_id"))
        return cls(
            id=str(task_id),
            title=title,
            text=text,
            created_at=created_at,
            updated_at=updated_at,
            start_date=start_date,
            end_date=end_date,
            auto_rollup_dates=auto_rollup_dates,
            priority=priority,
            status=status,
            color=color,
            parent_project_id=parent_project_id,
            parent_task_id=parent_task_id,
            reminder_enabled=reminder_enabled,
            reminder_mode=reminder_mode,
            reminder_days_before=reminder_days_before,
        )


class ProjectEntryStore:
    """Persist tasks and notes per-project under the data directory."""

    def __init__(self, data_dir: Path):
        self._dir = Path(data_dir).expanduser().resolve()
        self._dir.mkdir(parents=True, exist_ok=True)
        self._file = self._dir / "project_entries.json"
        self._state: Dict[str, object] = {"version": 1, "projects": {}}
        self._load()

    def _load(self) -> None:
        if not self._file.exists():
            return
        try:
            raw = json.loads(self._file.read_text(encoding="utf-8"))
        except Exception:
            raw = {}
        if isinstance(raw, dict):
            self._state.update(raw)
            if "projects" not in self._state or not isinstance(self._state["projects"], dict):
                self._state["projects"] = {}

    def _save(self) -> None:
        atomic_write_json(self._file, self._state, ensure_ascii=False, indent=2)

    def _ensure_project(self, project_id: str) -> dict:
        projects = self._state.setdefault("projects", {})
        assert isinstance(projects, dict)
        if project_id not in projects or not isinstance(projects[project_id], dict):
            projects[project_id] = {"notes": [], "tasks": []}
        bucket = projects[project_id]
        bucket.setdefault("notes", [])
        bucket.setdefault("tasks", [])
        return bucket

    def _task_lookup(self, project_id: str, task_id: str | None) -> Optional[dict]:
        if not task_id:
            return None
        bucket = self._ensure_project(project_id)
        tasks = bucket.get("tasks", [])
        for task in tasks:
            if task.get("id") == task_id:
                return task
        return None

    @staticmethod
    def _task_with_defaults(task: dict) -> dict:
        cleaned = dict(task)
        if "auto_rollup_dates" not in cleaned:
            cleaned["auto_rollup_dates"] = False
        if "parent_project_id" not in cleaned:
            cleaned["parent_project_id"] = None
        if "parent_task_id" not in cleaned:
            cleaned["parent_task_id"] = None
        if "reminder_enabled" not in cleaned:
            cleaned["reminder_enabled"] = False
        if "reminder_mode" not in cleaned:
            cleaned["reminder_mode"] = "on_end_date"
        if "reminder_days_before" not in cleaned:
            cleaned["reminder_days_before"] = None
        return cleaned

    def _validate_parent_reference(
        self,
        project_id: str,
        task_id: str,
        payload: dict,
        project_store,
    ) -> Tuple[Optional[str], Optional[str]]:
        parent_project_raw = payload.get("parent_project_id")
        parent_task_raw = payload.get("parent_task_id")
        parent_project_id = _normalize_parent_identifier(parent_project_raw)
        parent_task_id = _normalize_parent_identifier(parent_task_raw)

        if parent_project_id is None and parent_task_id is None:
            return None, None
        if parent_task_id and not parent_project_id:
            parent_project_id = project_id
        if parent_project_id and not parent_task_id:
            raise ValueError("parent_task_id is required when setting a parent.")
        try:
            project_store.get_project(parent_project_id)  # type: ignore[arg-type]
        except Exception as exc:  # pragma: no cover - defensive
            raise ValueError("Parent project was not found.") from exc
        parent_task = self._task_lookup(parent_project_id, parent_task_id)
        if not parent_task:
            raise ValueError("Parent task was not found.")
        if parent_project_id == project_id and parent_task_id == task_id:
            raise ValueError("A task cannot be its own parent.")
        if self._would_create_task_cycle(project_id, task_id, parent_project_id, parent_task_id):
            raise ValueError("Parent relationship would create a cycle.")
        return parent_project_id, parent_task_id

    def _would_create_task_cycle(
        self,
        project_id: str,
        task_id: str,
        parent_project_id: Optional[str],
        parent_task_id: Optional[str],
    ) -> bool:
        """Walk parent links to ensure we never point back to (project_id, task_id)."""

        if not parent_project_id or not parent_task_id:
            return False
        target = (project_id, task_id)
        cursor = (parent_project_id, parent_task_id)
        visited: set[Tuple[str, str]] = set()
        while cursor[0] and cursor[1]:
            if cursor == target:
                return True
            if cursor in visited:
                # Existing malformed loop detected.
                return True
            visited.add(cursor)
            current = self._task_lookup(cursor[0], cursor[1])
            if not current:
                break
            cursor = (
                _normalize_parent_identifier(current.get("parent_project_id")) or cursor[0],
                _normalize_parent_identifier(current.get("parent_task_id")),
            )
        return False

    def _apply_parent_validation(
        self,
        project_id: str,
        task_id: str,
        payload: dict,
        project_store,
    ) -> dict:
        parent_project_id, parent_task_id = self._validate_parent_reference(project_id, task_id, payload, project_store)
        cleaned = dict(payload)
        cleaned["parent_project_id"] = parent_project_id
        cleaned["parent_task_id"] = parent_task_id
        return cleaned

    def _clear_task_parent_links(self, project_id: str, task_id: str, *, persist: bool = True) -> None:
        """Remove parent references to the deleted task across all projects."""

        projects = self._state.get("projects", {})
        if not isinstance(projects, dict):
            return
        changed = False
        for bucket in projects.values():
            tasks = bucket.get("tasks", [])
            for task in tasks:
                if (
                    _normalize_parent_identifier(task.get("parent_project_id")) == project_id
                    and _normalize_parent_identifier(task.get("parent_task_id")) == task_id
                ):
                    task["parent_project_id"] = None
                    task["parent_task_id"] = None
                    changed = True
        if changed and persist:
            self._save()

    @staticmethod
    def normalize_kind(kind: str | None) -> str:
        text = (kind or "note").strip().lower()
        if text not in ENTRY_KINDS:
            raise ValueError("Entry type must be 'note' or 'task'.")
        return text

    def list_entries(self, project_id: str, kind: Optional[str] = None) -> dict:
        bucket = self._ensure_project(project_id)
        if kind:
            normalized = self.normalize_kind(kind)
            if normalized == "task":
                tasks = [self._task_with_defaults(entry) for entry in bucket.get("tasks", [])]
                return {"task": tasks}
            return {normalized: list(bucket.get(f"{normalized}s", []))}
        return {
            "note": list(bucket.get("notes", [])),
            "task": [self._task_with_defaults(entry) for entry in bucket.get("tasks", [])],
        }

    def add_entry(
        self,
        project_id: str,
        kind: str,
        payload: dict,
        project_store=None,
        *,
        persist: bool = True,
    ) -> dict:
        bucket = self._ensure_project(project_id)
        normalized = self.normalize_kind(kind)
        if normalized == "note":
            entry = ProjectNote.from_payload(payload).as_dict()
            bucket.setdefault("notes", []).insert(0, entry)
        else:
            if project_store is None:
                raise ValueError("Project store is required to validate parent tasks.")
            task_id = str(payload.get("id") or f"task-{uuid4().hex[:8]}")
            validated_payload = self._apply_parent_validation(project_id, task_id, payload, project_store)
            validated_payload["id"] = task_id
            entry = ProjectTask.from_payload(validated_payload).as_dict()
            bucket.setdefault("tasks", []).insert(0, entry)
        if persist:
            self._save()
        return entry

    def update_entry(
        self,
        project_id: str,
        entry_id: str,
        kind: str,
        payload: dict,
        project_store=None,
        *,
        persist: bool = True,
    ) -> dict:
        bucket = self._ensure_project(project_id)
        normalized = self.normalize_kind(kind)
        entries = bucket.get("notes" if normalized == "note" else "tasks", [])
        for index, entry in enumerate(entries):
            if entry.get("id") != entry_id:
                continue
            merged = {**entry, **payload, "id": entry_id}
            if normalized == "note":
                # Strip legacy fields no longer used for notes
                merged.pop("status", None)
                merged.pop("deadline", None)
                updated = ProjectNote.from_payload(merged).as_dict()
            else:
                if project_store is None:
                    raise ValueError("Project store is required to validate parent tasks.")
                validated = self._apply_parent_validation(project_id, entry_id, merged, project_store)
                updated = ProjectTask.from_payload(validated).as_dict()
            entries[index] = updated
            if persist:
                self._save()
            return updated
        raise KeyError(f"{normalized.title()} '{entry_id}' not found.")

    def delete_entry(
        self,
        project_id: str,
        entry_id: str,
        kind: str,
        *,
        persist: bool = True,
    ) -> None:
        bucket = self._ensure_project(project_id)
        normalized = self.normalize_kind(kind)
        key = "notes" if normalized == "note" else "tasks"
        entries = bucket.get(key, [])
        before = len(entries)
        entries[:] = [entry for entry in entries if entry.get("id") != entry_id]
        if len(entries) != before:
            if persist:
                self._save()
            if normalized == "task":
                self._clear_task_parent_links(project_id, entry_id, persist=persist)
            return
        raise KeyError(f"{normalized.title()} '{entry_id}' not found.")
