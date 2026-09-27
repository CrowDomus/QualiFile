"""Bounded, redacted support-bundle generation with explicit P3 consent."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import secrets
import threading
import time
from typing import Any, Iterable, Mapping
import zipfile

from ..data_dir import resolve_paths
from ..diagnostics.state import collect_data_state
from ..migrations.backup import backup_root
from ..redaction import redact_text, redact_value


DEFAULT_BUNDLE_DIRNAME = "support"
MANIFEST_SCHEMA_VERSION = 2
MAX_BUNDLE_FILES = 1000
MAX_SOURCE_FILE_BYTES = 16 * 1024 * 1024
MAX_BUNDLE_SOURCE_BYTES = 100 * 1024 * 1024
P3_CONSENT_TTL_SECONDS = 300

STARTUP_LOG_FILES = (
    "portable_startup.log",
    "launcher_startup.log",
    "embedded_backend_startup.log",
    "portable_backend.log",
)


@dataclass(frozen=True)
class SupportBundleResult:
    bundle_path: Path
    manifest: dict[str, object]
    included: list[str]


@dataclass(frozen=True)
class SupportBundlePreview:
    manifest: dict[str, object]
    consent_token: str | None


@dataclass(frozen=True)
class _Source:
    path: Path
    arcname: str
    category: str
    privacy_class: str
    size: int
    mtime_ns: int
    sha256: str


_CONSENT_LOCK = threading.Lock()
_P3_CONSENTS: dict[str, tuple[float, tuple[_Source, ...]]] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_compact() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _is_safe_source(path: Path, data_dir: Path) -> bool:
    try:
        if path.is_symlink() or not path.is_file():
            return False
        resolved = path.resolve(strict=True)
        resolved.relative_to(data_dir)
        cursor = path
        while cursor != data_dir:
            if cursor.is_symlink():
                return False
            cursor = cursor.parent
        return True
    except (OSError, RuntimeError, ValueError):
        return False


def _source(
    path: Path,
    data_dir: Path,
    *,
    category: str,
    privacy_class: str,
) -> _Source:
    if not _is_safe_source(path, data_dir):
        raise ValueError("Support source is unsafe or outside the data directory.")
    stat = path.stat()
    if stat.st_size > MAX_SOURCE_FILE_BYTES:
        raise ValueError("Support source exceeds the per-file size limit.")
    relative = path.resolve().relative_to(data_dir).as_posix()
    return _Source(
        path=path.resolve(),
        arcname=f"{category}/{relative}",
        category=category,
        privacy_class=privacy_class,
        size=stat.st_size,
        mtime_ns=stat.st_mtime_ns,
        sha256=_sha256(path),
    )


def _iter_files(base: Path) -> Iterable[Path]:
    if base.is_symlink():
        raise ValueError("Support source tree contains a symbolic link.")
    if base.is_file():
        yield base
        return
    for path in base.rglob("*"):
        if path.is_symlink():
            raise ValueError("Support source tree contains a symbolic link.")
        if path.is_file():
            yield path


def _log_paths(data_dir: Path) -> list[Path]:
    # A support preview is bound to its explicit data directory. Ambient
    # application overrides must not redirect consent to another run/root.
    paths = resolve_paths(data_dir, env={})
    items: list[Path] = []
    if paths.log_file.exists():
        items.append(paths.log_file)
    if paths.logs_dir.exists():
        items.extend(paths.logs_dir.glob("errors.log*"))
        items.extend(
            candidate
            for name in STARTUP_LOG_FILES
            if (candidate := paths.logs_dir / name).exists()
        )
    return sorted(set(items))


def _diagnostic_paths(data_dir: Path) -> list[Path]:
    diagnostics_dir = data_dir / "diagnostics"
    return [
        path
        for path in (
            diagnostics_dir / "data_state.json",
            diagnostics_dir / "last_migration_report.json",
            diagnostics_dir / "upgrade_in_progress.json",
        )
        if path.exists()
    ]


def _p3_roots(data_dir: Path) -> list[Path]:
    paths = resolve_paths(data_dir, env={})
    return [
        path
        for path in (
            paths.preview_cache_dir,
            paths.office_cache_dir,
            data_dir / ".qualifile_internal" / "avatars",
            backup_root(data_dir),
        )
        if path.exists()
    ]


def _collect_sources(data_dir: Path, *, include_p3: bool) -> tuple[_Source, ...]:
    sources: list[_Source] = []
    for path in _log_paths(data_dir):
        sources.append(_source(path, data_dir, category="logs", privacy_class="P1"))
    for path in _diagnostic_paths(data_dir):
        sources.append(_source(path, data_dir, category="diagnostics", privacy_class="P1"))
    if include_p3:
        for root in _p3_roots(data_dir):
            for path in _iter_files(root):
                sources.append(_source(path, data_dir, category="p3", privacy_class="P3"))
    if len(sources) > MAX_BUNDLE_FILES:
        raise ValueError("Support bundle source count exceeds the limit.")
    if sum(source.size for source in sources) > MAX_BUNDLE_SOURCE_BYTES:
        raise ValueError("Support bundle source bytes exceed the limit.")
    return tuple(sources)


def _manifest(sources: tuple[_Source, ...], *, include_p3: bool) -> dict[str, object]:
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "generated_at": _now_iso(),
        "include_p3": include_p3,
        "limits": {
            "max_files": MAX_BUNDLE_FILES,
            "max_file_bytes": MAX_SOURCE_FILE_BYTES,
            "max_source_bytes": MAX_BUNDLE_SOURCE_BYTES,
        },
        "files": [
            {
                "name": source.arcname,
                "category": source.category,
                "privacy_class": source.privacy_class,
                "size": source.size,
                "sha256": source.sha256,
            }
            for source in sources
        ],
    }


def preview_support_bundle(
    data_dir: Path,
    *,
    include_p3: bool = False,
) -> SupportBundlePreview:
    data_dir = Path(data_dir).expanduser().resolve(strict=True)
    sources = _collect_sources(data_dir, include_p3=include_p3)
    manifest = _manifest(sources, include_p3=include_p3)
    token = None
    if include_p3:
        token = secrets.token_urlsafe(32)
        with _CONSENT_LOCK:
            now = time.monotonic()
            expired = [
                key
                for key, (expires_at, _sources) in _P3_CONSENTS.items()
                if expires_at <= now
            ]
            for key in expired:
                _P3_CONSENTS.pop(key, None)
            _P3_CONSENTS[token] = (now + P3_CONSENT_TTL_SECONDS, sources)
    return SupportBundlePreview(manifest=manifest, consent_token=token)


def _consume_p3_consent(token: str | None, sources: tuple[_Source, ...]) -> None:
    if not token:
        raise PermissionError("Explicit P3 support-bundle consent is required.")
    with _CONSENT_LOCK:
        record = _P3_CONSENTS.pop(token, None)
    if record is None:
        raise PermissionError("P3 support-bundle consent is invalid or already used.")
    expires_at, approved_sources = record
    if expires_at <= time.monotonic() or approved_sources != sources:
        raise PermissionError("P3 support-bundle consent is expired or stale.")


def _revalidate(source: _Source) -> None:
    stat = source.path.stat()
    if (
        source.path.is_symlink()
        or stat.st_size != source.size
        or stat.st_mtime_ns != source.mtime_ns
        or _sha256(source.path) != source.sha256
    ):
        raise ValueError("Support source changed after preview.")


def _sanitized_content(source: _Source) -> bytes:
    raw = source.path.read_bytes()
    if source.privacy_class == "P3":
        return raw
    text = raw.decode("utf-8", errors="replace")
    if source.path.suffix.casefold() == ".json":
        try:
            payload = json.loads(text)
        except (TypeError, ValueError):
            payload = None
        if payload is not None:
            return json.dumps(
                redact_value(payload),
                indent=2,
                ensure_ascii=True,
            ).encode("utf-8")
    lines = []
    for line in text.splitlines():
        # Activity/error logs may be JSONL despite their .log extension.
        try:
            payload = json.loads(line)
        except (TypeError, ValueError):
            payload = None
        if isinstance(payload, (dict, list)):
            lines.append(json.dumps(redact_value(payload), ensure_ascii=True))
        else:
            lines.append(redact_text(line))
    return ("\n".join(lines) + "\n").encode("utf-8")


def _support_summary(config: Mapping[str, Any] | None) -> dict[str, object]:
    config = config or {}
    return {
        "generated_at": _now_iso(),
        "app_version": redact_text(config.get("APP_VERSION", "unknown"), max_chars=128),
        "privacy": "P1 unless a manifest entry is explicitly marked P3",
    }


def create_support_bundle(
    data_dir: Path,
    *,
    include_p3: bool = False,
    p3_consent_token: str | None = None,
    output_dir: Path | None = None,
    config: Mapping[str, Any] | None = None,
) -> SupportBundleResult:
    data_dir = Path(data_dir).expanduser().resolve(strict=True)
    sources = _collect_sources(data_dir, include_p3=include_p3)
    if include_p3:
        _consume_p3_consent(p3_consent_token, sources)
    for source in sources:
        _revalidate(source)

    bundle_dir = (
        Path(output_dir).expanduser().resolve()
        if output_dir
        else data_dir / DEFAULT_BUNDLE_DIRNAME
    )
    bundle_dir.mkdir(parents=True, exist_ok=True)
    bundle_path = bundle_dir / f"support_bundle_{_now_compact()}_{secrets.token_hex(4)}.zip"
    manifest = _manifest(sources, include_p3=include_p3)
    included = [source.arcname for source in sources]

    with bundle_path.open("xb") as raw_bundle:
        with zipfile.ZipFile(raw_bundle, "w", compression=zipfile.ZIP_DEFLATED) as zip_file:
            for source in sources:
                zip_file.writestr(source.arcname, _sanitized_content(source))
            zip_file.writestr(
                "support_bundle_summary.json",
                json.dumps(_support_summary(config), indent=2, ensure_ascii=True),
            )
            zip_file.writestr(
                "support_bundle_manifest.json",
                json.dumps(manifest, indent=2, ensure_ascii=True),
            )

    return SupportBundleResult(
        bundle_path=bundle_path,
        manifest=manifest,
        included=included,
    )


__all__ = [
    "SupportBundlePreview",
    "SupportBundleResult",
    "create_support_bundle",
    "preview_support_bundle",
    "DEFAULT_BUNDLE_DIRNAME",
]
