"""Avatar storage helpers for local user profiles."""

from __future__ import annotations

import imghdr
import mimetypes
from pathlib import Path
from typing import Optional
from uuid import uuid4

from werkzeug.datastructures import FileStorage

MAX_AVATAR_BYTES = 2 * 1024 * 1024
_ALLOWED_IMAGE_TYPES = {
    "jpeg": ".jpg",
    "png": ".png",
    "webp": ".webp",
}
_MIME_OVERRIDES = {
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}


def _avatar_dir(data_dir: Path) -> Path:
    path = Path(data_dir) / ".qualifile_internal" / "avatars"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _normalize_avatar_ref(value: str) -> str:
    if not value:
        raise ValueError("Avatar reference is required.")
    name = Path(value).name
    if name != value or not name:
        raise ValueError("Invalid avatar reference.")
    return name


def _detect_extension(data: bytes) -> str:
    kind = imghdr.what(None, data)
    if not kind and _is_webp(data):
        kind = "webp"
    if not kind:
        raise ValueError("Avatar must be a PNG, JPEG, or WEBP image.")
    ext = _ALLOWED_IMAGE_TYPES.get(kind)
    if not ext:
        raise ValueError("Avatar must be a PNG, JPEG, or WEBP image.")
    return ext


def _is_webp(data: bytes) -> bool:
    return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"


def _read_upload(upload: FileStorage) -> bytes:
    data = upload.stream.read(MAX_AVATAR_BYTES + 1)
    if not data:
        raise ValueError("Avatar upload is empty.")
    if len(data) > MAX_AVATAR_BYTES:
        raise ValueError("Avatar exceeds the 2 MB size limit.")
    return data


class AvatarStore:
    """Store and retrieve avatar files under .qualifile_internal/avatars."""

    def __init__(self, data_dir: Path) -> None:
        self._data_dir = Path(data_dir)

    def save(self, upload: FileStorage) -> str:
        data = _read_upload(upload)
        ext = _detect_extension(data)
        filename = f"{uuid4().hex}{ext}"
        target = _avatar_dir(self._data_dir) / filename
        target.write_bytes(data)
        return filename

    def resolve_path(self, avatar_ref: str) -> Path:
        name = _normalize_avatar_ref(avatar_ref)
        return _avatar_dir(self._data_dir) / name

    def delete(self, avatar_ref: Optional[str]) -> None:
        if not avatar_ref:
            return
        try:
            path = self.resolve_path(avatar_ref)
        except ValueError:
            return
        try:
            path.unlink()
        except FileNotFoundError:
            return

    def content_type(self, avatar_ref: str) -> str:
        ext = Path(avatar_ref).suffix.lower()
        if ext in _MIME_OVERRIDES:
            return _MIME_OVERRIDES[ext]
        guessed, _ = mimetypes.guess_type(avatar_ref)
        return guessed or "application/octet-stream"


__all__ = ["AvatarStore", "MAX_AVATAR_BYTES"]
