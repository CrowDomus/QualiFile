"""SQLite-backed read helpers for projects."""

from __future__ import annotations

import sqlite3
from typing import List


class ProjectDBStore:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def _row_to_project(self, row: tuple) -> dict:
        (
            project_id,
            name,
            description,
            parent_id,
            root_path,
            created_at,
            updated_at,
            status,
            color,
            entry_mode,
            archived,
            archived_at,
        ) = row
        return {
            "id": project_id,
            "name": name,
            "description": description,
            "parent_id": parent_id,
            "root_path": root_path,
            "created_at": created_at,
            "updated_at": updated_at,
            "status": status,
            "color": color,
            "entry_mode": entry_mode,
            "archived": bool(archived),
            "archived_at": archived_at,
        }

    def list_projects(self) -> List[dict]:
        rows = self._conn.execute(
            """
            SELECT project_id, name, description, parent_id, root_path, created_at, updated_at,
                   status, color, entry_mode, archived, archived_at
            FROM projects
            ORDER BY rowid ASC
            """
        ).fetchall()
        projects = [self._row_to_project(row) for row in rows]
        projects.sort(key=lambda item: (item.get("name") or "").lower())
        return projects

    def get_project(self, project_id: str) -> dict:
        row = self._conn.execute(
            """
            SELECT project_id, name, description, parent_id, root_path, created_at, updated_at,
                   status, color, entry_mode, archived, archived_at
            FROM projects
            WHERE project_id = ?
            """,
            (project_id,),
        ).fetchone()
        if not row:
            raise KeyError(f"Project '{project_id}' was not found.")
        return self._row_to_project(row)

    def upsert_project(self, project: dict) -> None:
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO projects (
                    project_id, root_id, name, description, parent_id, root_path,
                    status, color, entry_mode, created_at, updated_at, archived, archived_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(project_id) DO UPDATE SET
                    root_id = excluded.root_id,
                    name = excluded.name,
                    description = excluded.description,
                    parent_id = excluded.parent_id,
                    root_path = excluded.root_path,
                    status = excluded.status,
                    color = excluded.color,
                    entry_mode = excluded.entry_mode,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    archived = excluded.archived,
                    archived_at = excluded.archived_at
                """,
                (
                    project.get("id"),
                    project.get("root_id"),
                    project.get("name"),
                    project.get("description"),
                    project.get("parent_id"),
                    project.get("root_path"),
                    project.get("status"),
                    project.get("color"),
                    project.get("entry_mode"),
                    project.get("created_at"),
                    project.get("updated_at"),
                    1 if project.get("archived") is True else 0,
                    project.get("archived_at"),
                ),
            )

    def delete_projects(self, project_ids: list[str]) -> None:
        if not project_ids:
            return
        placeholders = ",".join(["?"] * len(project_ids))
        with self._conn:
            self._conn.execute(
                f"DELETE FROM projects WHERE project_id IN ({placeholders})",
                project_ids,
            )


__all__ = ["ProjectDBStore"]
