"""Filesystem utilities for QualiFile.

This module centralises containment rules, name validation, and higher-level
operations used by the API. Keeping the logic here makes it easy to unit test
without requiring HTTP round-trips.
"""
from __future__ import annotations

import os
import re
import shutil
import stat
import time
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, List, Tuple

from ...shared.internal_paths import (
    INTERNAL_EXACT_NAMES,
    is_internal_name,
    is_internal_path,
)
ILLEGAL_CHARS = re.compile(r"[\\/:*?\"<>|]")
RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}
NUMERIC_PREFIX = re.compile(r"^\d+(?:\.\d+)*")
ARCHIVE_EXCLUDED_NAMES = set(INTERNAL_EXACT_NAMES)


def _is_internal_name(name: str) -> bool:
    return is_internal_name(name)


class PathOutsideRootError(ValueError):
    """Raised when a requested path escapes the active root folder."""


@dataclass
class Entry:
    """Snapshot of a filesystem entry at the time of listing."""

    root: Path
    path: Path
    name: str
    is_dir: bool
    size: int
    created: float
    modified: float

    @property
    def metadata(self) -> dict:
        """Return serialisable metadata for API responses."""

        relative = str(self.path.relative_to(self.root)) if self.path != self.root else '.'
        stat = {
            "name": self.name,
            "path": relative,
            "absolute": str(self.path),
            "is_dir": self.is_dir,
            "size": self.size,
            "created": datetime.fromtimestamp(self.created).isoformat(),
            "modified": datetime.fromtimestamp(self.modified).isoformat(),
            "type": "directory" if self.is_dir else (self.path.suffix.lower().lstrip(".")),
        }
        return stat


def numeric_sort_key(name: str) -> Tuple[int, Tuple[int, ...], str]:
    """Return a tuple suitable for sorting *name* using numeric prefixes."""

    lower = name.lower()
    match = NUMERIC_PREFIX.match(name)
    if not match:
        return (1, (), lower)
    parts = tuple(int(segment) for segment in match.group(0).split('.'))
    return (0, parts, lower)


def is_within_root(root: Path, candidate: Path) -> bool:
    """Return True when ``candidate`` is inside ``root`` (case-aware for Windows)."""

    base = Path(root).resolve()
    target = Path(candidate).resolve()
    try:
        target.relative_to(base)
        return True
    except ValueError:
        if os.name == "nt":
            base_norm = os.path.normcase(os.path.normpath(str(base)))
            target_norm = os.path.normcase(os.path.normpath(str(target)))
            try:
                common = os.path.commonpath([target_norm, base_norm])
            except ValueError:
                return False
            return os.path.normpath(common) == base_norm
        return False


def resolve_within_root(root: Path, relative: str | os.PathLike[str]) -> Path:
    """Resolve *relative* safely under *root* rejecting traversal attempts."""

    if not Path(root).exists():
        raise FileNotFoundError(f"Root folder '{root}' is not available.")
    base = root.resolve()
    candidate = (base / Path(relative)).resolve()
    if not is_within_root(base, candidate):
        raise PathOutsideRootError(f"Path '{candidate}' escapes root '{root}'.")
    _ensure_no_symlink(base, candidate)
    return candidate


def _ensure_no_symlink(root: Path, path: Path) -> None:
    """Raise when any path segment is a symlink."""

    current = path
    while True:
        if current.exists() and current.is_symlink():
            raise ValueError(f"Symlinks are not permitted: '{current}'.")
        if current == root or current == current.parent:
            break
        current = current.parent


def validate_name(name: str) -> str:
    """Validate filenames/folder names entered by the user."""

    name = name.strip()
    if not name:
        raise ValueError("Name cannot be empty.")
    if ILLEGAL_CHARS.search(name):
        raise ValueError("Name contains illegal characters.")
    if os.name == "nt" and name.split(".")[0].upper() in RESERVED_NAMES:
        raise ValueError("Name is reserved on Windows.")
    return name


