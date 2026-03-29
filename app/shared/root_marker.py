"""Root marker helpers to preserve root identity across moves."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .atomic_write import atomic_write_json
MARKER_FILENAME = ".qualifile_root.json"
SCHEMA_VERSION = 1


def marker_path(root: Path) -> Path:
    return Path(root) / MARKER_FILENAME


def read_root_marker(root: Path) -> Optional[str]:
    path = marker_path(root)
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(raw, dict):
        return None
    root_id = raw.get("root_id")
    if isinstance(root_id, str):
        cleaned = root_id.strip()
        return cleaned or None
    return None


def ensure_root_marker(root: Path, root_id: str) -> None:
    if not root_id:
        return
    path = marker_path(root)
    existing_id = read_root_marker(root)
    if existing_id == root_id and path.exists():
        return
    created_at = None
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            raw = {}
        if isinstance(raw, dict):
            raw_created = raw.get("created_at")
            if isinstance(raw_created, str) and raw_created:
                created_at = raw_created
    now = datetime.now(timezone.utc).isoformat()
    payload = {
        "schema_version": SCHEMA_VERSION,
        "root_id": root_id,
        "created_at": created_at or now,
        "updated_at": now,
    }
    atomic_write_json(path, payload, indent=2, sort_keys=True)


__all__ = ["MARKER_FILENAME", "SCHEMA_VERSION", "ensure_root_marker", "marker_path", "read_root_marker"]
