from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

from ..filesystem.service import PathOutsideRootError, resolve_within_root
from ..metadata.service import MetadataService
from ..notes.store import NoteStore
from ..projects.db_store import ProjectDBStore
from ...shared.db_roots import get_root_id
from .helpers import collect_fallback_notes, note_sort_key, parse_iso, path_status

DEFAULT_LIMIT = 200
INDEX_STALE_HOURS = 24
FALLBACK_SIDECAR_LIMIT = 1000


def list_linked_notes_for_project(conn, data_dir, config, project_id: str, *, limit: int = DEFAULT_LIMIT) -> dict:
    project = ProjectDBStore(conn).get_project(project_id)
    root_path = project.get("root_path")
    if not root_path:
        raise ValueError("Project has no root path configured.")
    root = Path(root_path)
    if not root.exists() or not root.is_dir():
        raise FileNotFoundError("Project root is unavailable.")
    root_id = get_root_id(conn, root_path)
    index_status = _index_status(conn, root_id)

    if index_status == "fresh":
        items = _collect_index_notes(conn, root, root_id, data_dir, config)
        source = "index"
        capped = False
    else:
        items, capped = collect_fallback_notes(root, limit, sidecar_limit=FALLBACK_SIDECAR_LIMIT)
        source = "fallback"

    items.sort(key=note_sort_key, reverse=True)
    if len(items) > limit:
        items = items[:limit]
        capped = True
    return {
        "linked_notes": items,
        "capped": capped,
        "limit": limit,
        "source": source,
    }


def create_linked_note_for_project(conn, data_dir, config, project_id: str, payload: dict) -> dict:
    project = ProjectDBStore(conn).get_project(project_id)
    root_path = project.get("root_path")
    if not root_path:
        raise ValueError("Project has no root path configured.")
    root = Path(root_path)
    if not root.exists() or not root.is_dir():
        raise FileNotFoundError("Project root is unavailable.")
    raw_path = payload.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError("Path is required.")
    candidate = resolve_within_root(root, raw_path.strip())
    try:
        relative = candidate.resolve().relative_to(root.resolve()).as_posix()
    except Exception as exc:
        raise PathOutsideRootError("Path escapes project root.") from exc
    if not relative:
        relative = "."
    if relative != ".":
        if not candidate.exists():
            raise ValueError("Target path does not exist.")
        if not (candidate.is_dir() or candidate.is_file()):
            raise ValueError("Target must be a file or folder.")
    normalized = NoteStore.normalize_path(relative)
    metadata = MetadataService(root, data_dir, config=config, db_conn=conn)
    note = metadata.add_note(
        normalized,
        text=payload.get("text", ""),
        deadline=payload.get("deadline"),
        priority=payload.get("priority"),
        status=payload.get("status", "none"),
        color=payload.get("color"),
    )
    notes = metadata.get_notes(normalized)
    return {
        "note": note,
        "notes": notes,
        "summary": metadata.summarize(notes),
        "path": normalized,
    }


def _index_status(conn, root_id: str | None) -> str:
    if not root_id:
        return "unavailable"
    row = conn.execute(
        "SELECT MAX(indexed_at) FROM file_index WHERE root_id = ?",
        (root_id,),
    ).fetchone()
    stamp = row[0] if row else None
    if not stamp:
        return "unavailable"
    indexed_at = parse_iso(stamp)
    if indexed_at == datetime.min:
        return "stale"
    if datetime.utcnow() - indexed_at > timedelta(hours=INDEX_STALE_HOURS):
        return "stale"
    return "fresh"


def _collect_index_notes(conn, root: Path, root_id: str | None, data_dir, config) -> list[dict]:
    metadata = MetadataService(root, data_dir, config=config, db_conn=conn)
    items: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def add_notes(path: str, is_dir_hint: bool | None = None) -> None:
        notes = metadata.get_notes(path)
        if not notes:
            return
        exists, is_dir = path_status(root, path, is_dir_hint)
        for note in notes:
            if not isinstance(note, dict):
                continue
            note_id = str(note.get("id") or "")
            key = (path, note_id)
            if key in seen:
                continue
            seen.add(key)
            items.append({"path": path, "is_dir": is_dir, "exists": exists, "note": note})

    add_notes(".", True)
    if not root_id:
        return items
    rows = conn.execute(
        """
        SELECT path, is_dir
        FROM file_index
        WHERE root_id = ?
          AND path != '.'
          AND (note_open_count > 0 OR note_closed_count > 0)
        """,
        (root_id,),
    ).fetchall()
    for path, is_dir in rows:
        if not isinstance(path, str) or not path:
            continue
        add_notes(path, bool(is_dir))
    return items

__all__ = ["create_linked_note_for_project", "list_linked_notes_for_project"]
