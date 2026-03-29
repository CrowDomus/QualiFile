"""Device-local Local Sync State (LSS) persistence for Git Sync."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from typing import Any

LSS_KEY_PREFIX = "git_sync_lss::"
_MAX_ERROR_MESSAGE_LEN = 512


def _now_local_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _normalize_root_id(root_id: str) -> str:
    text = str(root_id).strip()
    if not text:
        raise ValueError("root_id must be a non-empty string.")
    return text


def _normalize_optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_error_message(value: Any) -> str | None:
    text = _normalize_optional_text(value)
    if text is None:
        return None
    return text[:_MAX_ERROR_MESSAGE_LEN]


@dataclass(frozen=True)
class LocalSyncState:
    root_id: str
    last_export_fingerprint: str | None = None
    last_import_fingerprint: str | None = None
    last_export_time_local: str | None = None
    last_import_time_local: str | None = None
    last_error_kind: str | None = None
    last_error_message: str | None = None

    def as_dict(self) -> dict[str, str | None]:
        return {
            "root_id": self.root_id,
            "last_export_fingerprint": self.last_export_fingerprint,
            "last_import_fingerprint": self.last_import_fingerprint,
            "last_export_time_local": self.last_export_time_local,
            "last_import_time_local": self.last_import_time_local,
            "last_error_kind": self.last_error_kind,
            "last_error_message": self.last_error_message,
        }


class LocalSyncStateStore:
    """Store per-root Git Sync state in device-local profile preferences."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    @staticmethod
    def preference_key(root_id: str) -> str:
        return f"{LSS_KEY_PREFIX}{_normalize_root_id(root_id)}"

    def _default_state(self, root_id: str) -> LocalSyncState:
        return LocalSyncState(root_id=_normalize_root_id(root_id))

    def _decode_state(self, root_id: str, raw_value: str | None) -> LocalSyncState:
        if raw_value is None:
            return self._default_state(root_id)
        try:
            payload = json.loads(raw_value)
        except Exception:
            return self._default_state(root_id)
        if not isinstance(payload, dict):
            return self._default_state(root_id)
        return LocalSyncState(
            root_id=_normalize_root_id(root_id),
            last_export_fingerprint=_normalize_optional_text(payload.get("last_export_fingerprint")),
            last_import_fingerprint=_normalize_optional_text(payload.get("last_import_fingerprint")),
            last_export_time_local=_normalize_optional_text(payload.get("last_export_time_local")),
            last_import_time_local=_normalize_optional_text(payload.get("last_import_time_local")),
            last_error_kind=_normalize_optional_text(payload.get("last_error_kind")),
            last_error_message=_normalize_error_message(payload.get("last_error_message")),
        )

    def _encode_state(self, state: LocalSyncState) -> str:
        return json.dumps(state.as_dict(), ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    def get_state(self, root_id: str) -> LocalSyncState:
        normalized_root_id = _normalize_root_id(root_id)
        row = self._conn.execute(
            "SELECT value FROM profile_preferences WHERE key = ?",
            (self.preference_key(normalized_root_id),),
        ).fetchone()
        raw_value = None if not row else row[0]
        raw_text = None if raw_value is None else str(raw_value)
        return self._decode_state(normalized_root_id, raw_text)

    def _write_state(self, state: LocalSyncState) -> None:
        key = self.preference_key(state.root_id)
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO profile_preferences (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (key, self._encode_state(state)),
            )

    def clear_state(self, root_id: str) -> None:
        normalized_root_id = _normalize_root_id(root_id)
        with self._conn:
            self._conn.execute(
                "DELETE FROM profile_preferences WHERE key = ?",
                (self.preference_key(normalized_root_id),),
            )

    def record_export_success(
        self,
        root_id: str,
        *,
        snapshot_fingerprint: str,
        when_local: str | None = None,
    ) -> LocalSyncState:
        current = self.get_state(root_id)
        next_state = LocalSyncState(
            root_id=current.root_id,
            last_export_fingerprint=_normalize_root_id(snapshot_fingerprint),
            last_import_fingerprint=current.last_import_fingerprint,
            last_export_time_local=_normalize_optional_text(when_local) or _now_local_iso(),
            last_import_time_local=current.last_import_time_local,
            last_error_kind=None,
            last_error_message=None,
        )
        self._write_state(next_state)
        return next_state

    def record_import_success(
        self,
        root_id: str,
        *,
        snapshot_fingerprint: str,
        when_local: str | None = None,
    ) -> LocalSyncState:
        current = self.get_state(root_id)
        next_state = LocalSyncState(
            root_id=current.root_id,
            last_export_fingerprint=current.last_export_fingerprint,
            last_import_fingerprint=_normalize_root_id(snapshot_fingerprint),
            last_export_time_local=current.last_export_time_local,
            last_import_time_local=_normalize_optional_text(when_local) or _now_local_iso(),
            last_error_kind=None,
            last_error_message=None,
        )
        self._write_state(next_state)
        return next_state

    def record_error(self, root_id: str, *, kind: str, message: str | None = None) -> LocalSyncState:
        current = self.get_state(root_id)
        next_state = LocalSyncState(
            root_id=current.root_id,
            last_export_fingerprint=current.last_export_fingerprint,
            last_import_fingerprint=current.last_import_fingerprint,
            last_export_time_local=current.last_export_time_local,
            last_import_time_local=current.last_import_time_local,
            last_error_kind=_normalize_root_id(kind),
            last_error_message=_normalize_error_message(message),
        )
        self._write_state(next_state)
        return next_state


__all__ = [
    "LSS_KEY_PREFIX",
    "LocalSyncState",
    "LocalSyncStateStore",
]
