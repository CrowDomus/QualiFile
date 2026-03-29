"""Helpers for locating the bundled user tutorial."""

from __future__ import annotations

from pathlib import Path

from flask import current_app


def resolve_tutorial_root() -> Path | None:
    """Return the directory that contains the user tutorial assets."""

    static_root_value = current_app.static_folder
    if static_root_value:
        static_root = Path(static_root_value)
        candidate = static_root / "user_tutorial"
        if candidate.exists():
            return candidate

    repo_root = Path(__file__).resolve().parents[2]
    fallback = repo_root / "docs" / "user_tutorial"
    if fallback.exists():
        return fallback
    return None


__all__ = ["resolve_tutorial_root"]
