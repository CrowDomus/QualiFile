from __future__ import annotations

from pathlib import Path

from ..filesystem.service import list_directory, resolve_within_root
from ..projects.db_store import ProjectDBStore


def _relative_to_root(root: Path, target: Path) -> str:
    relative = target.resolve().relative_to(root.resolve()).as_posix()
    return relative if relative else "."


def _parent_path(current_path: str) -> str | None:
    if current_path == ".":
        return None
    parts = current_path.split("/")
    parts.pop()
    return "." if not parts else "/".join(parts)


def _normalize_entry_path(value: str | None) -> str:
    text = str(value or "").replace("\\", "/")
    return text or "."


def browse_project_root(conn, project_id: str, path: str | None = None) -> dict:
    project = ProjectDBStore(conn).get_project(project_id)
    root_path = project.get("root_path")
    if not root_path:
        raise ValueError("Project has no root path configured.")
    root = Path(root_path)
    if not root.exists() or not root.is_dir():
        raise FileNotFoundError("Project root is unavailable.")

    raw_path = (path or ".").strip()
    if raw_path in {"", "/"}:
        raw_path = "."

    target = resolve_within_root(root, raw_path)
    current_path = _relative_to_root(root, target)
    listing = list_directory(root, current_path, include_subfolders=False)
    entries = listing.get("entries", []) if isinstance(listing, dict) else listing

    items = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        rel_path = _normalize_entry_path(entry.get("path"))
        if not rel_path:
            continue
        name = entry.get("name")
        items.append({
            "name": name if isinstance(name, str) else str(name or ""),
            "rel_path": rel_path,
            "is_dir": bool(entry.get("is_dir")),
        })

    return {
        "current_path": current_path,
        "parent_path": _parent_path(current_path),
        "items": items,
    }
