"""Persistent validation flags for individual files."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict

from ...shared.atomic_write import atomic_write_json
VALIDATION_STATE_FILENAME = "validation_state.json"


def _normalize_path(value) -> str:
    """Return a consistent forward-slash path without leading './'."""

    text = str(value or ".").replace("\\", "/")
    text = text.replace("//", "/")
    text = text.strip()
    while text.startswith("./"):
        text = text[2:]
    text = text.strip("/")
    return text or "."


class ValidationStore:
    """Encapsulates reading/writing validation states per root."""

    def __init__(self, root: Path, data_dir: Path | str):
        self.root = Path(root).resolve()
        base_dir = Path(data_dir).expanduser().resolve()
        self._dir = base_dir / ".qualifile_internal" / "validation"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._file = self._dir / VALIDATION_STATE_FILENAME
        self._state: Dict[str, Dict[str, bool]] = {"roots": {}}
        self._dirty = False
        self._load()

    @staticmethod
    def normalize_path(value) -> str:
        return _normalize_path(value)

    @property
    def assignments(self) -> Dict[str, bool]:
        """Return a copy of validation states for the active root."""

        return dict(self._state["roots"].get(self._root_key, {}))

    def is_validated(self, relative: str | Path) -> bool:
        key = _normalize_path(relative)
        if not key or key == ".":
            return False
        return bool(self._state["roots"].get(self._root_key, {}).get(key, False))

    def set_state(self, relative: str | Path, validated: bool) -> bool:
        """Set validation state for *relative* path and return the final state."""

        key = _normalize_path(relative)
        if not key or key == ".":
            raise ValueError("A valid file path is required.")
        root_map = self._state["roots"].setdefault(self._root_key, {})
        if validated:
            root_map[key] = True
        else:
            root_map.pop(key, None)
        self._dirty = True
        return bool(root_map.get(key, False))

    def toggle(self, relative: str | Path) -> bool:
        """Flip the validation flag for *relative* path and return the new state."""

        return self.set_state(relative, not self.is_validated(relative))

    def clear_path(self, relative: str | Path) -> None:
        """Remove validation entries for the target path and its descendants."""

        target = _normalize_path(relative)
        if not target:
            return
        root_map = self._state["roots"].get(self._root_key, {})
        removed = False
        for key in list(root_map.keys()):
            if key == target or key.startswith(f"{target}/"):
                root_map.pop(key, None)
                removed = True
        if removed:
            self._dirty = True
        if not root_map:
            self._state["roots"].pop(self._root_key, None)

    def reassign_path(self, old_path: str | Path, new_path: str | Path) -> None:
        """Move validation entries when files or folders are renamed/moved."""

        old_norm = _normalize_path(old_path)
        new_norm = _normalize_path(new_path)
        if not old_norm or not new_norm or old_norm == new_norm:
            return
        root_map = self._state["roots"].get(self._root_key, {})
        updated: Dict[str, bool] = {}
        for key, value in list(root_map.items()):
            if key == old_norm or key.startswith(f"{old_norm}/"):
                suffix = key[len(old_norm):].lstrip("/")
                candidate = f"{new_norm}/{suffix}" if suffix else new_norm
                if candidate == ".":
                    root_map.pop(key, None)
                    continue
                updated[candidate] = bool(value)
                root_map.pop(key, None)
        if updated:
            root_map.update(updated)
            self._dirty = True

    def save(self) -> None:
        """Persist changes if the store is dirty."""

        if not self._dirty:
            return
        payload = {"version": 1, "roots": self._state.get("roots", {})}
        atomic_write_json(self._file, payload, indent=2, sort_keys=True)
        self._dirty = False

    def _load(self) -> None:
        if not self._file.exists():
            self._state = {"roots": {}}
            return
        try:
            raw = json.loads(self._file.read_text())
        except Exception:
            self._state = {"roots": {}}
            return
        roots = raw.get("roots")
        cleaned: Dict[str, Dict[str, bool]] = {}
        if isinstance(roots, dict):
            for root_key, mapping in roots.items():
                if not isinstance(root_key, str) or not root_key.strip():
                    continue
                if not isinstance(mapping, dict):
                    continue
                normalized_root = str(Path(root_key).resolve())
                valid_entries: Dict[str, bool] = {}
                for path_key, flag in mapping.items():
                    if not flag:
                        continue
                    normalized_path = _normalize_path(path_key)
                    if not normalized_path or normalized_path == ".":
                        continue
                    valid_entries[normalized_path] = True
                if valid_entries:
                    cleaned[normalized_root] = valid_entries
        self._state = {"roots": cleaned}

    @property
    def _root_key(self) -> str:
        return str(self.root)


__all__ = ["ValidationStore", "VALIDATION_STATE_FILENAME"]
