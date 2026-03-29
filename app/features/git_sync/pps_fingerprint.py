"""Snapshot fingerprint helpers for PPS integrity verification."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

MANIFEST_FILENAME = "manifest.json"
FINGERPRINT_ROOT_NAME = ".qualifile_sync"
_TMP_PREFIX = ".qualifile_sync.tmp-"
_BAK_PREFIX = ".qualifile_sync.bak-"
_KEEP_FILENAME = ".keep"


@dataclass(frozen=True)
class SnapshotFingerprintRecord:
    relpath: str
    size: int
    sha256: str


def _is_volatile_artifact_part(part: str) -> bool:
    return part.startswith(_TMP_PREFIX) or part.startswith(_BAK_PREFIX)


def list_snapshot_fingerprint_records(
    snapshot_dir: Path | str,
    *,
    fingerprint_root_name: str = FINGERPRINT_ROOT_NAME,
) -> list[SnapshotFingerprintRecord]:
    """Collect normalized fingerprint records under `.qualifile_sync/`."""

    snapshot = Path(snapshot_dir)
    if not snapshot.exists() or not snapshot.is_dir():
        raise FileNotFoundError(f"Snapshot directory does not exist: {snapshot}")
    if not fingerprint_root_name or "/" in fingerprint_root_name or "\\" in fingerprint_root_name:
        raise ValueError("fingerprint_root_name must be a single path segment.")

    records: list[SnapshotFingerprintRecord] = []
    for candidate in snapshot.rglob("*"):
        if not candidate.is_file():
            continue
        if candidate.name == MANIFEST_FILENAME:
            continue
        if candidate.name == _KEEP_FILENAME:
            continue

        inner_relpath = candidate.relative_to(snapshot).as_posix()
        if any(_is_volatile_artifact_part(part) for part in inner_relpath.split("/")):
            continue
        relpath = f"{fingerprint_root_name}/{inner_relpath}"

        digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
        records.append(
            SnapshotFingerprintRecord(
                relpath=relpath,
                size=candidate.stat().st_size,
                sha256=digest,
            )
        )

    records.sort(key=lambda rec: rec.relpath.encode("utf-8"))
    return records


def compute_snapshot_fingerprint(
    snapshot_dir: Path | str,
    *,
    fingerprint_root_name: str = FINGERPRINT_ROOT_NAME,
) -> str:
    """Compute deterministic SHA-256 fingerprint for a `.qualifile_sync` snapshot."""

    records = list_snapshot_fingerprint_records(snapshot_dir, fingerprint_root_name=fingerprint_root_name)
    stream = bytearray()
    for record in records:
        stream.extend(record.relpath.encode("utf-8"))
        stream.extend(b"\0")
        stream.extend(str(record.size).encode("utf-8"))
        stream.extend(b"\0")
        stream.extend(record.sha256.encode("utf-8"))
        stream.extend(b"\n")
    return hashlib.sha256(bytes(stream)).hexdigest()


__all__ = [
    "FINGERPRINT_ROOT_NAME",
    "SnapshotFingerprintRecord",
    "compute_snapshot_fingerprint",
    "list_snapshot_fingerprint_records",
]
