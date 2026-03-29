"""Persistent tag (category) management for QualiFile."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, Iterable, List, Optional
from uuid import uuid4

from ...shared.atomic_write import atomic_write_json
MAX_TAGS = 50
TAGS_FILENAME = ".qualifile_tags.json"
_NO_CHANGE = object()
COLOR_PATTERN = re.compile(r"^#([0-9a-fA-F]{6})$")
DEFAULT_COLORS = [
    "#e57373",
    "#f06292",
    "#ba68c8",
    "#9575cd",
    "#7986cb",
    "#64b5f6",
    "#4fc3f7",
    "#4dd0e1",
    "#4db6ac",
    "#81c784",
    "#aed581",
    "#dce775",
    "#fff176",
    "#ffd54f",
    "#ffb74d",
    "#ff8a65",
    "#a1887f",
    "#90a4ae",
    "#8d6e63",
    "#ce93d8",
]


def _normalize_color(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if not text.startswith("#"):
        text = f"#{text}"
    if not COLOR_PATTERN.match(text):
        raise ValueError("Color must be a hex value like #A1B2C3.")
    return text.lower()


def _normalize_name(name: str) -> str:
    cleaned = (name or "").strip()
    if not cleaned:
        raise ValueError("Tag name cannot be empty.")
    if len(cleaned) > 60:
        raise ValueError("Tag names must be 60 characters or fewer.")
    return cleaned


def _normalize_path(value: str | Path | None) -> str:
    if value is None:
        return "."
    text = str(value).strip()
    if not text or text == ".":
        return "."
    text = text.replace("\\", "/")
    text = re.sub(r"^(\./)+", "", text)
    text = text.strip("/")
    return text or "."


def _normalize_show_header(value: object) -> bool:
    if value is None:
        return True
    return bool(value)


class TagStore:
    """Encapsulates reading/writing the on-disk tag state."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self._file = self.root / TAGS_FILENAME
        self._state: Dict[str, object] = {"tags": [], "assignments": {}}
        self._dirty = False
        self._load()

    @staticmethod
    def normalize_path(value: str | Path | None) -> str:
        return _normalize_path(value)

    @property
    def tags(self) -> List[dict]:
        return list(self._state["tags"])

    @property
    def assignments(self) -> Dict[str, List[str]]:
        return dict(self._state["assignments"])

    def _load(self) -> None:
        if self._file.exists():
            try:
                raw = json.loads(self._file.read_text())
            except Exception:
                raw = {}
        else:
            raw = {}
        tags = raw.get("tags") if isinstance(raw.get("tags"), list) else []
        assignments = raw.get("assignments") if isinstance(raw.get("assignments"), dict) else {}
        normalized_tags = []
        seen_ids = set()
        for entry in tags:
            if not isinstance(entry, dict):
                continue
            tag_id = entry.get("id")
            name = entry.get("name")
            color = entry.get("color")
            show_header = _normalize_show_header(entry.get("show_header", True))
            parent_id = entry.get("parent_id")
            if not tag_id or not isinstance(tag_id, str):
                continue
            if tag_id in seen_ids:
                continue
            try:
                normalized_tags.append({
                    "id": tag_id,
                    "name": _normalize_name(str(name)),
                    "color": _normalize_color(color) or self._fallback_color(len(normalized_tags)),
                    "show_header": show_header,
                    "parent_id": parent_id if isinstance(parent_id, str) else None,
                })
                seen_ids.add(tag_id)
            except ValueError:
                continue
        self._state["tags"] = normalized_tags
        cleaned_assignments: Dict[str, List[str]] = {}
        valid_ids = {tag["id"] for tag in normalized_tags}
        for raw_path, raw_tags in assignments.items():
            if not isinstance(raw_path, str):
                continue
            normalized_path = _normalize_path(raw_path)
            if not normalized_path or normalized_path == ".":
                continue
            if isinstance(raw_tags, list):
                filtered = [tag_id for tag_id in raw_tags if tag_id in valid_ids]
            else:
                filtered = []
            if filtered:
                cleaned_assignments[normalized_path] = sorted(set(filtered))
        self._state["assignments"] = cleaned_assignments

    def save(self) -> None:
        if not self._dirty:
            return
        payload = {
            "tags": self._state["tags"],
            "assignments": self._state["assignments"],
        }
        atomic_write_json(self._file, payload, indent=2, sort_keys=True)
        self._dirty = False

    def _ensure_limit(self) -> None:
        if len(self._state["tags"]) >= MAX_TAGS:
            raise ValueError(f"Maximum of {MAX_TAGS} tags reached.")

    def _fallback_color(self, index: int) -> str:
        palette = [color.lower() for color in DEFAULT_COLORS]
        used = {tag["color"] for tag in self._state["tags"] if tag.get("color")}
        for color in palette:
            if color not in used:
                return color
        return DEFAULT_COLORS[index % len(DEFAULT_COLORS)].lower()

    def _validate_parent(self, parent_id: Optional[str], tag_id: Optional[str] = None) -> Optional[str]:
        if parent_id in (None, "", False):
            return None
        if not isinstance(parent_id, str):
            raise ValueError("Invalid parent tag.")
        if tag_id and parent_id == tag_id:
            raise ValueError("A tag cannot be its own parent.")
        ids = {tag["id"] for tag in self._state["tags"]}
        if parent_id not in ids:
            raise ValueError("Parent tag not found.")
        # cycle detection
        def ancestors(candidate: str) -> Iterable[str]:
            current = candidate
            visited = set()
            while True:
                if current in visited:
                    break
                visited.add(current)
                parent = None
                for t in self._state["tags"]:
                    if t["id"] == current:
                        parent = t.get("parent_id")
                        break
                if not parent:
                    break
                yield parent
                current = parent

        for ancestor in ancestors(parent_id):
            if tag_id and ancestor == tag_id:
                raise ValueError("Invalid parent: would create a cycle.")
        return parent_id

    def create_tag(self, name: str, color: Optional[str] = None, parent_id: Optional[str] = None) -> dict:
        self._ensure_limit()
        cleaned_name = _normalize_name(name)
        if any(tag["name"].lower() == cleaned_name.lower() for tag in self._state["tags"]):
            raise ValueError("A tag with that name already exists.")
        normalized_color = _normalize_color(color) or self._fallback_color(len(self._state["tags"]))
        normalized_parent = self._validate_parent(parent_id)
        tag_id = f"tag-{uuid4().hex[:8]}"
        tag = {"id": tag_id, "name": cleaned_name, "color": normalized_color, "show_header": True, "parent_id": normalized_parent}
        self._state["tags"].append(tag)
        self._dirty = True
        return tag

    def update_tag(
        self,
        tag_id: str,
        *,
        name: Optional[str] = None,
        color: Optional[str] = None,
        show_header: Optional[bool] = None,
        parent_id: object = _NO_CHANGE,
    ) -> dict:
        tag = self._find_tag(tag_id)
        if name is not None:
            cleaned_name = _normalize_name(name)
            if any(
                other["id"] != tag_id and other["name"].lower() == cleaned_name.lower()
                for other in self._state["tags"]
            ):
                raise ValueError("Another tag already uses that name.")
            tag["name"] = cleaned_name
            self._dirty = True
        if color is not None:
            tag["color"] = _normalize_color(color) or self._fallback_color(0)
            self._dirty = True
        if show_header is not None:
            tag["show_header"] = _normalize_show_header(show_header)
            self._dirty = True
        if parent_id is not _NO_CHANGE:
            normalized_parent = self._validate_parent(parent_id, tag_id)
            tag["parent_id"] = normalized_parent
            self._dirty = True
        return tag

    def assign_tags(self, relative_path: str, tag_ids: Iterable[str]) -> List[str]:
        normalized_path = _normalize_path(relative_path)
        if not normalized_path or normalized_path == ".":
            raise ValueError("A valid path is required.")
        valid_ids = {tag["id"] for tag in self._state["tags"]}
        selection = [tag_id for tag_id in tag_ids if tag_id in valid_ids]
        if selection:
            unique = sorted(set(selection))
            self._state["assignments"][normalized_path] = unique
        elif normalized_path in self._state["assignments"]:
            del self._state["assignments"][normalized_path]
        self._dirty = True
        return self._state["assignments"].get(normalized_path, [])

    def reassign_path(self, old_path: str | Path, new_path: str | Path) -> None:
        old_norm = _normalize_path(old_path)
        new_norm = _normalize_path(new_path)
        if not old_norm or old_norm == new_norm:
            return
        updated: Dict[str, List[str]] = {}
        for path, tags in list(self._state["assignments"].items()):
            if path == old_norm or path.startswith(f"{old_norm}/"):
                suffix = path[len(old_norm):]
                suffix = suffix.lstrip("/")
                candidate = f"{new_norm}/{suffix}" if suffix else new_norm
                if candidate == ".":
                    continue
                updated[candidate] = tags
                del self._state["assignments"][path]
        if updated:
            self._state["assignments"].update(updated)
            self._dirty = True

    def clear_path(self, relative_path: str | Path) -> None:
        target = _normalize_path(relative_path)
        if not target:
            return
        removed = False
        for key in list(self._state["assignments"].keys()):
            if key == target or key.startswith(f"{target}/"):
                del self._state["assignments"][key]
                removed = True
        if removed:
            self._dirty = True

    def _find_tag(self, tag_id: str) -> dict:
        for tag in self._state["tags"]:
            if tag["id"] == tag_id:
                return tag
        raise KeyError(f"Tag '{tag_id}' not found.")

    def delete_tag(self, tag_id: str) -> None:
        """Delete a tag and remove it from all assignments."""
        tag = self._find_tag(tag_id)
        self._state["tags"] = [t for t in self._state["tags"] if t["id"] != tag_id]
        removed_any = False
        # Un-parent children
        for child in self._state["tags"]:
            if child.get("parent_id") == tag_id:
                child["parent_id"] = None
                removed_any = True
        for path, tags in list(self._state["assignments"].items()):
            filtered = [tid for tid in tags if tid != tag_id]
            if filtered and len(filtered) == len(tags):
                continue
            removed_any = True
            if filtered:
                self._state["assignments"][path] = filtered
            else:
                del self._state["assignments"][path]
        self._dirty = True or removed_any


__all__ = ["TagStore", "MAX_TAGS", "DEFAULT_COLORS", "TAGS_FILENAME", "_NO_CHANGE"]
