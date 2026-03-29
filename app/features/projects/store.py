"""Project persistence and validation helpers for QualiFile."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional
from uuid import uuid4

from ...shared.atomic_write import atomic_write_json

def _now() -> str:
    return datetime.utcnow().isoformat()


def _normalize_name(name: str) -> str:
    cleaned = (name or "").strip()
    if not cleaned:
        raise ValueError("Project name is required.")
    if len(cleaned) > 200:
        raise ValueError("Project name must be 200 characters or fewer.")
    return cleaned


def _normalize_description(value: Optional[str]) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return text[:2000]


def _normalize_root_path(value: Optional[str | Path]) -> Optional[str]:
    if value is None:
        return None
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError("Root path must be an absolute directory path.")
    resolved = path.resolve()
    if not resolved.exists() or not resolved.is_dir():
        raise ValueError("Root path does not exist or is not a directory.")
    return str(resolved)


def _normalize_parent(parent_id: Optional[str]) -> Optional[str]:
    if parent_id is None:
        return None
    text = str(parent_id).strip()
    return text or None


ALLOWED_STATUSES = {"new", "ongoing", "completed"}
ENTRY_MODES = {"note", "task", "both"}
MISSING = object()


def _normalize_status(status: Optional[str]) -> str:
    if status is None:
        return "new"
    text = str(status).strip().lower()
    if not text:
        return "new"
    if text not in ALLOWED_STATUSES:
        raise ValueError("Status must be one of: new, ongoing, or completed.")
    return text


def _normalize_entry_mode(mode: Optional[str]) -> str:
    if mode is None:
        return "note"
    text = str(mode).strip().lower()
    if text in ENTRY_MODES:
        return text
    return "note"


def _normalize_color(color: Optional[str]) -> Optional[str]:
    if color is None:
        return None
    text = str(color).strip()
    if not text:
        return None
    if text.startswith("#"):
        text = text[1:]
    if len(text) not in {3, 6}:
        raise ValueError("Colour must be a 3 or 6 character hex code.")
    if not all(ch.lower() in "0123456789abcdef" for ch in text):
        raise ValueError("Colour must be a valid hex value.")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    return f"#{text.lower()}"


@dataclass
class Project:
    id: str
    name: str
    description: str
    parent_id: Optional[str]
    root_path: Optional[str]
    created_at: str
    updated_at: str
    status: str = "new"
    color: Optional[str] = None
    entry_mode: str = "note"

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "parent_id": self.parent_id,
            "root_path": self.root_path,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "status": self.status,
            "color": self.color,
            "entry_mode": self.entry_mode,
        }


class ProjectStore:
    """Encapsulates project CRUD backed by a JSON file under the data directory."""

    def __init__(self, data_dir: Path):
        self._dir = Path(data_dir).expanduser().resolve()
        self._dir.mkdir(parents=True, exist_ok=True)
        self._file = self._dir / "projects.json"
        self._state: Dict[str, object] = {"version": 1, "projects": []}
        self._load()

    @property
    def projects(self) -> List[dict]:
        return [project.copy() for project in self._state.get("projects", [])]  # type: ignore[return-value]

    def list_projects(self) -> List[dict]:
        projects = self.projects
        projects.sort(key=lambda p: p.get("name", "").lower())
        return projects

    def get_project(self, project_id: str) -> dict:
        for project in self.projects:
            if project.get("id") == project_id:
                return project
        raise KeyError(f"Project '{project_id}' was not found.")

    def create_project(
        self,
        *,
        name: str,
        description: Optional[str] = None,
        parent_id: Optional[str] = None,
        root_path: Optional[str | Path] = None,
        status: Optional[str] = None,
        color: Optional[str] = None,
        entry_mode: Optional[str] = None,
        persist: bool = True,
    ) -> dict:
        cleaned_name = _normalize_name(name)
        cleaned_description = _normalize_description(description)
        cleaned_parent = _normalize_parent(parent_id)
        cleaned_root = _normalize_root_path(root_path)
        cleaned_status = _normalize_status(status)
        cleaned_color = _normalize_color(color)
        cleaned_entry_mode = _normalize_entry_mode(entry_mode)
        if cleaned_parent and not self._exists(cleaned_parent):
            raise ValueError("Parent project does not exist.")
        if cleaned_parent and cleaned_color is None:
            try:
                parent = self.get_project(cleaned_parent)
                cleaned_color = _normalize_color(parent.get("color"))
            except Exception:
                cleaned_color = None
        project_id = f"proj-{uuid4().hex[:8]}"
        if cleaned_parent and self._would_create_cycle(project_id, cleaned_parent):
            raise ValueError("Parent relationship would create a cycle.")
        timestamp = _now()
        project = Project(
            id=project_id,
            name=cleaned_name,
            description=cleaned_description,
            parent_id=cleaned_parent,
            root_path=cleaned_root,
            created_at=timestamp,
            updated_at=timestamp,
            status=cleaned_status,
            color=cleaned_color,
            entry_mode=cleaned_entry_mode,
        )
        self._state.setdefault("projects", []).append(project.as_dict())
        if persist:
            self._save()
        return project.as_dict()

    def update_project(
        self,
        project_id: str,
        *,
        name: Optional[str] = None,
        description: Optional[str] = None,
        parent_id: object = MISSING,
        root_path: Optional[str | Path] = None,
        status: Optional[str] = None,
        color: Optional[str] = None,
        entry_mode: Optional[str] = None,
        persist: bool = True,
    ) -> dict:
        project = self._find(project_id)
        if name is not None:
            project["name"] = _normalize_name(name)
        if description is not None:
            project["description"] = _normalize_description(description)
        if root_path is not None:
            project["root_path"] = _normalize_root_path(root_path)
        if status is not None:
            project["status"] = _normalize_status(status)
        if color is not None:
            project["color"] = _normalize_color(color)
        if entry_mode is not None:
            project["entry_mode"] = _normalize_entry_mode(entry_mode)
        if parent_id is not MISSING:
            cleaned_parent = _normalize_parent(parent_id)
            if cleaned_parent:
                if cleaned_parent == project_id:
                    raise ValueError("A project cannot be its own parent.")
                if not self._exists(cleaned_parent):
                    raise ValueError("Parent project does not exist.")
                if self._would_create_cycle(project_id, cleaned_parent):
                    raise ValueError("Parent relationship would create a cycle.")
            project["parent_id"] = cleaned_parent
        project["updated_at"] = _now()
        if persist:
            self._save()
        return project.copy()

    def delete_project(self, project_id: str, *, cascade: bool = False, persist: bool = True) -> None:
        if not self._exists(project_id):
            raise KeyError(f"Project '{project_id}' was not found.")
        children = self._children_of(project_id)
        if children and not cascade:
            raise ValueError("Delete blocked: project has subprojects.")
        to_remove = {project_id}
        if cascade:
            to_remove.update(self._descendants_of(project_id))
        filtered = [p for p in self._state.get("projects", []) if p.get("id") not in to_remove]
        self._state["projects"] = filtered
        if persist:
            self._save()

    def _exists(self, project_id: str) -> bool:
        try:
            self._find(project_id)
            return True
        except KeyError:
            return False

    def _find(self, project_id: str) -> dict:
        for project in self._state.get("projects", []):
            if project.get("id") == project_id:
                return project
        raise KeyError(f"Project '{project_id}' was not found.")

    def _children_of(self, project_id: str) -> List[str]:
        return [
            project.get("id")
            for project in self._state.get("projects", [])
            if project.get("parent_id") == project_id
        ]

    def _descendants_of(self, project_id: str) -> List[str]:
        descendants = []
        queue = [project_id]
        while queue:
            current = queue.pop(0)
            children = self._children_of(current)
            descendants.extend(children)
            queue.extend(children)
        return descendants

    def _would_create_cycle(self, project_id: str, new_parent_id: str) -> bool:
        current = new_parent_id
        visited = {project_id}
        while current:
            if current in visited:
                return True
            visited.add(current)
            try:
                parent = self._find(current).get("parent_id")
            except KeyError:
                return False
            current = parent
        return False

    def _load(self) -> None:
        if not self._file.exists():
            self._state = {"version": 1, "projects": []}
            return
        try:
            raw = json.loads(self._file.read_text())
        except Exception:
            self._state = {"version": 1, "projects": []}
            return
        projects = raw.get("projects")
        cleaned: List[dict] = []
        seen_ids = set()
        if isinstance(projects, list):
            for entry in projects:
                if not isinstance(entry, dict):
                    continue
                project_id = entry.get("id")
                name = entry.get("name")
                if not isinstance(project_id, str) or project_id in seen_ids:
                    continue
                try:
                    status_value = _normalize_status(entry.get("status"))
                except ValueError:
                    status_value = "new"
                try:
                    cleaned.append({
                        "id": project_id,
                        "name": _normalize_name(name),
                        "description": _normalize_description(entry.get("description")),
                        "parent_id": _normalize_parent(entry.get("parent_id")),
                        "root_path": _normalize_root_path(entry.get("root_path")),
                        "created_at": entry.get("created_at") or _now(),
                        "updated_at": entry.get("updated_at") or _now(),
                        "status": status_value,
                        "color": _normalize_color(entry.get("color")),
                        "entry_mode": _normalize_entry_mode(entry.get("entry_mode")),
                    })
                    seen_ids.add(project_id)
                except ValueError:
                    continue
        self._state = {"version": 1, "projects": cleaned}

    def _save(self) -> None:
        payload = {"version": 1, "projects": self._state.get("projects", [])}
        atomic_write_json(self._file, payload, indent=2, sort_keys=True)


__all__ = ["ProjectStore", "Project", "MISSING"]
