"""Previewed file renames with a durable recovery journal and safe duplication."""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .service import (
    _entry_identity,
    _mutation_target,
    _staged_transfer,
    numeric_sort_key,
    validate_name,
)
from ..metadata.sidecar import sidecar_path
from ..preview.image_history import IMAGE_LOCK
from ...shared.db_roots import ensure_root


def _now():
    return datetime.now(timezone.utc).isoformat()


def _identity(path):
    value = _entry_identity(path)
    return list(value) if value else None


def _files(root, items):
    if not isinstance(items, list) or not items or any(not isinstance(p, str) or not p for p in items):
        raise ValueError("Select at least one file.")
    sources, paths, identities = [], set(), set()
    for item in items:
        source = _mutation_target(root, item)
        if not source.is_file():
            raise ValueError("This action supports files only.")
        key = os.path.normcase(str(source))
        stat = source.stat()
        identity = (stat.st_dev, stat.st_ino)
        if key in paths or (stat.st_ino and identity in identities):
            raise ValueError("The same file cannot be selected more than once.")
        paths.add(key)
        identities.add(identity)
        sources.append(source)
    return sorted(sources, key=lambda p: (p.parent.as_posix().casefold(), numeric_sort_key(p.name), p.name))


def _checked_name(name):
    checked = validate_name(name)
    if checked != name or any(ord(char) < 32 for char in name):
        raise ValueError("Names cannot contain control characters or start or end with spaces.")
    if len(name.encode("utf-16-le")) // 2 > 255:
        raise ValueError("A resulting file name is longer than 255 characters.")
    return checked


