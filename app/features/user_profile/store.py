"""Profile persistence helpers for the local user profile feature."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional

from ...shared.db import load_db_settings_from_config, open_connection
from ...shared.db_migrations import apply_migrations
from .contract import PROFILE_SCHEMA_VERSION

APP_STATE_ID = "global"
_WRITABLE_PROFILE_MODES = {"shadow", "on"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_text(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_profile_id(value: str) -> str:
    cleaned = _normalize_text(value)
    if not cleaned:
        raise ValueError("Profile id is required.")
    return cleaned


def _normalize_display_name(value: str) -> str:
    cleaned = _normalize_text(value)
    if not cleaned:
        raise ValueError("Display name is required.")
    return cleaned


def _serialize_payload(payload: Mapping[str, Any] | None) -> Optional[str]:
    if payload is None:
        return None
    try:
        return json.dumps(payload, sort_keys=True)
    except TypeError as exc:
        raise ValueError("Portable preferences payload must be JSON-serializable.") from exc


def _parse_payload(payload_json: Optional[str]) -> dict[str, Any]:
    if not payload_json:
        return {}
    try:
        parsed = json.loads(payload_json)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _profile_mode(config: Mapping[str, object]) -> str:
    value = config.get("PROFILE_MODE", "off")
    if isinstance(value, str):
        return value.strip().lower()
    return "off"


def _ensure_writable(config: Mapping[str, object]) -> None:
    if _profile_mode(config) not in _WRITABLE_PROFILE_MODES:
        raise RuntimeError("Profile mode is off; writes are disabled.")


def _open_profile_db(data_dir: Path, config: Mapping[str, object]) -> sqlite3.Connection:
    settings = load_db_settings_from_config(data_dir, config)
    conn = open_connection(settings)
    apply_migrations(conn)
    return conn


class ProfileStore:
    """SQLite-backed profile persistence for user profile data."""

    def __init__(self, data_dir: Path, config: Mapping[str, object]) -> None:
        self._data_dir = Path(data_dir)
        self._config = config

    def _open(self) -> sqlite3.Connection:
        return _open_profile_db(self._data_dir, self._config)

    def get_active_profile_id(self) -> Optional[str]:
        conn = self._open()
        try:
            row = conn.execute(
                "SELECT active_profile_id FROM app_state WHERE state_id = ?",
                (APP_STATE_ID,),
            ).fetchone()
            if not row:
                return None
            return str(row[0]) if row[0] is not None else None
        finally:
            conn.close()

    def set_active_profile_id(self, profile_id: Optional[str]) -> None:
        _ensure_writable(self._config)
        conn = self._open()
        try:
            with conn:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO app_state (state_id, active_profile_id, updated_at)
                    VALUES (?, NULL, NULL)
                    """,
                    (APP_STATE_ID,),
                )
                conn.execute(
                    """
                    UPDATE app_state
                    SET active_profile_id = ?, updated_at = ?
                    WHERE state_id = ?
                    """,
                    (profile_id, _now(), APP_STATE_ID),
                )
        finally:
            conn.close()

    def get_profile(self, profile_id: str) -> Optional[dict]:
        cleaned_id = _normalize_profile_id(profile_id)
        conn = self._open()
        try:
            row = conn.execute(
                """
                SELECT id, display_name, email, avatar_ref, schema_version, created_at, updated_at
                FROM user_profiles
                WHERE id = ?
                """,
                (cleaned_id,),
            ).fetchone()
            if not row:
                return None
            return {
                "id": row[0],
                "display_name": row[1],
                "email": row[2],
                "avatar_ref": row[3],
                "schema_version": row[4],
                "created_at": row[5],
                "updated_at": row[6],
            }
        finally:
            conn.close()

    def upsert_profile(
        self,
        profile_id: str,
        *,
        display_name: str,
        email: Optional[str] = None,
        avatar_ref: Optional[str] = None,
        schema_version: Optional[int] = None,
    ) -> dict:
        _ensure_writable(self._config)
        cleaned_id = _normalize_profile_id(profile_id)
        cleaned_name = _normalize_display_name(display_name)
        cleaned_email = _normalize_text(email)
        cleaned_avatar = _normalize_text(avatar_ref)
        version = PROFILE_SCHEMA_VERSION if schema_version is None else int(schema_version)
        now = _now()
        conn = self._open()
        try:
            row = conn.execute(
                "SELECT created_at FROM user_profiles WHERE id = ?",
                (cleaned_id,),
            ).fetchone()
            created_at = row[0] if row and row[0] else now
            with conn:
                conn.execute(
                    """
                    INSERT INTO user_profiles (
                        id, display_name, email, avatar_ref, schema_version, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        display_name = excluded.display_name,
                        email = excluded.email,
                        avatar_ref = excluded.avatar_ref,
                        schema_version = excluded.schema_version,
                        updated_at = excluded.updated_at
                    """,
                    (
                        cleaned_id,
                        cleaned_name,
                        cleaned_email,
                        cleaned_avatar,
                        version,
                        created_at,
                        now,
                    ),
                )
        finally:
            conn.close()
        return {
            "id": cleaned_id,
            "display_name": cleaned_name,
            "email": cleaned_email,
            "avatar_ref": cleaned_avatar,
            "schema_version": version,
            "created_at": created_at,
            "updated_at": now,
        }

    def get_portable_preferences(self, profile_id: str) -> dict[str, Any]:
        cleaned_id = _normalize_profile_id(profile_id)
        conn = self._open()
        try:
            row = conn.execute(
                "SELECT payload_json FROM profile_portable_preferences WHERE profile_id = ?",
                (cleaned_id,),
            ).fetchone()
            if not row:
                return {}
            return _parse_payload(row[0])
        finally:
            conn.close()

    def set_portable_preferences(self, profile_id: str, payload: Mapping[str, Any] | None) -> None:
        _ensure_writable(self._config)
        cleaned_id = _normalize_profile_id(profile_id)
        serialized = _serialize_payload(payload)
        conn = self._open()
        try:
            with conn:
                conn.execute(
                    """
                    INSERT INTO profile_portable_preferences (profile_id, payload_json, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(profile_id) DO UPDATE SET
                        payload_json = excluded.payload_json,
                        updated_at = excluded.updated_at
                    """,
                    (cleaned_id, serialized, _now()),
                )
        finally:
            conn.close()


