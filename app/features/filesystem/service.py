"""Filesystem utilities for QualiFile.

This module centralises containment rules, name validation, and higher-level
operations used by the API. Keeping the logic here makes it easy to unit test
without requiring HTTP round-trips.
"""
from __future__ import annotations

import errno
import os
import re
import shutil
import stat
import tempfile
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
    base = Path(root).resolve()
    # Inspect the lexical path before resolve() can erase a link or junction.
    lexical = base / Path(relative)
    _ensure_no_symlink(base, lexical)
    candidate = lexical.resolve()
    if not is_within_root(base, candidate):
        raise PathOutsideRootError(f"Path '{candidate}' escapes root '{root}'.")
    _ensure_no_symlink(base, candidate)
    return candidate


def _ensure_no_symlink(root: Path, path: Path) -> None:
    """Raise when any path segment is a symlink."""

    current = path
    while True:
        try:
            info = current.lstat()
        except FileNotFoundError:
            info = None
        if info is not None and (stat.S_ISLNK(info.st_mode) or
                getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)):
            raise ValueError(f"Links and reparse points are not permitted: '{current}'.")
        if current == root or current == current.parent:
            break
        current = current.parent


def validate_name(name: str) -> str:
    """Validate filenames/folder names entered by the user."""

    name = name.strip()
    if not name:
        raise ValueError("Name cannot be empty.")
    if name in {".", ".."} or name.endswith(".") or "\x00" in name:
        raise ValueError("Name is not a regular file or folder name.")
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
    target = _mutation_target(root, base / name, must_exist=False)
    target.mkdir(parents=False, exist_ok=False)
    return target


def create_file(root: Path, relative: str, name: str) -> Path:
    """Create a new empty file named ``name`` under ``relative``."""

    name = validate_name(name)
    base = resolve_within_root(root, relative)
    target = _mutation_target(root, base / name, must_exist=False)
    target.touch(exist_ok=False)
    return target


def rename_entry(root: Path, relative: str, new_name: str) -> Path:
    """Rename the provided entry to ``new_name``.

    If the entry is a file and ``new_name`` is provided without an extension,
    preserve the existing extension so the file type remains unchanged.
    """

    new_name = validate_name(new_name)
    target = _mutation_target(root, relative)
    final_name = new_name
    if target.is_file():
        current_suffix = ''.join(Path(target.name).suffixes)
        requested_suffix = ''.join(Path(new_name).suffixes)
        if current_suffix and not requested_suffix:
            final_name = validate_name(f"{new_name}{current_suffix}")
    destination = _mutation_target(root, target.with_name(final_name), must_exist=False)
    _validate_tree(root, target)
    if destination.exists() and destination != target:
        raise FileExistsError(str(destination))
    _mutation_target(root, target)
    target.rename(destination)
    return destination


def _mutation_target(root: Path, relative, *, must_exist=True, allow_root=False) -> Path:
    target = resolve_within_root(root, relative)
    if (target == Path(root).resolve() and not allow_root) or is_internal_path(Path(root), target):
        raise ValueError("The selected root and internal application paths cannot be changed.")
    if must_exist and not target.exists():
        raise FileNotFoundError(str(target))
    return target


def _validate_tree(root: Path, target: Path) -> None:
    """Reject links anywhere in a selected tree, without following them."""
    resolve_within_root(root, target)
    if target.is_dir():
        for directory, dirs, files in os.walk(target, followlinks=False):
            resolve_within_root(root, directory)
            for name in dirs + files:
                resolve_within_root(root, Path(directory) / name)


def _preflight_sources(root: Path, items: Iterable[str]) -> list[Path]:
    sources = [_mutation_target(root, item) for item in items]
    for index, source in enumerate(sources):
        for other in sources[:index]:
            if is_within_root(source, other) or is_within_root(other, source) or os.path.samefile(source, other):
                raise ValueError("Duplicate or ancestor/descendant selections are not allowed.")
        _validate_tree(root, source)
    return sources


def _copy_checked(root: Path, source: Path, destination: Path) -> None:
    resolve_within_root(root, source)
    resolve_within_root(root, destination)
    if source.is_dir():
        destination.mkdir()
        for child in source.iterdir():
            _copy_checked(root, child, destination / child.name)
        shutil.copystat(source, destination, follow_symlinks=False)
    else:
        shutil.copy2(source, destination, follow_symlinks=False)
    # A source changed to a link during a copy must never be published.
    resolve_within_root(root, source)
    resolve_within_root(root, destination)


