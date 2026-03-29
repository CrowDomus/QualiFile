"""Shared helpers for resolving DATA_DIR and related paths."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


@dataclass(frozen=True)
class DataDirPaths:
    data_dir: Path
    preview_cache_dir: Path
    office_cache_dir: Path
    log_file: Path
    notes_dir: Path
    logs_dir: Path
    internal_dir: Path
    validation_dir: Path
    diagnostics_dir: Path


def resolve_data_dir(instance_path: Path, env: Mapping[str, str] | None = None) -> Path:
    env_values = env or os.environ
    override = env_values.get("QUALIFILE_DATA_DIR")
    if override:
        return Path(override)
    return Path(instance_path)


def resolve_paths(data_dir: Path, env: Mapping[str, str] | None = None) -> DataDirPaths:
    env_values = env or os.environ
    data_dir = Path(data_dir)
    preview_cache_dir = Path(env_values.get("QUALIFILE_PREVIEW_CACHE", data_dir / "preview_cache"))
    office_cache_dir = Path(env_values.get("QUALIFILE_OFFICE_CACHE", data_dir / "office_cache"))
    log_file = Path(env_values.get("QUALIFILE_LOG_FILE", data_dir / "activity.log"))
    notes_dir = data_dir / "notes"
    logs_dir = data_dir / "logs"
    internal_dir = data_dir / ".qualifile_internal"
    validation_dir = internal_dir / "validation"
    diagnostics_dir = data_dir / "diagnostics"
    return DataDirPaths(
        data_dir=data_dir,
        preview_cache_dir=preview_cache_dir,
        office_cache_dir=office_cache_dir,
        log_file=log_file,
        notes_dir=notes_dir,
        logs_dir=logs_dir,
        internal_dir=internal_dir,
        validation_dir=validation_dir,
        diagnostics_dir=diagnostics_dir,
    )


def ensure_directories(paths: DataDirPaths) -> None:
    for folder in (
        paths.data_dir,
        paths.preview_cache_dir,
        paths.office_cache_dir,
        paths.notes_dir,
        paths.logs_dir,
        paths.internal_dir,
        paths.validation_dir,
        paths.diagnostics_dir,
    ):
        Path(folder).mkdir(parents=True, exist_ok=True)


__all__ = ["DataDirPaths", "ensure_directories", "resolve_data_dir", "resolve_paths"]
