"""Sidecar metadata storage helpers."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Literal, Tuple

from ..filesystem.service import resolve_within_root
from ...shared.atomic_write import atomic_write_json

SIDECAR_FILENAME = ".qualifile_meta.json"
SCHEMA_VERSION = 1
KNOWN_ITEM_KEYS = {"notes", "tags", "validation"}
READ_RETRY_COUNT = 2
READ_RETRY_DELAY_SECONDS = 0.05
SidecarReadStatus = Literal["ok", "missing", "corrupt", "read_error"]


@dataclass(frozen=True)
class SidecarLoadResult:
    data: Dict[str, object]
    status: SidecarReadStatus


def normalize_key(value: str | Path | None) -> str:
    text = str(value or ".").replace("\\", "/").strip()
    while text.startswith("./"):
        text = text[2:]
    text = text.strip("/")
    return text or "."


def sidecar_path(folder: Path) -> Path:
    return Path(folder) / SIDECAR_FILENAME


def resolve_item_location(root: Path, relative: str | Path | None) -> Tuple[Path, str]:
    target = resolve_within_root(root, str(relative or "."))
    if target.is_dir():
        return target, "."
    return target.parent, target.name


def load_sidecar(path: Path) -> SidecarLoadResult:
    if not path.exists():
        return SidecarLoadResult(_empty_sidecar(), "missing")
    text, error = _read_sidecar_text(path)
    if error is not None:
        if isinstance(error, FileNotFoundError):
            return SidecarLoadResult(_empty_sidecar(), "missing")
        return SidecarLoadResult(_empty_sidecar(), "read_error")
    try:
        raw = json.loads(text or "")
    except json.JSONDecodeError:
        _quarantine_corrupt_sidecar(path)
        return SidecarLoadResult(_empty_sidecar(), "corrupt")
    except Exception:
        return SidecarLoadResult(_empty_sidecar(), "read_error")
    if not isinstance(raw, dict):
        _quarantine_corrupt_sidecar(path)
        return SidecarLoadResult(_empty_sidecar(), "corrupt")
    if not isinstance(raw.get("schema_version"), int):
        raw["schema_version"] = SCHEMA_VERSION
    if not isinstance(raw.get("items"), dict):
        raw["items"] = {}
    return SidecarLoadResult(raw, "ok")


def _empty_sidecar() -> Dict[str, object]:
    return {"schema_version": SCHEMA_VERSION, "items": {}}


def _read_sidecar_text(path: Path) -> tuple[str | None, Exception | None]:
    attempts = max(0, READ_RETRY_COUNT) + 1
    for attempt in range(attempts):
        try:
            return path.read_text(encoding="utf-8"), None
        except FileNotFoundError as exc:
            return None, exc
        except Exception as exc:
            if attempt + 1 < attempts:
                time.sleep(READ_RETRY_DELAY_SECONDS)
                continue
            return None, exc
    return None, RuntimeError("Sidecar read failed")


def _quarantine_corrupt_sidecar(path: Path) -> None:
    """Preserve corrupt sidecar content before it is overwritten."""

    if not path.exists():
        return
    stamp = int(time.time() * 1000)
    backup = path.with_name(f"{path.name}.corrupt-{stamp}.bak")
    try:
        path.replace(backup)
        return
    except Exception:
        pass
    try:
        backup.write_bytes(path.read_bytes())
    except Exception:
        return


def write_sidecar(path: Path, data: Dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(path, data, indent=2, sort_keys=True)


def ensure_item(items: Dict[str, object], key: str) -> Dict[str, object]:
    existing = items.get(key)
    if isinstance(existing, dict):
        return existing
    fresh: Dict[str, object] = {}
    items[key] = fresh
    return fresh


def cleanup_item(items: Dict[str, object], key: str) -> None:
    entry = items.get(key)
    if not isinstance(entry, dict):
        items.pop(key, None)
        return
    notes = entry.get("notes")
    if not (isinstance(notes, list) and notes):
        entry.pop("notes", None)
    tags = entry.get("tags")
    if not (isinstance(tags, list) and tags):
        entry.pop("tags", None)
    validation = entry.get("validation")
    if validation is not True:
        entry.pop("validation", None)
    if not entry:
        items.pop(key, None)
