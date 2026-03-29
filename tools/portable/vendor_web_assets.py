"""Download and extract vendored web assets for offline portable builds."""

from __future__ import annotations

import json
import tarfile
import urllib.request
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "docs" / "portable_windows" / "vendor" / "vendor_manifest.json"


def _read_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8-sig"))


def _download(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        return
    with urllib.request.urlopen(url) as response:
        data = response.read()
    target.write_bytes(data)


def _process_files(entries: Iterable[dict]) -> None:
    for entry in entries:
        url = entry["url"]
        dest = ROOT / entry["dest"]
        _download(url, dest)


def _extract_file(archive: tarfile.TarFile, source: str, dest: Path) -> None:
    try:
        member = archive.getmember(source)
    except KeyError as exc:
        raise FileNotFoundError(f"Missing {source} in archive.") from exc
    if member.isdir():
        raise IsADirectoryError(f"Expected file but found directory: {source}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    handle = archive.extractfile(member)
    if handle is None:
        raise FileNotFoundError(f"Unable to read {source} from archive.")
    with handle:
        dest.write_bytes(handle.read())


def _extract_dir(archive: tarfile.TarFile, source: str, dest: Path) -> None:
    prefix = source.rstrip("/") + "/"
    extracted = False
    for member in archive.getmembers():
        if not member.isfile():
            continue
        if not member.name.startswith(prefix):
            continue
        relative = Path(member.name[len(prefix):])
        if not relative.parts:
            continue
        target = dest / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        handle = archive.extractfile(member)
        if handle is None:
            continue
        with handle:
            target.write_bytes(handle.read())
        extracted = True
    if not extracted:
        raise FileNotFoundError(f"No files found under {source} in archive.")


def _extract_entries(archive: tarfile.TarFile, entries: Iterable[dict]) -> None:
    for entry in entries:
        source = entry["source"]
        dest = ROOT / entry["dest"]
        if entry.get("type") == "dir":
            _extract_dir(archive, source, dest)
        else:
            _extract_file(archive, source, dest)


def _process_archive(spec: dict) -> None:
    url = spec["url"]
    name = spec.get("name", "archive")
    version = spec.get("version", "")
    cache_name = f"{name}-{version}.tgz" if version else f"{name}.tgz"
    cache_path = ROOT / ".tmp" / "vendor_cache" / cache_name
    _download(url, cache_path)
    with tarfile.open(cache_path, "r:gz") as archive:
        _extract_entries(archive, spec.get("extract", []))


def main() -> None:
    data = _read_manifest()
    _process_files(data.get("files", []))
    for spec in data.get("archives", []):
        _process_archive(spec)


if __name__ == "__main__":
    main()