class ProfileService:
    """High-level profile helpers that compose profile and preferences data."""

    def __init__(self, data_dir: Path, config: Mapping[str, object]) -> None:
        self._store = ProfileStore(data_dir, config)

    def get_active_profile(self) -> Optional[dict]:
        profile_id = self._store.get_active_profile_id()
        if not profile_id:
            return None
        profile = self._store.get_profile(profile_id)
        if not profile:
            return None
        payload = self._store.get_portable_preferences(profile_id)
        result = dict(profile)
        result["portable_preferences"] = payload
        return result

    def upsert_profile(
        self,
        profile_id: str,
        *,
        display_name: str,
        email: Optional[str] = None,
        avatar_ref: Optional[str] = None,
        schema_version: Optional[int] = None,
    ) -> dict:
        return self._store.upsert_profile(
            profile_id,
            display_name=display_name,
            email=email,
            avatar_ref=avatar_ref,
            schema_version=schema_version,
        )

    def set_portable_preferences(self, profile_id: str, payload: Mapping[str, Any] | None) -> None:
        self._store.set_portable_preferences(profile_id, payload)

    def activate_profile(self, profile_id: str) -> None:
        self._store.set_active_profile_id(profile_id)

    def disconnect(self) -> None:
        self._store.set_active_profile_id(None)


__all__ = ["APP_STATE_ID", "ProfileService", "ProfileStore"]
