"""Editable image documents and immutable pre-change versions."""

from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import math
import os
import re
from pathlib import Path
import tempfile
import threading
from datetime import datetime, timezone
from uuid import uuid4

from PIL import Image, ImageOps

from ..filesystem.service import resolve_within_root
from ...shared.db_roots import ensure_root

IMAGE_LOCK = threading.RLock()
SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
MAX_BYTES = 40 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def image_size(data):
    with Image.open(io.BytesIO(data)) as image:
        if image.width > 8192 or image.height > 8192 or image.width * image.height > 40_000_000:
            raise ValueError("Image dimensions exceed the annotation limit.")
        return ImageOps.exif_transpose(image).size


def decode_overlay(value, size):
    if not isinstance(value, str) or not value.startswith("data:image/png;base64,"):
        raise ValueError("A PNG annotation layer is required.")
    data = base64.b64decode(value.split(",", 1)[1], validate=True)
    if len(data) > MAX_BYTES or image_size(data) != size:
        raise ValueError("Annotation layer dimensions do not match the image.")
    with Image.open(io.BytesIO(data)) as image:
        if image.format != "PNG":
            raise ValueError("Invalid annotation layer format.")
        image.verify()
    return data


def validate_document(document, size):
    if not isinstance(document, dict) or set(document) != {"version", "width", "height", "nodes"}:
        raise ValueError("Invalid annotation document.")
    if document["version"] != 1 or (document["width"], document["height"]) != size:
        raise ValueError("Annotation document dimensions do not match the image.")
    nodes = document["nodes"]
    if not isinstance(nodes, list) or len(nodes) > 2000 or len(json.dumps(document)) > 2_000_000:
        raise ValueError("Annotation document is too large.")
    allowed = {"Group", "Rect", "Ellipse", "Circle", "Line", "Arrow", "Text"}
    # Persist only declarative drawing attributes, never executable or image sources.
    forbidden = {"image", "sceneFunc", "hitFunc", "filters", "container", "__proto__", "constructor", "prototype"}
    count = 0

    def check(node, depth=0):
        nonlocal count
        count += 1
        if count > 10000 or depth > 8 or not isinstance(node, dict):
            raise ValueError("Invalid annotation node.")
        if set(node) - {"className", "attrs", "children"} or node.get("className") not in allowed:
            raise ValueError("Unsupported annotation shape.")
        attrs = node.get("attrs", {})
        if not isinstance(attrs, dict) or forbidden.intersection(attrs):
            raise ValueError("Invalid annotation attributes.")
        for key, value in attrs.items():
            if key.startswith("on") or not isinstance(value, (str, int, float, bool, list, type(None))):
                raise ValueError("Unsupported annotation attribute.")
            values = value if isinstance(value, list) else [value]
            if len(values) > 100000:
                raise ValueError("Annotation attribute is too large.")
            for part in values:
                if isinstance(part, (int, float)) and (not math.isfinite(part) or abs(part) > 10_000_000):
                    raise ValueError("Invalid annotation coordinate.")
                if isinstance(part, (dict, list)):
                    raise ValueError("Invalid annotation attribute value.")
        children = node.get("children", [])
        if not isinstance(children, list):
            raise ValueError("Invalid annotation children.")
        for child in children:
            check(child, depth + 1)

    for node in nodes:
        check(node)
    return document


