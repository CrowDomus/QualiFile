from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from ..metadata.sidecar import SIDECAR_FILENAME, load_sidecar


def collect_fallback_notes(
    root: Path,
    limit: int,
    *,
    sidecar_limit: int | None = None,
) -> tuple[list[dict], bool]:
    items: list[dict] = []
    seen: set[tuple[str, str]] = set()
    capped = False
    sidecar_count = 0
    for sidecar in root.rglob(SIDECAR_FILENAME):
        if sidecar_limit is not None and sidecar_count >= sidecar_limit:
            capped = True
            break
        sidecar_count += 1
        data = load_sidecar(sidecar).data
        entries = data.get("items") if isinstance(data, dict) else None
        if not isinstance(entries, dict):
            continue
        folder = sidecar.parent
        for key, entry in entries.items():
            if not isinstance(entry, dict):
                continue
            notes = entry.get("notes")
            if not isinstance(notes, list) or not notes:
                continue
            rel_path = relative_path(root, folder, key)
            if not rel_path:
                continue
            exists, is_dir = path_status(root, rel_path, key == ".")
            for note in notes:
                if not isinstance(note, dict):
                    continue
                note_id = str(note.get("id") or "")
                key_id = (rel_path, note_id)
                if key_id in seen:
                    continue
                seen.add(key_id)
                items.append({"path": rel_path, "is_dir": is_dir, "exists": exists, "note": note})
                if len(items) >= limit:
                    capped = True
                    return items, capped
    return items, capped


def note_sort_key(item: dict) -> datetime:
    note = item.get("note") if isinstance(item, dict) else None
    if not isinstance(note, dict):
        return datetime.min
    return parse_iso(note.get("updated_at") or note.get("created_at"))


def parse_iso(value: object) -> datetime:
    if not isinstance(value, str) or not value.strip():
        return datetime.min
    text = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except Exception:
        return datetime.min
    if parsed.tzinfo:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def path_status(root: Path, rel_path: str, is_dir_hint: bool | None = None) -> tuple[bool, bool]:
    target = root if rel_path == "." else root / rel_path
    exists = target.exists()
    if exists:
        return True, target.is_dir()
    if is_dir_hint is not None:
        return False, bool(is_dir_hint)
    return False, False


def relative_path(root: Path, folder: Path, key: object) -> str | None:
    try:
        base_rel = folder.resolve().relative_to(root.resolve())
    except Exception:
        return None
    key_text = str(key)
    if key_text == ".":
        rel = base_rel.as_posix()
        return rel if rel else "."
    target_rel = (base_rel / key_text).as_posix()
    return target_rel or "."

__all__ = ["collect_fallback_notes", "note_sort_key", "parse_iso", "path_status"]