def _entry_identity(path: Path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def _staged_transfer(root: Path, source: Path, destination: Path, *, move: bool, expected_destination) -> None:
    from ..preview.image_history import IMAGE_LOCK
    with IMAGE_LOCK:
        return _staged_image_transfer(root, source, destination, move=move, expected_destination=expected_destination)


def _staged_image_transfer(root: Path, source: Path, destination: Path, *, move: bool, expected_destination) -> None:
    """Stage on the destination volume, retaining the old entry until commit."""
    _mutation_target(root, source)
    _mutation_target(root, destination, must_exist=False)
    if _entry_identity(destination) != expected_destination:
        raise FileExistsError("Destination changed after preflight. Reload and retry.")
    from ..preview.image_history import prepare_image_transfer, finish_image_transfer
    image_transfer = prepare_image_transfer(root, source, destination)
    stage = Path(tempfile.mkdtemp(prefix=".qualifile-operation-", dir=destination.parent))
    payload, backup = stage / "payload", stage / "previous"
    retained = False
    source_staged = False
    try:
        if move:
            _validate_tree(root, source)
            try:
                source.replace(payload)
                source_staged = True
            except OSError as exc:
                if exc.errno != errno.EXDEV:
                    raise
        if not source_staged:
            _copy_checked(root, source, payload)
            _validate_tree(root, source)
        _validate_tree(root, payload)
        _mutation_target(root, destination, must_exist=False)
        if _entry_identity(destination) != expected_destination:
            raise FileExistsError("Destination changed during transfer. Reload and retry.")
        if destination.exists():
            _validate_tree(root, destination)
            destination.replace(backup)
        try:
            payload.replace(destination)
            finish_image_transfer(image_transfer, move)
        except BaseException:
            # Keep the published source available for the outer rollback if
            # recording image ownership fails after the filesystem commit.
            if not payload.exists() and destination.exists():
                destination.replace(payload)
            if backup.exists():
                backup.replace(destination)
            raise
        if move and not source_staged:
            try:
                _mutation_target(root, source)
                _validate_tree(root, source)
                _delete_path_permanently(source)
            except Exception as exc:
                # A cross-volume move cannot be one atomic rename. Keep both
                # recoverable copies and identify the recovery location.
                retained = True
                raise OSError(f"Move destination is complete but source cleanup failed. Recovery data: {stage}") from exc
    except BaseException as exc:
        if backup.exists() and not destination.exists():
            try:
                backup.replace(destination)
            except OSError:
                retained = True
        if source_staged and payload.exists():
            try:
                if source.exists():
                    retained = True
                else:
                    payload.rename(source)
            except OSError:
                retained = True
        if retained:
            raise OSError(f"Operation needs recovery. Preserved data: {stage}") from exc
        raise
    finally:
        if not retained:
            _validate_tree(root, stage)
            shutil.rmtree(stage)


def _copy_or_move(items: Iterable[str], root: Path, destination: str, *, move: bool, on_conflict: str = "rename") -> List[dict]:
    """Shared implementation for move/copy operations."""

    if on_conflict not in {"rename", "skip", "overwrite"}:
        raise ValueError("Unknown conflict policy.")
    dest_path = _mutation_target(root, destination, allow_root=True)
    if not dest_path.is_dir():
        raise NotADirectoryError(str(dest_path))
    sources = _preflight_sources(root, items)
    planned = []
    reserved = set()
    for src in sources:
        dest_item = _mutation_target(root, dest_path / src.name, must_exist=False)
        final_dest = dest_item
        if src.is_dir() and is_within_root(src, dest_path):
            raise ValueError("A folder cannot be transferred into itself.")
        if on_conflict == "overwrite" and dest_item.exists() and os.path.samefile(src, dest_item):
            raise ValueError("Source and overwrite destination are the same entry.")
        if dest_item.exists() or dest_item in reserved:
            if on_conflict == "skip":
                planned.append((src, None, None))
                continue
            elif on_conflict == "overwrite":
                _validate_tree(root, dest_item)
            else:  # rename
                stem = dest_item.stem
                suffix = dest_item.suffix
                counter = 1
                while final_dest.exists() or final_dest in reserved:
                    final_dest = dest_item.with_name(f"{stem} ({counter}){suffix}")
                    counter += 1
        if final_dest in reserved or any(is_within_root(final_dest, other) for other in sources):
            raise ValueError("Batch destinations overlap another selected source or destination.")
        reserved.add(final_dest)
        planned.append((src, final_dest, _entry_identity(final_dest)))
    results = []
    for src, final_dest, expected_destination in planned:
        if final_dest is None:
            results.append({"source": str(src), "status": "skipped"})
            continue
        _staged_transfer(root, src, final_dest, move=move, expected_destination=expected_destination)
        results.append({"source": str(src), "status": "moved" if move else "copied", "destination": str(final_dest)})
    return results


def move_items(root: Path, items: Iterable[str], destination: str, on_conflict: str = "rename") -> List[dict]:
    """Move ``items`` into ``destination`` handling conflicts."""

    return _copy_or_move(items, root, destination, move=True, on_conflict=on_conflict)


def copy_items(root: Path, items: Iterable[str], destination: str, on_conflict: str = "rename") -> List[dict]:
    """Copy ``items`` into ``destination`` handling conflicts."""

    return _copy_or_move(items, root, destination, move=False, on_conflict=on_conflict)


def delete_items(root: Path, items: Iterable[str], permanent: bool = False) -> List[dict]:
    """Delete entries, optionally via a soft-delete trash folder."""

    targets = _preflight_sources(root, items)
    results = []
    trash_root = resolve_within_root(root, ".qualifile_trash")
    for target in targets:
        _mutation_target(root, target)
        _validate_tree(root, target)
        if permanent:
            try:
                _delete_path_permanently(target)
            except PermissionError as exc:
                raise PermissionError(f"Cannot delete '{target}': {exc}") from exc
        else:
            # Basic soft delete: move to trash subdirectory within root
            resolve_within_root(root, trash_root)
            trash_root.mkdir(exist_ok=True)
            dest = trash_root / target.name
            counter = 1
            while dest.exists():
                dest = trash_root / f"{target.stem} ({counter}){target.suffix}"
                counter += 1
            resolve_within_root(root, dest)
            _mutation_target(root, target)
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
        resolve_within_root(root_resolved, item)
        if _is_internal_name(item.name) or is_internal_path(root_resolved, item):
            continue
        if item.resolve() in excluded_paths:
            continue
        if item.is_dir():
            for walk_root, dirs, files in os.walk(item):
                root_path = Path(walk_root)
                resolve_within_root(root_resolved, root_path)
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
                for directory in dirs:
                    resolve_within_root(root_resolved, root_path / directory)
                for file in sorted(files):
                    candidate = root_path / file
                    resolve_within_root(root_resolved, candidate)
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
    dest_dir = _mutation_target(root_resolved, destination or ".", must_exist=False, allow_root=True)
    if dest_dir.exists() and not dest_dir.is_dir():
        raise ValueError(f"Destination '{dest_dir}' is not a folder.")

    resolved: list[Path] = []
    for rel in items:
        if rel is None:
            continue
        candidate = resolve_within_root(root_resolved, rel)
        if not candidate.exists():
            raise FileNotFoundError(str(candidate))
        _validate_tree(root_resolved, candidate)
        resolved.append(candidate)
    if not resolved:
        raise ValueError("No items selected to archive.")

    filtered = _prune_nested_items(resolved)
    anchor = _determine_archive_anchor(filtered)
    archive_name = _normalise_archive_name(name, filtered)
    target = _increment_archive_name(dest_dir, archive_name)
    _mutation_target(root_resolved, target, must_exist=False)
    members = list(_iter_archive_members(filtered, anchor, root_resolved, {target}))
    if not members:
        raise ValueError("No items selected to archive.")

    compression = zipfile.ZIP_DEFLATED if hasattr(zipfile, "ZIP_DEFLATED") else zipfile.ZIP_STORED
    dest_dir.mkdir(parents=True, exist_ok=True)
    _mutation_target(root_resolved, dest_dir, allow_root=True)
    stage = Path(tempfile.mkdtemp(prefix=".qualifile-operation-", dir=dest_dir))
    try:
        payload = stage / "archive.zip"
        with zipfile.ZipFile(payload, "w", compression=compression, allowZip64=True) as archive:
            for source, arcname, is_dir in members:
                resolve_within_root(root_resolved, source)
                if is_dir:
                    info = zipfile.ZipInfo(arcname if arcname.endswith("/") else f"{arcname}/")
                    info.external_attr = (0o755 << 16)  # mark as directory
                    archive.writestr(info, b"")
                else:
                    archive.write(source, arcname)
                resolve_within_root(root_resolved, source)
        _mutation_target(root_resolved, target, must_exist=False)
        if target.exists():
            raise FileExistsError(str(target))
        payload.rename(target)
    finally:
        _validate_tree(root_resolved, stage)
        shutil.rmtree(stage)
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