class BulkFiles:
    def __init__(self, root, conn, metadata):
        self.root = Path(root).resolve()
        self.conn = conn
        self.metadata = metadata
        with conn:
            self.root_id = ensure_root(conn, str(self.root))

    def _relative(self, path):
        return path.relative_to(self.root).as_posix()

    def preview(self, items, options):
        if not isinstance(options, dict):
            raise ValueError("Rename options are required.")
        mode = options.get("mode", "affix")
        if not isinstance(mode, str) or mode not in {"affix", "sequence"}:
            raise ValueError("Choose prefix and suffix or sequential numbering.")
        prefix, suffix, base = (options.get(key, "") for key in ("prefix", "suffix", "base"))
        if any(not isinstance(value, str) or len(value) > 255 for value in (prefix, suffix, base)):
            raise ValueError("Use text of at most 255 characters for each name field.")
        start, digits = options.get("start", 1), options.get("digits", 3)
        if (isinstance(start, bool) or not isinstance(start, int) or start < 0
                or isinstance(digits, bool) or not isinstance(digits, int) or not 1 <= digits <= 12):
            raise ValueError("Use a non-negative start number and between 1 and 12 digits.")
        if mode == "sequence" and not base.strip():
            raise ValueError("Enter a base name.")
        sources = _files(self.root, items)
        rows, reserved = [], set()
        for offset, source in enumerate(sources):
            name = (f"{prefix}{source.stem}{suffix}{source.suffix}" if mode == "affix"
                    else f"{base} {str(start + offset).zfill(digits)}{source.suffix}")
            old = self._relative(source)
            row = {"old": old, "new": self._relative(source.with_name(name)) if name and '/' not in name and '\\' not in name else name,
                   "identity": _identity(source), "error": ""}
            try:
                _checked_name(name)
                target = _mutation_target(self.root, source.with_name(name), must_exist=False)
                key = os.path.normcase(str(target))
                if key in reserved:
                    raise ValueError("Two selected files would have the same name.")
                if target.exists() and not os.path.samefile(source, target):
                    raise ValueError("A file with this name already exists.")
                reserved.add(key)
                row["new"] = self._relative(target)
            except (ValueError, OSError) as exc:
                row["error"] = str(exc)
            rows.append(row)
        token = hashlib.sha256(json.dumps([self.root_id, rows], sort_keys=True).encode()).hexdigest()
        changed = sum(row["old"] != row["new"] for row in rows)
        return {"rows": rows, "token": token, "changed": changed,
                "valid": bool(changed) and not any(row["error"] for row in rows)}

    def _write(self, batch_id, status, rows, error=""):
        with self.conn:
            self.conn.execute(
                "UPDATE file_rename_batches SET status=?,rows_json=?,updated_at=?,error=? WHERE batch_id=? AND root_id=?",
                (status, json.dumps(rows), _now(), error, batch_id, self.root_id),
            )

    def _check_sidecars(self, rows):
        for folder in {self.root / Path(row["old"]).parent for row in rows}:
            path = sidecar_path(folder)
            if path.exists():
                self.metadata._load_sidecar_for_write(path)

    def _move(self, row, *, restore=False):
        before, after = (row["new"], row["old"]) if restore else (row["old"], row["new"])
        source = _mutation_target(self.root, before, must_exist=False)
        destination = _mutation_target(self.root, after, must_exist=False)
        if _identity(source) == row["identity"]:
            if destination.exists() and not os.path.samefile(source, destination):
                raise FileExistsError(f"The name '{after}' is already in use.")
            # Windows refuses replacement. POSIX link/unlink provides the same guarantee.
            if destination.exists() and os.path.normcase(str(source)) != os.path.normcase(str(destination)):
                # Recover a POSIX interruption between link creation and unlink.
                source.unlink()
            elif os.name == "nt" or destination.exists():
                source.rename(destination)
            else:
                os.link(source, destination)
                source.unlink()
        elif _identity(destination) != row["identity"] or source.exists():
            raise ValueError(f"'{before}' was moved, replaced or modified. Its name was not changed.")
        # This operation is idempotent, including after an interrupted sidecar update.
        self.metadata.reassign_path(before, after, is_dir=False)

    def apply(self, items, options, token):
        with IMAGE_LOCK:
            pending = self.conn.execute(
                "SELECT 1 FROM file_rename_batches WHERE root_id=? AND status IN ('applying','restoring','recovery') LIMIT 1",
                (self.root_id,),
            ).fetchone()
            if pending:
                raise ValueError("Restore the interrupted rename from Rename history before renaming more files.")
            plan = self.preview(items, options)
            if not plan["valid"]:
                raise ValueError("Resolve the rename conflicts before applying.")
            if token != plan["token"]:
                raise ValueError("The selected files changed. Review a fresh preview before renaming.")
            rows = [row for row in plan["rows"] if row["old"] != row["new"]]
            self._check_sidecars(rows)
            batch_id = uuid4().hex
            with self.conn:
                self.conn.execute("INSERT INTO file_rename_batches VALUES(?,?,?,?,?,?,?)",
                                  (batch_id, self.root_id, _now(), _now(), "applying", json.dumps(rows), ""))
            try:
                for row in rows:
                    self._move(row)
                self._write(batch_id, "applied", rows)
            except Exception as exc:
                self._write(batch_id, "restoring", rows, str(exc))
                try:
                    for row in reversed(rows):
                        self._move(row, restore=True)
                    self._write(batch_id, "cancelled", rows, str(exc))
                except Exception as rollback_error:
                    self._write(batch_id, "recovery", rows, str(rollback_error))
                    raise ValueError("The rename was interrupted. Open Rename history to restore the original names.") from exc
                raise ValueError(f"No names were changed. {exc}") from exc
            return {"id": batch_id, "rows": rows, "renamed": len(rows)}

    def history(self):
        records = self.conn.execute(
            "SELECT batch_id,created_at,status,rows_json,error FROM file_rename_batches "
            "WHERE root_id=? AND status NOT IN ('restored','cancelled') ORDER BY created_at DESC",
            (self.root_id,),
        ).fetchall()
        return [{"id": row[0], "created_at": row[1], "status": row[2], "rows": json.loads(row[3]), "error": row[4]}
                for row in records]

    def restore(self, batch_id):
        with IMAGE_LOCK:
            record = self.conn.execute(
                "SELECT status,rows_json FROM file_rename_batches WHERE batch_id=? AND root_id=?",
                (batch_id, self.root_id),
            ).fetchone()
            if not record or record[0] in {"restored", "cancelled"}:
                raise ValueError("This rename is no longer available to restore.")
            rows = json.loads(record[1])
            # Validate the entire batch before changing any names.
            for row in rows:
                old = _mutation_target(self.root, row["old"], must_exist=False)
                new = _mutation_target(self.root, row["new"], must_exist=False)
                if _identity(new) == row["identity"]:
                    if old.exists() and not os.path.samefile(old, new):
                        raise ValueError(f"The original name '{row['old']}' is already in use.")
                elif _identity(old) != row["identity"] or new.exists():
                    raise ValueError(f"'{row['new']}' was moved, replaced or modified. Restore was cancelled.")
            self._check_sidecars(rows)
            self._write(batch_id, "restoring", rows)
            try:
                for row in reversed(rows):
                    self._move(row, restore=True)
                self._write(batch_id, "restored", rows)
            except Exception as exc:
                self._write(batch_id, "recovery", rows, str(exc))
                raise ValueError("Restoration was interrupted. Close programs using these files and retry from Rename history.") from exc
            return {"restored": len(rows), "rows": rows}

    def duplicate(self, items):
        with IMAGE_LOCK:
            sources = _files(self.root, items)
            results = []
            for source in sources:
                try:
                    counter = 1
                    while True:
                        suffix = " - Copy" if counter == 1 else f" - Copy ({counter})"
                        stem = source.stem
                        while stem and len(f"{stem}{suffix}{source.suffix}".encode("utf-16-le")) // 2 > 255:
                            stem = stem[:-1]
                        name = _checked_name(f"{stem}{suffix}{source.suffix}")
                        target = _mutation_target(self.root, source.with_name(name), must_exist=False)
                        if not target.exists():
                            break
                        counter += 1
                    _staged_transfer(self.root, source, target, move=False, expected_destination=None)
                    results.append({"path": self._relative(source), "destination": self._relative(target), "status": "copied"})
                except (ValueError, OSError) as exc:
                    results.append({"path": self._relative(source), "status": "failed", "error": str(exc)})
            return results