class ImageHistory:
    def __init__(self, conn, root, data_dir):
        self.conn = conn
        self.root = Path(root).resolve()
        with conn:
            self.root_id = ensure_root(conn, str(self.root))
        self.data_dir = Path(data_dir).resolve()
        self.internal_dir = self.data_dir / ".qualifile_internal"
        self.assets = self.internal_dir / "image_assets"
        self.archive_root = self.internal_dir / "image_history"

    def target(self, relative):
        path = resolve_within_root(self.root, relative)
        if path.suffix.lower() not in SUFFIXES or not path.is_file():
            raise ValueError("Select a supported image file.")
        if path.stat().st_size > MAX_BYTES:
            raise ValueError("Image is too large.")
        return path

    def _blob(self, data, folder=None):
        local_asset = folder is None
        folder = Path(folder) if folder else self.assets
        for part in (folder, *folder.parents):
            if part.is_symlink():
                raise ValueError("Archive and image storage paths must not use symbolic links.")
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / (digest(data) + ".blob")
        if not path.exists():
            # Exclusive creation and flush make the blob durable before publication.
            try:
                with path.open("xb") as output:
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
            except FileExistsError:
                pass
        if digest(path.read_bytes()) != digest(data):
            raise OSError("Stored image verification failed. No changes were saved.")
        if local_asset:
            return (Path("image_assets") / path.name).as_posix()
        if path.is_relative_to(self.archive_root):
            return (Path("image_history") / path.relative_to(self.archive_root)).as_posix()
        return str(path)

    def _read_blob(self, path):
        path = Path(path)
        if not path.is_absolute():
            if path.parent == Path("image_assets"):
                path = self.assets / path.name
            elif (len(path.parts) == 4 and path.parts[0] == "image_history"
                  and re.fullmatch(r"[A-Za-z0-9_-]+", path.parts[1])
                  and re.fullmatch(r"[0-9a-f]{32}", path.parts[2])
                  and re.fullmatch(r"[0-9a-f]{64}\.blob", path.parts[3])):
                path = self.internal_dir / path
            else:
                raise ValueError("Invalid image asset reference.")
        data = path.read_bytes()
        if digest(data) != path.stem:
            raise OSError("Archived image failed its integrity check.")
        return data

    def _put_state(self, file_id, state):
        self.conn.execute("UPDATE image_documents SET state_json=? WHERE file_id=?", (json.dumps(state), file_id))

    def document(self, relative):
        target = self.target(relative)
        relative = target.relative_to(self.root).as_posix()
        data = target.read_bytes()
        row = self.conn.execute("SELECT file_id,state_json FROM image_documents WHERE root_id=? AND path=?", (self.root_id, relative)).fetchone()
        if row:
            file_id, raw = row
            state = json.loads(raw)
            pending = self.conn.execute("SELECT before_json,after_json FROM image_pending_writes WHERE file_id=?", (file_id,)).fetchone()
            if pending:
                before, after = map(json.loads, pending)
                if digest(data) == after["hash"]:
                    state = after
                elif digest(data) == before["hash"]:
                    state = before
                else:
                    raise ValueError("An interrupted image save needs recovery before further edits.")
                with self.conn:
                    self._put_state(file_id, state)
                    self.conn.execute("DELETE FROM image_pending_writes WHERE file_id=?", (file_id,))
        else:
            file_id, state = uuid4().hex, {}
        if state.get("hash") != digest(data):
            # External edits invalidate the relationship to the stored clean base.
            width, height = image_size(data)
            state = {"hash": digest(data), "base": self._blob(data), "overlay": None,
                     "document": {"version": 1, "width": width, "height": height, "nodes": []}}
            with self.conn:
                self.conn.execute("INSERT INTO image_documents(file_id,root_id,path,state_json) VALUES(?,?,?,?) ON CONFLICT(root_id,path) DO UPDATE SET state_json=excluded.state_json", (file_id, self.root_id, relative, json.dumps(state)))
        return file_id, state

    def settings(self):
        root_scope = "root:" + self.root_id
        projects = self.conn.execute("SELECT project_id FROM projects WHERE root_id=? OR root_path=? ORDER BY project_id", (self.root_id, str(self.root))).fetchall()
        scope = "project:" + projects[0][0] if projects else root_scope
        row = self.conn.execute("SELECT enabled,archive_path FROM focused_settings WHERE scope_id=?", (scope,)).fetchone()
        if row is None and scope != root_scope:
            row = self.conn.execute("SELECT enabled,archive_path FROM focused_settings WHERE scope_id=?", (root_scope,)).fetchone()
            if row:
                with self.conn:
                    self.conn.execute("INSERT OR IGNORE INTO focused_settings VALUES(?,?,?)", (scope, *row))
        legacy = ""
        if row and row[1]:
            old_path = Path(row[1]) / ".qualifile_internal" / "image_history"
            if old_path.resolve() != self.archive_root:
                legacy = str(old_path)
        return {"scope": scope, "archive_path": str(self.archive_root),
                "legacy_archive_path": legacy}

    def archive(self, relative, reason):
        file_id, state = self.document(relative)
        if not re.fullmatch(r"[A-Za-z0-9_-]+", self.root_id) or not re.fullmatch(r"[0-9a-f]{32}", file_id):
            raise ValueError("Invalid workspace archive identity.")
        folder = self.archive_root / self.root_id / file_id
        snapshot = dict(state)
        snapshot["base"] = self._blob(self._read_blob(state["base"]), folder)
        if state.get("overlay"):
            snapshot["overlay"] = self._blob(self._read_blob(state["overlay"]), folder)
        data = self.target(relative).read_bytes()
        if digest(data) != state["hash"]:
            raise ValueError("Image changed during archiving. Reload and retry.")
        image_path = self._blob(data, folder)
        with self.conn:
            self.conn.execute("INSERT INTO image_versions VALUES(?,?,?,?,?,?)", (uuid4().hex, file_id, datetime.now(timezone.utc).isoformat(), reason, image_path, json.dumps(snapshot)))

    def save(self, relative, binary, document, overlay, expected_hash, *, destination=None, reason="Annotation save", restored_state=None):
        with IMAGE_LOCK:
            target = self.target(relative)
            file_id, before = self.document(relative)
            if expected_hash != before["hash"]:
                raise ValueError("Image changed since it was opened. Reload it before saving.")
            size = image_size(binary)
            if restored_state is None:
                validate_document(document, size)
                if size != (before["document"]["width"], before["document"]["height"]):
                    raise ValueError("Exact annotation duplication requires matching image dimensions.")
                after = {"hash": digest(binary), "base": before["base"], "document": document,
                         "overlay": self._blob(overlay) if overlay else None}
            else:
                after = restored_state
            if destination is not None:
                target = resolve_within_root(self.root, destination)
                destination = target.relative_to(self.root).as_posix()
                if target.exists():
                    raise FileExistsError("A file with this name already exists.")
                file_id = uuid4().hex
            elif after == before:
                return
            else:
                self.archive(relative, reason)
            # The journal allows recovery after either side of the filesystem commit.
            self._blob(binary)
            with self.conn:
                if destination is not None:
                    self.conn.execute("INSERT INTO image_documents VALUES(?,?,?,?)", (file_id, self.root_id, destination, json.dumps(before)))
                self.conn.execute("INSERT OR REPLACE INTO image_pending_writes VALUES(?,?,?)", (file_id, json.dumps(before), json.dumps(after)))
            stage = None
            try:
                with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".qualifile-operation-", delete=False) as output:
                    stage = Path(output.name)
                    output.write(binary)
                    output.flush()
                    os.fsync(output.fileno())
                if destination is None and digest(target.read_bytes()) != before["hash"]:
                    raise ValueError("Image changed during save. Reload and retry.")
                if destination is not None:
                    # Windows rename refuses replacement and also works on FAT volumes.
                    if os.name == "nt":
                        os.rename(stage, target)
                    else:
                        os.link(stage, target)
                else:
                    os.replace(stage, target)
                with self.conn:
                    self._put_state(file_id, after)
                    self.conn.execute("DELETE FROM image_pending_writes WHERE file_id=?", (file_id,))
            except BaseException:
                if destination is not None and not target.exists():
                    with self.conn:
                        self.conn.execute("DELETE FROM image_pending_writes WHERE file_id=?", (file_id,))
                        self.conn.execute("DELETE FROM image_documents WHERE file_id=?", (file_id,))
                raise
            finally:
                if stage:
                    stage.unlink(missing_ok=True)

    def replace_capture(self, relative, binary):
        """Archive the prior image and start a clean annotation state for a capture."""
        with IMAGE_LOCK:
            _, before = self.document(relative)
            width, height = image_size(binary)
            after = {"hash": digest(binary), "base": self._blob(binary), "overlay": None,
                     "document": {"version": 1, "width": width, "height": height, "nodes": []}}
            self.save(relative, binary, None, None, before["hash"],
                      reason="Replaced by capture", restored_state=after)

    def duplicate(self, reference, targets, *, preserve_existing=False):
        return list(self.iter_duplicate(reference, targets, preserve_existing=preserve_existing))

    def iter_duplicate(self, reference, targets, *, preserve_existing=False):
        with IMAGE_LOCK:
            _, source = self.document(reference)
            if not source["document"]["nodes"] or not source["overlay"]:
                raise ValueError("The reference image does not have annotations.")
            overlay_bytes = self._read_blob(source["overlay"])
            for relative in dict.fromkeys(targets):
                try:
                    if self.target(relative) == self.target(reference):
                        yield {"path": relative, "status": "skipped"}
                        continue
                    _, target_state = self.document(relative)
                    if (source["document"]["width"], source["document"]["height"]) != (target_state["document"]["width"], target_state["document"]["height"]):
                        raise ValueError("Exact duplication requires matching image dimensions.")
                    document = source["document"]
                    applied_overlay = overlay_bytes
                    if preserve_existing and target_state["document"]["nodes"]:
                        if not target_state["overlay"]:
                            raise ValueError("Existing annotation layer is unavailable.")
                        copied_nodes = copy.deepcopy(source["document"]["nodes"])
                        for node in copied_nodes:
                            node.setdefault("attrs", {})["annotationId"] = f"annotation-{uuid4().hex}"
                        document = {
                            **target_state["document"],
                            "nodes": [*target_state["document"]["nodes"], *copied_nodes],
                        }
                        validate_document(document, (document["width"], document["height"]))
                        with Image.open(io.BytesIO(self._read_blob(target_state["overlay"]))) as existing, Image.open(io.BytesIO(overlay_bytes)) as added:
                            merged = Image.alpha_composite(existing.convert("RGBA"), added.convert("RGBA"))
                            output_overlay = io.BytesIO()
                            merged.save(output_overlay, format="PNG")
                            applied_overlay = output_overlay.getvalue()
                    with Image.open(io.BytesIO(self._read_blob(target_state["base"]))) as base, Image.open(io.BytesIO(applied_overlay)) as overlay:
                        composite = Image.alpha_composite(ImageOps.exif_transpose(base).convert("RGBA"), overlay.convert("RGBA"))
                        fmt = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".webp": "WEBP"}[Path(relative).suffix.lower()]
                        output = io.BytesIO()
                        if fmt == "JPEG":
                            composite = composite.convert("RGB")
                        composite.save(output, format=fmt, **({"quality": 92} if fmt == "JPEG" else {"lossless": True} if fmt == "WEBP" else {}))
                    self.save(relative, output.getvalue(), document, applied_overlay, target_state["hash"], reason="Added reference annotations" if preserve_existing else "Applied reference annotations")
                    yield {"path": relative, "status": "saved"}
                except (ValueError, OSError) as exc:
                    yield {"path": relative, "status": "failed", "error": str(exc)}

    def versions(self, relative):
        file_id, _ = self.document(relative)
        rows = self.conn.execute("SELECT version_id,created_at,reason,state_json FROM image_versions WHERE file_id=? ORDER BY created_at DESC", (file_id,)).fetchall()
        return [{"id": row[0], "created_at": row[1], "reason": row[2], "width": json.loads(row[3])["document"]["width"], "height": json.loads(row[3])["document"]["height"]} for row in rows]

    def version(self, relative, version_id):
        file_id, _ = self.document(relative)
        row = self.conn.execute("SELECT image_path,state_json FROM image_versions WHERE file_id=? AND version_id=?", (file_id, version_id)).fetchone()
        if not row:
            raise ValueError("Previous version not found for this image.")
        return self._read_blob(row[0]), json.loads(row[1])

    def restore(self, relative, version_id, expected_hash):
        with IMAGE_LOCK:
            data, state = self.version(relative, version_id)
            state["base"] = self._blob(self._read_blob(state["base"]))
            if state.get("overlay"):
                state["overlay"] = self._blob(self._read_blob(state["overlay"]))
            self.save(relative, data, None, None, expected_hash, reason="Restored previous version", restored_state=state)

    def reassign(self, old, new):
        old, new = str(old).replace("\\", "/"), str(new).replace("\\", "/")
        rows = self.conn.execute("SELECT file_id,path FROM image_documents WHERE root_id=?", (self.root_id,)).fetchall()
        with self.conn:
            for file_id, path in rows:
                if path == old or path.startswith(old + "/"):
                    mapped = new + path[len(old):]
                    self.conn.execute("UPDATE image_versions SET file_id=? WHERE file_id IN (SELECT file_id FROM image_documents WHERE root_id=? AND path=? AND file_id<>?)", (file_id, self.root_id, mapped, file_id))
                    # A replaced destination keeps its separate history record detached.
                    self.conn.execute("UPDATE image_documents SET path=? WHERE root_id=? AND path=? AND file_id<>?", (".detached/" + uuid4().hex, self.root_id, mapped, file_id))
                    self.conn.execute("UPDATE image_documents SET path=? WHERE file_id=?", (mapped, file_id))