def list_directory(root: Path, relative: str, include_subfolders: bool = False) -> List[dict]:
    """Return directory listing data for UI rendering."""

    root_resolved = Path(root).resolve()
    base = resolve_within_root(root_resolved, relative)
    if not base.exists():
        raise FileNotFoundError(str(base))
    if is_internal_path(root_resolved, base):
        raise FileNotFoundError(str(base))
    entries: List[Entry] = []
    try:
        with os.scandir(base) as iterator:
            listing = [entry for entry in iterator if not _is_internal_name(entry.name)]
    except PermissionError as exc:
        raise PermissionError(f"Permission denied accessing '{base}': {exc}") from exc
    for item in listing:
        try:
            stat_info = item.stat()
        except PermissionError as exc:
            raise PermissionError(f"File is locked or inaccessible: '{item.path}' ({exc})") from exc
        is_dir = stat.S_ISDIR(stat_info.st_mode)
        entries.append(Entry(root, Path(item.path), item.name, is_dir, stat_info.st_size, stat_info.st_ctime, stat_info.st_mtime))
    entries.sort(key=lambda entry: (not entry.is_dir,) + numeric_sort_key(entry.name))
    results = [entry.metadata for entry in entries]
    if include_subfolders:
        subfolders = []
        for entry in entries:
            if entry.is_dir:
                sub = list_directory(root, str(Path(relative) / entry.name), include_subfolders=True)
                subfolders.append({
                    "folder": entry.metadata,
                    "children": sub,
                })
        return {"entries": results, "subfolders": subfolders}
    return results


def create_folder(root: Path, relative: str, name: str) -> Path:
    """Create a new folder named ``name`` under ``relative``."""

    name = validate_name(name)
    base = resolve_within_root(root, relative)
    target = base / name
    target.mkdir(parents=False, exist_ok=False)
    return target


def create_file(root: Path, relative: str, name: str) -> Path:
    """Create a new empty file named ``name`` under ``relative``."""

    name = validate_name(name)
    base = resolve_within_root(root, relative)
    target = base / name
    target.touch(exist_ok=False)
    return target


def rename_entry(root: Path, relative: str, new_name: str) -> Path:
    """Rename the provided entry to ``new_name``.

    If the entry is a file and ``new_name`` is provided without an extension,
    preserve the existing extension so the file type remains unchanged.
    """

    new_name = validate_name(new_name)
    target = resolve_within_root(root, relative)
    final_name = new_name
    if target.is_file():
        current_suffix = ''.join(Path(target.name).suffixes)
        requested_suffix = ''.join(Path(new_name).suffixes)
        if current_suffix and not requested_suffix:
            final_name = validate_name(f"{new_name}{current_suffix}")
    destination = target.with_name(final_name)
    target.rename(destination)
    return destination


def _copy_or_move(items: Iterable[str], root: Path, destination: str, *, move: bool, on_conflict: str = "rename") -> List[dict]:
    """Shared implementation for move/copy operations."""

    dest_path = resolve_within_root(root, destination)
    results = []
    for rel in items:
        src = resolve_within_root(root, rel)
        dest_item = dest_path / Path(rel).name
        final_dest = dest_item
        if dest_item.exists():
            if on_conflict == "skip":
                results.append({"source": str(src), "status": "skipped"})
                continue
            elif on_conflict == "overwrite":
                if dest_item.is_dir():
                    shutil.rmtree(dest_item)
                else:
                    dest_item.unlink()
            else:  # rename
                stem = dest_item.stem
                suffix = dest_item.suffix
                counter = 1
                while final_dest.exists():
                    final_dest = dest_item.with_name(f"{stem} ({counter}){suffix}")
                    counter += 1
        try:
            if move:
                if src.is_dir():
                    shutil.move(str(src), final_dest)
                else:
                    shutil.move(str(src), final_dest)
                results.append({"source": str(src), "status": "moved", "destination": str(final_dest)})
            else:
                if src.is_dir():
                    shutil.copytree(src, final_dest)
                else:
                    shutil.copy2(src, final_dest)
                results.append({"source": str(src), "status": "copied", "destination": str(final_dest)})
        except PermissionError as exc:
            raise PermissionError(f"Unable to access '{src}': {exc}") from exc
    return results


def move_items(root: Path, items: Iterable[str], destination: str, on_conflict: str = "rename") -> List[dict]:
    """Move ``items`` into ``destination`` handling conflicts."""

    return _copy_or_move(items, root, destination, move=True, on_conflict=on_conflict)


def copy_items(root: Path, items: Iterable[str], destination: str, on_conflict: str = "rename") -> List[dict]:
    """Copy ``items`` into ``destination`` handling conflicts."""

    return _copy_or_move(items, root, destination, move=False, on_conflict=on_conflict)


