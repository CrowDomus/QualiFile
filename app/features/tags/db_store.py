"""SQLite-backed read helpers for tag definitions."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import List
from uuid import uuid4

from ...shared.db_roots import ensure_root, get_root_id
from .store import DEFAULT_COLORS, MAX_TAGS, _NO_CHANGE, _normalize_color, _normalize_name, _normalize_show_header


class TagDefinitionDBStore:
    def __init__(self, conn: sqlite3.Connection, root: Path) -> None:
        self._conn = conn
        self._root_path = Path(root).expanduser().resolve()
        self._root_id = get_root_id(conn, str(self._root_path))

    def _ensure_root_id(self) -> str:
        if not self._root_id:
            self._root_id = ensure_root(self._conn, str(self._root_path))
        return str(self._root_id)

    def _fetch_tags(self) -> list[dict]:
        if not self._root_id:
            return []
        rows = self._conn.execute(
            """
            SELECT tag_id, name, color, show_header, parent_id
            FROM tag_definitions
            WHERE root_id = ?
            ORDER BY rowid ASC
            """,
            (self._root_id,),
        ).fetchall()
        tags = []
        for tag_id, name, color, show_header, parent_id in rows:
            tags.append(
                {
                    "id": tag_id,
                    "name": name,
                    "color": color,
                    "show_header": bool(show_header) if show_header is not None else None,
                    "parent_id": parent_id,
                }
            )
        return tags

    def _fallback_color(self, tags: list[dict]) -> str:
        palette = [color.lower() for color in DEFAULT_COLORS]
        used = {tag.get("color") for tag in tags if tag.get("color")}
        for color in palette:
            if color not in used:
                return color
        return DEFAULT_COLORS[len(tags) % len(DEFAULT_COLORS)].lower()

    def _validate_parent(self, tags: list[dict], parent_id: str | None, tag_id: str | None = None) -> str | None:
        if parent_id in (None, "", False):
            return None
        if not isinstance(parent_id, str):
            raise ValueError("Invalid parent tag.")
        if tag_id and parent_id == tag_id:
            raise ValueError("A tag cannot be its own parent.")
        ids = {tag["id"] for tag in tags}
        if parent_id not in ids:
            raise ValueError("Parent tag not found.")

        def ancestors(candidate: str):
            current = candidate
            visited = set()
            while True:
                if current in visited:
                    break
                visited.add(current)
                parent = None
                for tag in tags:
                    if tag["id"] == current:
                        parent = tag.get("parent_id")
                        break
                if not parent:
                    break
                yield parent
                current = parent

        for ancestor in ancestors(parent_id):
            if tag_id and ancestor == tag_id:
                raise ValueError("Invalid parent: would create a cycle.")
        return parent_id

    def list_tags(self) -> List[dict]:
        return self._fetch_tags()

    def create_tag(self, name: str, color: str | None = None, parent_id: str | None = None) -> dict:
        root_id = self._ensure_root_id()
        tags = self._fetch_tags()
        if len(tags) >= MAX_TAGS:
            raise ValueError(f"Maximum of {MAX_TAGS} tags reached.")
        cleaned_name = _normalize_name(name)
        if any(tag["name"].lower() == cleaned_name.lower() for tag in tags):
            raise ValueError("A tag with that name already exists.")
        normalized_color = _normalize_color(color) or self._fallback_color(tags)
        normalized_parent = self._validate_parent(tags, parent_id)
        tag_id = f"tag-{uuid4().hex[:8]}"
        tag = {
            "id": tag_id,
            "name": cleaned_name,
            "color": normalized_color,
            "show_header": True,
            "parent_id": normalized_parent,
        }
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO tag_definitions (tag_id, root_id, name, color, show_header, parent_id)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    tag_id,
                    root_id,
                    cleaned_name,
                    normalized_color,
                    1,
                    normalized_parent,
                ),
            )
        return tag

    def update_tag(
        self,
        tag_id: str,
        *,
        name: str | None = None,
        color: str | None = None,
        show_header: bool | None = None,
        parent_id: object = _NO_CHANGE,
    ) -> dict:
        tags = self._fetch_tags()
        current = next((tag for tag in tags if tag.get("id") == tag_id), None)
        if not current:
            raise KeyError(f"Tag '{tag_id}' not found.")
        updated = dict(current)
        if name is not None:
            cleaned_name = _normalize_name(name)
            if any(
                other["id"] != tag_id and other["name"].lower() == cleaned_name.lower()
                for other in tags
            ):
                raise ValueError("Another tag already uses that name.")
            updated["name"] = cleaned_name
        if color is not None:
            updated["color"] = _normalize_color(color) or self._fallback_color(tags)
        if show_header is not None:
            updated["show_header"] = _normalize_show_header(show_header)
        if parent_id is not _NO_CHANGE:
            normalized_parent = self._validate_parent(tags, parent_id if parent_id is not None else None, tag_id)
            updated["parent_id"] = normalized_parent
        with self._conn:
            self._conn.execute(
                """
                UPDATE tag_definitions
                SET name = ?, color = ?, show_header = ?, parent_id = ?
                WHERE tag_id = ? AND root_id = ?
                """,
                (
                    updated.get("name"),
                    updated.get("color"),
                    1 if updated.get("show_header") else 0,
                    updated.get("parent_id"),
                    tag_id,
                    self._ensure_root_id(),
                ),
            )
        return updated

    def delete_tag(self, tag_id: str) -> None:
        if not self._root_id:
            raise KeyError(f"Tag '{tag_id}' not found.")
        row = self._conn.execute(
            "SELECT tag_id FROM tag_definitions WHERE tag_id = ? AND root_id = ?",
            (tag_id, self._root_id),
        ).fetchone()
        if not row:
            raise KeyError(f"Tag '{tag_id}' not found.")
        with self._conn:
            self._conn.execute(
                "DELETE FROM tag_definitions WHERE tag_id = ? AND root_id = ?",
                (tag_id, self._root_id),
            )
            self._conn.execute(
                "UPDATE tag_definitions SET parent_id = NULL WHERE parent_id = ? AND root_id = ?",
                (tag_id, self._root_id),
            )


__all__ = ["TagDefinitionDBStore"]
