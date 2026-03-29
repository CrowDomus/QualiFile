"""PPS import gate checks for conflict and completeness validation."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .git_runner import GitCommandConfigurationError, run_git_command
from .pps_export_swap import ACTIVE_DIRNAME, RecoveryResult, recover_snapshot_artifacts
from .pps_manifest import (
    ENTRIES_DIRNAME,
    PROJECT_FILENAME,
    TAG_DEFINITIONS_DIRNAME,
    ManifestValidationError,
    load_manifest_with_integrity,
)
from .pps_serializer import PPS_JSON_ENCODING

_UNMERGED_DIFF_ARGS = ("diff", "--name-only", "--diff-filter=U", "--", ACTIVE_DIRNAME)
_UNMERGED_LS_FILES_ARGS = ("ls-files", "-u", "--", ACTIVE_DIRNAME)
_WINDOWS_ABSOLUTE_PATH_RE = re.compile(r"^[A-Za-z]:[\\/]")
_CONFLICT_CHECK_TIMEOUT_SECONDS = 15.0


class ImportGateError(RuntimeError):
    """Raised when PPS import preflight gates fail."""

    def __init__(self, code: str, message: str, *, details: Sequence[str] | None = None):
        super().__init__(message)
        self.code = code
        self.details = tuple(details or ())


@dataclass(frozen=True)
class ImportGateResult:
    manifest: Mapping[str, Any]
    marker_conflict_candidates: tuple[str, ...]
    recovery: RecoveryResult


def _default_git_runner(repo_root: Path, args: Sequence[str]) -> tuple[int, str, str]:
    try:
        result = run_git_command(repo_root, args, timeout_seconds=_CONFLICT_CHECK_TIMEOUT_SECONDS)
    except GitCommandConfigurationError as exc:
        return 128, "", str(exc)
    return result.exit_code, result.stdout, result.stderr


def _normalize_relpath(path: str) -> str:
    return path.strip().replace("\\", "/")


def _is_pps_relpath(path: str) -> bool:
    return path == ACTIVE_DIRNAME or path.startswith(f"{ACTIVE_DIRNAME}/")


def _parse_unmerged_output(stdout: str, *, includes_stage_prefix: bool) -> tuple[str, ...]:
    values: set[str] = set()
    for raw in stdout.splitlines():
        line = raw.strip()
        if not line:
            continue
        candidate = line
        if includes_stage_prefix:
            tab_split = line.split("\t", 1)
            if len(tab_split) != 2:
                continue
            candidate = tab_split[1]
        normalized = _normalize_relpath(candidate)
        if _is_pps_relpath(normalized):
            values.add(normalized)
    return tuple(sorted(values))


def list_unmerged_pps_paths(
    repo_root: Path | str,
    *,
    run_git: Callable[[Path, Sequence[str]], tuple[int, str, str]] = _default_git_runner,
) -> tuple[str, ...]:
    """Return unresolved PPS conflict paths reported by Git."""

    root = Path(repo_root).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise ImportGateError("import-repo-root-invalid", f"Repo root is invalid: {root}")

    paths: set[str] = set()
    successful_checks = 0
    failures: list[str] = []

    for args, includes_stage_prefix in ((_UNMERGED_DIFF_ARGS, False), (_UNMERGED_LS_FILES_ARGS, True)):
        exit_code, stdout, stderr = run_git(root, args)
        if exit_code != 0:
            failures.append(
                f"git {' '.join(args)} exited {exit_code}"
                + (f": {stderr.strip()}" if stderr and stderr.strip() else "")
            )
            continue
        successful_checks += 1
        paths.update(_parse_unmerged_output(stdout, includes_stage_prefix=includes_stage_prefix))

    if successful_checks == 0:
        raise ImportGateError(
            "import-conflict-check-failed",
            "Unable to determine Git conflict state for PPS paths.",
            details=failures,
        )

    return tuple(sorted(paths))


def find_conflict_marker_candidates(snapshot_dir: Path | str) -> tuple[str, ...]:
    """Return files containing conflict markers as secondary diagnostics only."""

    snapshot = Path(snapshot_dir)
    if not snapshot.exists() or not snapshot.is_dir():
        return tuple()

    markers: set[str] = set()
    for path in snapshot.rglob("*.json"):
        try:
            content = path.read_text(encoding=PPS_JSON_ENCODING, errors="ignore")
        except Exception:
            continue
        if "<<<<<<<" in content:
            markers.add(path.relative_to(snapshot).as_posix())
    return tuple(sorted(markers))


def _ensure_required_snapshot_structure(snapshot_dir: Path) -> None:
    required_paths = (
        (PROJECT_FILENAME, True),
        (TAG_DEFINITIONS_DIRNAME, False),
        (ENTRIES_DIRNAME, False),
    )
    for relpath, is_file in required_paths:
        target = snapshot_dir / relpath
        if not target.exists():
            raise ImportGateError(
                "import-required-path-missing",
                f"Required PPS path is missing: {relpath}",
                details=[relpath],
            )
        if is_file and not target.is_file():
            raise ImportGateError(
                "import-required-path-invalid",
                f"Required PPS path is not a file: {relpath}",
                details=[relpath],
            )
        if not is_file and not target.is_dir():
            raise ImportGateError(
                "import-required-path-invalid",
                f"Required PPS path is not a directory: {relpath}",
                details=[relpath],
            )


def _load_json_object(path: Path, *, missing_code: str, invalid_code: str, invalid_shape_code: str) -> dict[str, Any]:
    if not path.exists():
        raise ImportGateError(missing_code, f"Required JSON file is missing: {path.name}", details=[path.name])
    try:
        payload = json.loads(path.read_text(encoding=PPS_JSON_ENCODING))
    except Exception as exc:
        raise ImportGateError(invalid_code, f"Invalid JSON in {path.name}.", details=[type(exc).__name__]) from exc
    if not isinstance(payload, dict):
        raise ImportGateError(invalid_shape_code, f"JSON payload must be an object: {path.name}", details=[path.name])
    return payload


def _is_absolute_path(value: str) -> bool:
    candidate = value.strip()
    if not candidate:
        return False
    if candidate.startswith(("\\\\", "//")):
        return True
    if _WINDOWS_ABSOLUTE_PATH_RE.match(candidate):
        return True
    return Path(candidate).is_absolute()


def _validate_project_payload(snapshot_dir: Path) -> None:
    project_path = snapshot_dir / PROJECT_FILENAME
    payload = _load_json_object(
        project_path,
        missing_code="import-project-missing",
        invalid_code="import-project-invalid-json",
        invalid_shape_code="import-project-invalid-shape",
    )

    root_path = payload.get("root_path")
    if isinstance(root_path, str) and _is_absolute_path(root_path):
        raise ImportGateError(
            "import-project-root-path-absolute",
            "project.json contains non-portable absolute root_path.",
            details=[PROJECT_FILENAME],
        )


def _validate_entity_id_integrity(snapshot_dir: Path, entity_dir_name: str) -> None:
    entity_dir = snapshot_dir / entity_dir_name
    for entity_file in sorted(entity_dir.glob("*.json"), key=lambda item: item.name):
        payload = _load_json_object(
            entity_file,
            missing_code="import-entity-missing",
            invalid_code="import-entity-invalid-json",
            invalid_shape_code="import-entity-invalid-shape",
        )
        entity_id = payload.get("id")
        if not isinstance(entity_id, str) or not entity_id:
            raise ImportGateError(
                "import-entity-missing-id",
                f"Entity file is missing a valid 'id': {entity_file.name}",
                details=[entity_file.relative_to(snapshot_dir).as_posix()],
            )
        if entity_file.stem != entity_id:
            relpath = entity_file.relative_to(snapshot_dir).as_posix()
            raise ImportGateError(
                "import-entity-id-mismatch",
                f"Filename/id mismatch in {relpath}.",
                details=[f"filename_id={entity_file.stem}", f"json_id={entity_id}"],
            )


def run_import_preflight_gates(
    root_dir: Path | str,
    *,
    snapshot_dir: Path | str | None = None,
    run_git: Callable[[Path, Sequence[str]], tuple[int, str, str]] = _default_git_runner,
    on_warning: Callable[[str], None] | None = None,
) -> ImportGateResult:
    """Run import conflict/completeness gates before any DB mutation."""

    root = Path(root_dir).expanduser().resolve()
    recovery = recover_snapshot_artifacts(root, on_warning=on_warning)
    snapshot = Path(snapshot_dir).expanduser().resolve() if snapshot_dir is not None else (root / ACTIVE_DIRNAME)

    unmerged_paths = list_unmerged_pps_paths(root, run_git=run_git)
    if unmerged_paths:
        raise ImportGateError(
            "import-conflict-unmerged",
            "Git reports unresolved conflicts under .qualifile_sync. Resolve conflicts before importing.",
            details=unmerged_paths,
        )

    _ensure_required_snapshot_structure(snapshot)
    try:
        manifest = load_manifest_with_integrity(snapshot, verify_fingerprint=True)
    except ManifestValidationError as exc:
        raise ImportGateError(exc.code, str(exc)) from exc

    _validate_project_payload(snapshot)
    _validate_entity_id_integrity(snapshot, TAG_DEFINITIONS_DIRNAME)
    _validate_entity_id_integrity(snapshot, ENTRIES_DIRNAME)
    marker_candidates = find_conflict_marker_candidates(snapshot)

    return ImportGateResult(
        manifest=manifest,
        marker_conflict_candidates=marker_candidates,
        recovery=recovery,
    )


__all__ = [
    "ImportGateError",
    "ImportGateResult",
    "find_conflict_marker_candidates",
    "list_unmerged_pps_paths",
    "run_import_preflight_gates",
]