def delete_items(root: Path, items: Iterable[str], permanent: bool = False) -> List[dict]:
    """Delete entries, optionally via a soft-delete trash folder."""

    results = []
    for rel in items:
        target = resolve_within_root(root, rel)
        if permanent:
            try:
                _delete_path_permanently(target)
            except PermissionError as exc:
                raise PermissionError(f"Cannot delete '{target}': {exc}") from exc
        else:
            # Basic soft delete: move to trash subdirectory within root
            trash_root = root / ".qualifile_trash"
            trash_root.mkdir(exist_ok=True)
            dest = trash_root / target.name
            counter = 1
            while dest.exists():
                dest = trash_root / f"{target.stem} ({counter}){target.suffix}"
                counter += 1
            shutil.move(str(target), dest)
            results.append({"path": str(target), "status": "soft-deleted", "destination": str(dest)})
            continue
        results.append({"path": str(target), "status": "deleted"})
    return results


def _default_archive_base(items: list[Path]) -> str:
    """Pick a sensible archive base name from the provided items."""

    if not items:
        return "archive"
    if len(items) == 1:
        item = items[0]
        if item.is_dir():
            return item.name or "archive"
        return item.stem or item.name or "archive"
    if all(not item.is_dir() for item in items):
        return "multiple-files"
    return "archive"


def _normalise_archive_name(name: str | None, items: list[Path]) -> str:
    """Return a validated archive filename ending with .zip."""

    base = (name or "").strip() or _default_archive_base(items)
    if base.lower().endswith(".zip"):
        base = base[:-4]
    base = validate_name(base)
    return f"{base}.zip"


def _increment_archive_name(directory: Path, filename: str) -> Path:
    """Return a non-colliding archive path using _1, _2 suffixes."""

    candidate = directory / filename
    if not candidate.exists():
        return candidate
    stem = candidate.stem if candidate.suffix else candidate.name
    suffix = candidate.suffix or ".zip"
    counter = 1
    while True:
        next_candidate = directory / f"{stem}_{counter}{suffix}"
        if not next_candidate.exists():
            return next_candidate
        counter += 1


def _determine_archive_anchor(items: list[Path]) -> Path:
    """Return the common anchor folder used for archive arcname calculation."""

    if not items:
        return Path(".")
    if len(items) == 1:
        return items[0].parent
    common = Path(os.path.commonpath([str(path) for path in items]))
    return common if common.is_dir() else common.parent


def _iter_archive_members(
    items: list[Path],
    anchor: Path,
    root: Path,
    excluded: set[Path] | None = None,
) -> Iterable[tuple[Path, str, bool]]:
    """Yield paths, arcnames, and directory flags for archive creation."""

    excluded_paths = {p.resolve() for p in excluded} if excluded else set()
    root_resolved = root.resolve()
    seen_dirs: set[str] = set()
    added_files: set[str] = set()
    for item in sorted(items, key=lambda p: p.as_posix()):
        if _is_internal_name(item.name) or is_internal_path(root_resolved, item):
            continue
        if item.resolve() in excluded_paths:
            continue
        if item.is_dir():
            for walk_root, dirs, files in os.walk(item):
                root_path = Path(walk_root)
                if root_path.resolve() in excluded_paths:
                    continue
                if is_internal_path(root_resolved, root_path):
                    dirs[:] = []
                    continue
                rel_root = root_path.relative_to(anchor).as_posix()
                if rel_root and rel_root not in seen_dirs:
                    seen_dirs.add(rel_root)
                    yield root_path, f"{rel_root}/", True
                dirs[:] = [d for d in sorted(dirs) if not _is_internal_name(d)]
                for file in sorted(files):
                    candidate = root_path / file
                    if candidate.resolve() in excluded_paths:
                        continue
                    if is_internal_path(root_resolved, candidate):
                        continue
                    rel_file = candidate.relative_to(anchor).as_posix()
                    if rel_file in added_files or _is_internal_name(candidate.name):
                        continue
                    added_files.add(rel_file)
                    yield candidate, rel_file, False
            rel_dir = item.relative_to(anchor).as_posix()
            if rel_dir and rel_dir not in seen_dirs:
                seen_dirs.add(rel_dir)
                yield item, f"{rel_dir}/", True
        else:
            arcname = item.relative_to(anchor).as_posix()
            if arcname in added_files:
                continue
            added_files.add(arcname)
            yield item, arcname, False


def _is_within(child: Path, parent: Path) -> bool:
    """Return True when ``child`` is inside ``parent``."""

    return is_within_root(parent, child)


def _prune_nested_items(items: list[Path]) -> list[Path]:
    """Remove items that live inside already-selected directories."""

    filtered: list[Path] = []
    selected_dirs: list[Path] = []
    for path in sorted(items, key=lambda p: (len(p.as_posix()), p.as_posix())):
        if any(_is_within(path, parent) for parent in selected_dirs):
            continue
        filtered.append(path)
        if path.is_dir():
            selected_dirs.append(path)
    return filtered


