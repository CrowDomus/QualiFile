"""Auto-discovery scanning helpers for Git Sync roots."""

from __future__ import annotations

import os
import stat
import threading
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

from ...shared.root_marker import MARKER_FILENAME

PPS_DIRNAME = ".qualifile_sync"
PPS_MANIFEST_FILENAME = "manifest.json"
PPS_PROJECT_FILENAME = "project.json"
GIT_DIRNAME = ".git"

ProgressCallback = Callable[["DiscoveryProgress"], None]


@dataclass(frozen=True)
class DiscoveryCandidate:
    root_path: str
    has_root_marker: bool
    has_pps_manifest: bool
    has_pps_project: bool


@dataclass(frozen=True)
class DiscoveryProgress:
    scanned_directories: int
    discovered_roots: int
    pending_directories: int
    current_path: str | None


@dataclass(frozen=True)
class DiscoveryScanResult:
    base_paths: tuple[str, ...]
    candidates: tuple[DiscoveryCandidate, ...]
    scanned_directories: int
    cancelled: bool


class DiscoveryCancelToken:
    """Thread-safe cancellation token for long-running discovery scans."""

    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def is_cancelled(self) -> bool:
        return self._event.is_set()


def _normalize_max_depth(max_depth: int) -> int:
    depth = int(max_depth)
    if depth < 0:
        raise ValueError("max_depth must be >= 0.")
    return depth


def _path_key(path: Path) -> str:
    return os.path.normcase(str(path.resolve(strict=False)))


def _is_windows_reparse_point(path: Path) -> bool:
    if os.name != "nt":
        return False
    try:
        attrs = getattr(path.lstat(), "st_file_attributes", 0)
    except OSError:
        return False
    return bool(attrs & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))


def _is_link_like(path: Path) -> bool:
    if path.is_symlink():
        return True
    return _is_windows_reparse_point(path)


def _normalize_base_paths(base_paths: Sequence[Path | str]) -> tuple[Path, ...]:
    if not base_paths:
        raise ValueError("At least one base path is required for discovery scan.")
    normalized: list[Path] = []
    seen: set[str] = set()
    for raw in base_paths:
        resolved = Path(raw).expanduser().resolve()
        if not resolved.exists() or not resolved.is_dir():
            raise FileNotFoundError(f"Discovery base path is invalid: {resolved}")
        key = _path_key(resolved)
        if key in seen:
            continue
        seen.add(key)
        normalized.append(resolved)
    return tuple(normalized)


def _candidate_from_directory(path: Path) -> DiscoveryCandidate | None:
    marker = path / MARKER_FILENAME
    pps_dir = path / PPS_DIRNAME
    manifest = pps_dir / PPS_MANIFEST_FILENAME
    project = pps_dir / PPS_PROJECT_FILENAME

    has_marker = marker.is_file()
    has_pps_manifest = manifest.is_file()
    has_pps_project = project.is_file()
    if not has_marker and not (has_pps_manifest and has_pps_project):
        return None
    return DiscoveryCandidate(
        root_path=str(path),
        has_root_marker=has_marker,
        has_pps_manifest=has_pps_manifest,
        has_pps_project=has_pps_project,
    )


def _emit_progress(
    on_progress: ProgressCallback | None,
    *,
    scanned_directories: int,
    discovered_roots: int,
    pending_directories: int,
    current_path: Path | None,
) -> None:
    if on_progress is None:
        return
    on_progress(
        DiscoveryProgress(
            scanned_directories=scanned_directories,
            discovered_roots=discovered_roots,
            pending_directories=pending_directories,
            current_path=None if current_path is None else str(current_path),
        )
    )


def discover_sync_roots(
    base_paths: Sequence[Path | str],
    *,
    max_depth: int = 4,
    cancel_token: DiscoveryCancelToken | None = None,
    follow_symlinks: bool = False,
    on_progress: ProgressCallback | None = None,
) -> DiscoveryScanResult:
    """Scan base paths for candidate Git Sync roots with safety constraints."""

    depth_limit = _normalize_max_depth(max_depth)
    resolved_bases = _normalize_base_paths(base_paths)
    queue: deque[tuple[Path, int]] = deque((base, 0) for base in resolved_bases)
    visited: set[str] = set()
    candidates: dict[str, DiscoveryCandidate] = {}
    scanned = 0

    while queue:
        if cancel_token is not None and cancel_token.is_cancelled:
            break

        current, depth = queue.popleft()
        current_key = _path_key(current)
        if current_key in visited:
            continue
        visited.add(current_key)

        if not follow_symlinks and _is_link_like(current):
            continue

        scanned += 1
        candidate = _candidate_from_directory(current)
        if candidate is not None:
            candidates[current_key] = candidate

        _emit_progress(
            on_progress,
            scanned_directories=scanned,
            discovered_roots=len(candidates),
            pending_directories=len(queue),
            current_path=current,
        )

        if depth >= depth_limit:
            continue

        try:
            with os.scandir(current) as iterator:
                for entry in iterator:
                    if cancel_token is not None and cancel_token.is_cancelled:
                        break
                    if not entry.is_dir(follow_symlinks=follow_symlinks):
                        continue
                    if entry.name == GIT_DIRNAME:
                        continue

                    child = Path(entry.path)
                    if not follow_symlinks and _is_link_like(child):
                        continue
                    queue.append((child, depth + 1))
        except (PermissionError, FileNotFoundError, NotADirectoryError):
            continue

    _emit_progress(
        on_progress,
        scanned_directories=scanned,
        discovered_roots=len(candidates),
        pending_directories=len(queue),
        current_path=None,
    )
    return DiscoveryScanResult(
        base_paths=tuple(str(path) for path in resolved_bases),
        candidates=tuple(sorted(candidates.values(), key=lambda item: os.path.normcase(item.root_path))),
        scanned_directories=scanned,
        cancelled=bool(cancel_token is not None and cancel_token.is_cancelled),
    )


__all__ = [
    "DiscoveryCandidate",
    "DiscoveryCancelToken",
    "DiscoveryProgress",
    "DiscoveryScanResult",
    "GIT_DIRNAME",
    "PPS_DIRNAME",
    "PPS_MANIFEST_FILENAME",
    "PPS_PROJECT_FILENAME",
    "discover_sync_roots",
]
