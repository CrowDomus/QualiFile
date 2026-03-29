"""Support bundle generator for diagnostics and logs."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Iterable, Mapping
import zipfile

from ..data_dir import resolve_paths
from ..diagnostics.state import collect_data_state
from ..migrations.backup import backup_root

DEFAULT_BUNDLE_DIRNAME = "support"
MANIFEST_SCHEMA_VERSION = 1

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


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_compact() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _normalize_arcname(name: str) -> str:
    return name.replace("\\", "/")


def _safe_arcname(path: Path, data_dir: Path) -> str:
    try:
        relative = path.resolve().relative_to(data_dir.resolve())
        return _normalize_arcname(str(relative))
    except Exception:
        safe = str(path).replace(":", "").replace("\\", "/").lstrip("/")
        return _normalize_arcname(f"external/{safe}")


def _iter_existing(paths: Iterable[Path]) -> list[Path]:
    existing: list[Path] = []
    for path in paths:
        if path.exists() and path.is_file():
            existing.append(path)
    return existing


def _log_files(data_dir: Path) -> list[Path]:
    paths = resolve_paths(data_dir)
    items: list[Path] = []
    if paths.log_file.exists():
        items.append(paths.log_file)
    logs_dir = paths.logs_dir
    if logs_dir.exists():
        items.extend(logs_dir.glob("errors.log*"))
        for name in STARTUP_LOG_FILES:
            candidate = logs_dir / name
            if candidate.exists():
                items.append(candidate)
    return sorted({path.resolve() for path in items})


def _diagnostic_files(data_dir: Path) -> list[Path]:
    diagnostics_dir = Path(data_dir) / "diagnostics"
    candidates = [
        diagnostics_dir / "data_state.json",
        diagnostics_dir / "last_migration_report.json",
        diagnostics_dir / "upgrade_in_progress.json",
    ]
    return _iter_existing(candidates)


def _p3_paths(data_dir: Path) -> list[Path]:
    paths = resolve_paths(data_dir)
    candidates = [
        paths.preview_cache_dir,
        paths.office_cache_dir,
        Path(data_dir) / ".qualifile_internal" / "avatars",
        backup_root(data_dir),
    ]
    return [path for path in candidates if path.exists()]


def _add_file(zip_file: zipfile.ZipFile, path: Path, arcname: str, included: list[str]) -> None:
    zip_file.write(path, arcname)
    included.append(arcname)


def _add_tree(zip_file: zipfile.ZipFile, base: Path, data_dir: Path, included: list[str]) -> None:
    for path in base.rglob("*"):
        if not path.is_file():
            continue
        arcname = _safe_arcname(path, data_dir)
        _add_file(zip_file, path, arcname, included)


def _support_summary(data_dir: Path, config: Mapping[str, Any] | None) -> dict[str, object]:
    payload = collect_data_state(data_dir, config)
    return {
        "generated_at": _now_iso(),
        "data_dir": str(data_dir),
        "app_version": payload.get("app_version"),
        "schema_versions": payload.get("schema_versions"),
        "python": payload.get("runtime", {}).get("python"),
        "platform": payload.get("runtime", {}).get("platform"),
    }


def create_support_bundle(
    data_dir: Path,
    *,
    include_p3: bool = False,
    output_dir: Path | None = None,
    config: Mapping[str, Any] | None = None,
) -> SupportBundleResult:
    data_dir = Path(data_dir).expanduser().resolve()
    bundle_dir = Path(output_dir) if output_dir else data_dir / DEFAULT_BUNDLE_DIRNAME
    bundle_dir.mkdir(parents=True, exist_ok=True)
    bundle_path = bundle_dir / f"support_bundle_{_now_compact()}.zip"

    included: list[str] = []
    manifest: dict[str, object] = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "generated_at": _now_iso(),
        "data_dir": str(data_dir),
        "include_p3": bool(include_p3),
        "files": included,
    }
    summary = _support_summary(data_dir, config)

    with zipfile.ZipFile(bundle_path, "w", compression=zipfile.ZIP_DEFLATED) as zip_file:
        for path in _log_files(data_dir):
            arcname = _safe_arcname(path, data_dir)
            _add_file(zip_file, path, arcname, included)
        for path in _diagnostic_files(data_dir):
            arcname = _safe_arcname(path, data_dir)
            _add_file(zip_file, path, arcname, included)
        if include_p3:
            for base in _p3_paths(data_dir):
                if base.is_file():
                    arcname = _safe_arcname(base, data_dir)
                    _add_file(zip_file, base, arcname, included)
                else:
                    _add_tree(zip_file, base, data_dir, included)
        zip_file.writestr("support_bundle_summary.json", json.dumps(summary, indent=2, ensure_ascii=False))
        zip_file.writestr("support_bundle_manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))

    return SupportBundleResult(bundle_path=bundle_path, manifest=manifest, included=included)


__all__ = ["SupportBundleResult", "create_support_bundle", "DEFAULT_BUNDLE_DIRNAME"]