def create_zip_archive(root: Path, items: Iterable[str], destination: str, name: str | None = None) -> Path:
    """Create a ZIP archive containing ``items`` under ``destination``."""

    root_resolved = Path(root).resolve()
    dest_dir = resolve_within_root(root_resolved, destination or ".")
    if dest_dir.exists() and not dest_dir.is_dir():
        raise ValueError(f"Destination '{dest_dir}' is not a folder.")
    dest_dir.mkdir(parents=True, exist_ok=True)

    resolved: list[Path] = []
    for rel in items:
        if rel is None:
            continue
        candidate = resolve_within_root(root_resolved, rel)
        if not candidate.exists():
            raise FileNotFoundError(str(candidate))
        resolved.append(candidate)
    if not resolved:
        raise ValueError("No items selected to archive.")

    filtered = _prune_nested_items(resolved)
    anchor = _determine_archive_anchor(filtered)
    archive_name = _normalise_archive_name(name, filtered)
    target = _increment_archive_name(dest_dir, archive_name)
    members = list(_iter_archive_members(filtered, anchor, root_resolved, {target}))
    if not members:
        raise ValueError("No items selected to archive.")

    compression = zipfile.ZIP_DEFLATED if hasattr(zipfile, "ZIP_DEFLATED") else zipfile.ZIP_STORED
    with zipfile.ZipFile(target, "w", compression=compression, allowZip64=True) as archive:
        for source, arcname, is_dir in members:
            if is_dir:
                info = zipfile.ZipInfo(arcname if arcname.endswith("/") else f"{arcname}/")
                info.external_attr = (0o755 << 16)  # mark as directory
                archive.writestr(info, b"")
            else:
                archive.write(source, arcname)
    return target


def safe_secure_filename(name: str) -> str:
    """Return a filesystem-safe filename while preserving valid characters."""

    candidate = (name or "").strip()
    if not candidate:
        return "file"

    # Drop characters that are illegal on the current OS without altering valid ones.
    candidate = ILLEGAL_CHARS.sub("", candidate)
    candidate = candidate.replace("\0", "")

    if os.name == "nt":
        # Windows does not allow trailing spaces or dots and reserves specific basenames.
        candidate = candidate.rstrip(" .")
        stem, *rest = candidate.split(".")
        if stem.upper() in RESERVED_NAMES and stem:
            stem = f"{stem}_"
        suffix = f".{'.'.join(rest)}" if rest else ""
        candidate = f"{stem}{suffix}"

    candidate = candidate or "file"

    try:
        return validate_name(candidate)
    except ValueError:
        # If validation still fails (e.g. only illegal characters were supplied), fall back.
        fallback = ILLEGAL_CHARS.sub("", candidate).strip() or "file"
        return fallback


def describe_path(root: Path, relative: str) -> dict:
    """Return metadata about ``relative`` for preview panels."""

    target = resolve_within_root(root, relative)
    stat = target.stat()
    entry = Entry(root, target, target.name, target.is_dir(), stat.st_size, stat.st_ctime, stat.st_mtime)
    return entry.metadata


def _delete_path_permanently(target: Path) -> None:
    """Remove ``target`` handling Windows read-only and transient locks."""

    if target.is_dir():
        shutil.rmtree(target, onerror=_handle_remove_error)
        return
    try:
        target.unlink()
    except PermissionError as exc:
        _handle_remove_error(os.unlink, str(target), (PermissionError, exc, None))


def _handle_remove_error(func, path: str, exc_info) -> None:
    """Normalise permissions and retry deletions that initially fail."""

    exc = exc_info[1]
    if not isinstance(exc, PermissionError):
        raise exc
    path_obj = Path(path)
    _ensure_writable(path_obj)
    last_error = exc
    for delay in (0.0, 0.05, 0.1):
        if delay:
            time.sleep(delay)
        try:
            func(path)
            return
        except PermissionError as retry_exc:
            last_error = retry_exc
    raise PermissionError(f"Cannot delete '{path_obj}': {last_error}") from last_error


def _ensure_writable(path: Path) -> None:
    """Remove the read-only flag from ``path`` and its children if present."""

    candidates = []
    if path.exists():
        candidates.append(path)
        if path.is_dir():
            candidates.extend(child for child in path.rglob("*") if child.exists())
    for candidate in candidates:
        try:
            os.chmod(candidate, stat.S_IWRITE | stat.S_IREAD)
        except Exception:
            continue