def prepare_image_transfer(root, source, destination):
    """Protect overwritten images and capture annotation ownership before transfer."""
    from flask import current_app, has_app_context
    from ...shared.db import get_db
    if not has_app_context():
        return None
    service = ImageHistory(get_db(current_app), root, current_app.config["DATA_DIR"])
    if destination.exists():
        targets = destination.rglob("*") if destination.is_dir() else [destination]
        for target in targets:
            from ...shared.internal_paths import is_internal_path
            if target.is_file() and target.suffix.lower() in SUFFIXES and not is_internal_path(root, target):
                service.archive(target.relative_to(root).as_posix(), "File replaced")
    old = source.relative_to(root).as_posix()
    rows = service.conn.execute("SELECT path,state_json FROM image_documents WHERE root_id=?", (service.root_id,)).fetchall()
    documents = [(path, raw) for path, raw in rows if path == old or path.startswith(old + "/")]
    return service, old, destination.relative_to(root).as_posix(), documents


def finish_image_transfer(prepared, move):
    if prepared is None:
        return
    service, old, new, documents = prepared
    if move:
        service.reassign(old, new)
    else:
        with service.conn:
            for path, raw in documents:
                mapped = new + path[len(old):]
                service.conn.execute("INSERT INTO image_documents VALUES(?,?,?,?) ON CONFLICT(root_id,path) DO UPDATE SET state_json=excluded.state_json", (uuid4().hex, service.root_id, mapped, raw))
