"""Repo initialization defaults and helper-warning acknowledgement for Git Sync."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

from .git_runner import GitCommandConfigurationError, run_git_command

GIT_HELPER_WARNING_SUBMODULES = "git-helper-warning-submodules"
GIT_HELPER_WARNING_FILTERS = "git-helper-warning-filters"
GIT_HELPER_WARNING_HOOKS_PATH = "git-helper-warning-hooks-path"

GIT_HELPER_WARNING_CODES = (
    GIT_HELPER_WARNING_SUBMODULES,
    GIT_HELPER_WARNING_FILTERS,
    GIT_HELPER_WARNING_HOOKS_PATH,
)

GIT_HELPER_WARNING_ACK_KEY_PREFIX = "git_sync_helper_warning_ack::"

_GITIGNORE_DEFAULT_LINES = (
    "# QualiFile Git Sync defaults",
    "# Keep portable metadata and workspace sidecars tracked.",
    "!.qualifile_sync/",
    "!.qualifile_sync/**",
    "!.qualifile_root.json",
    "!.qualifile_meta.json",
    "!.qualifile_notes.json",
    "!.qualifile_tags.json",
    "# Ignore transient PPS swap/recovery artifacts.",
    ".qualifile_sync.tmp-*",
    ".qualifile_sync.bak-*",
)

_GITATTRIBUTES_JSON_LF_LINE = "*.json text eol=lf"
_FILTER_TOKEN_MARKERS = ("filter", "lfs")

GitConfigLookup = Callable[[Path, str], str | None]


def _now_local_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _normalize_repo_root(repo_root: Path | str) -> Path:
    resolved = Path(repo_root).expanduser().resolve()
    if not resolved.exists() or not resolved.is_dir():
        raise FileNotFoundError(f"Repo root is invalid: {resolved}")
    return resolved


def _dedupe_preserve_order(values: Iterable[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = str(value).strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return tuple(result)


def _append_missing_lines(path: Path, required_lines: Sequence[str]) -> bool:
    existing_lines: list[str] = []
    if path.exists():
        existing_lines = path.read_text(encoding="utf-8").splitlines()
    existing_set = {line.strip() for line in existing_lines}

    additions: list[str] = []
    for line in required_lines:
        normalized = line.strip()
        if normalized in existing_set:
            continue
        additions.append(line)
        existing_set.add(normalized)

    if not additions:
        return False

    output_lines = list(existing_lines)
    if output_lines and output_lines[-1].strip():
        output_lines.append("")
    output_lines.extend(additions)
    path.write_text("\n".join(output_lines) + "\n", encoding="utf-8", newline="\n")
    return True


def default_gitignore_lines() -> tuple[str, ...]:
    return _GITIGNORE_DEFAULT_LINES


@dataclass(frozen=True)
class RepoInitDefaultsResult:
    repo_root: str
    gitignore_changed: bool
    gitattributes_changed: bool
    gitattributes_enabled: bool


def ensure_repo_init_defaults(
    repo_root: Path | str,
    *,
    include_json_eol_rule: bool = True,
) -> RepoInitDefaultsResult:
    root = _normalize_repo_root(repo_root)
    gitignore_changed = _append_missing_lines(root / ".gitignore", default_gitignore_lines())

    gitattributes_changed = False
    if include_json_eol_rule:
        gitattributes_changed = _append_missing_lines(
            root / ".gitattributes",
            (
                "# QualiFile Git Sync defaults",
                _GITATTRIBUTES_JSON_LF_LINE,
            ),
        )

    return RepoInitDefaultsResult(
        repo_root=str(root),
        gitignore_changed=gitignore_changed,
        gitattributes_changed=gitattributes_changed,
        gitattributes_enabled=bool(include_json_eol_rule),
    )


def _default_git_config_lookup(repo_root: Path, key: str) -> str | None:
    try:
        result = run_git_command(repo_root, ("config", "--get", key), timeout_seconds=8.0)
    except (FileNotFoundError, GitCommandConfigurationError):
        return None
    if result.exit_code != 0:
        return None
    text = result.stdout.strip()
    return text or None


def _gitattributes_has_helper_tokens(path: Path) -> bool:
    if not path.exists() or not path.is_file():
        return False
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        lowered = stripped.lower()
        if any(marker in lowered for marker in _FILTER_TOKEN_MARKERS):
            return True
    return False


@dataclass(frozen=True)
class HelperWarningState:
    repo_root: str
    warnings: tuple[str, ...]
    acknowledged: tuple[str, ...]
    unacknowledged: tuple[str, ...]

    @property
    def requires_acknowledgement(self) -> bool:
        return bool(self.unacknowledged)


class GitHelperWarningAckStore:
    """Persist one-time helper warning acknowledgements per repository root."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    @staticmethod
    def preference_key(repo_root: Path | str) -> str:
        resolved = _normalize_repo_root(repo_root)
        digest = hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()
        return f"{GIT_HELPER_WARNING_ACK_KEY_PREFIX}{digest}"

    def _read_payload(self, repo_root: Path | str) -> Mapping[str, Any] | None:
        key = self.preference_key(repo_root)
        row = self._conn.execute("SELECT value FROM profile_preferences WHERE key = ?", (key,)).fetchone()
        if not row or row[0] is None:
            return None
        try:
            payload = json.loads(str(row[0]))
        except Exception:
            return None
        return payload if isinstance(payload, Mapping) else None

    def get_acknowledged_codes(self, repo_root: Path | str) -> tuple[str, ...]:
        payload = self._read_payload(repo_root)
        if payload is None:
            return tuple()
        codes = payload.get("acknowledged_codes")
        if not isinstance(codes, list):
            return tuple()
        return _dedupe_preserve_order([str(value) for value in codes if isinstance(value, str)])

    def acknowledge(self, repo_root: Path | str, warning_codes: Sequence[str]) -> tuple[str, ...]:
        root = _normalize_repo_root(repo_root)
        current = list(self.get_acknowledged_codes(root))
        merged = _dedupe_preserve_order([*current, *warning_codes])
        payload = {
            "repo_root": str(root),
            "acknowledged_codes": list(merged),
            "acknowledged_at_local": _now_local_iso(),
        }
        key = self.preference_key(root)
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO profile_preferences (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (key, json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))),
            )
        return merged

    def clear(self, repo_root: Path | str) -> None:
        with self._conn:
            self._conn.execute(
                "DELETE FROM profile_preferences WHERE key = ?",
                (self.preference_key(repo_root),),
            )


def detect_repo_helper_warnings(
    repo_root: Path | str,
    *,
    get_git_config: GitConfigLookup = _default_git_config_lookup,
) -> tuple[str, ...]:
    root = _normalize_repo_root(repo_root)
    warnings: list[str] = []

    if (root / ".gitmodules").exists():
        warnings.append(GIT_HELPER_WARNING_SUBMODULES)
    if _gitattributes_has_helper_tokens(root / ".gitattributes"):
        warnings.append(GIT_HELPER_WARNING_FILTERS)

    hooks_path = get_git_config(root, "core.hooksPath")
    if isinstance(hooks_path, str) and hooks_path.strip():
        warnings.append(GIT_HELPER_WARNING_HOOKS_PATH)

    return _dedupe_preserve_order(warnings)


def evaluate_repo_helper_warning_state(
    repo_root: Path | str,
    *,
    ack_store: GitHelperWarningAckStore | None = None,
    get_git_config: GitConfigLookup = _default_git_config_lookup,
) -> HelperWarningState:
    root = _normalize_repo_root(repo_root)
    warnings = detect_repo_helper_warnings(root, get_git_config=get_git_config)
    acknowledged = ack_store.get_acknowledged_codes(root) if ack_store is not None else tuple()
    acknowledged_set = set(acknowledged)
    unacknowledged = tuple(code for code in warnings if code not in acknowledged_set)
    return HelperWarningState(
        repo_root=str(root),
        warnings=warnings,
        acknowledged=acknowledged,
        unacknowledged=unacknowledged,
    )


__all__ = [
    "GIT_HELPER_WARNING_ACK_KEY_PREFIX",
    "GIT_HELPER_WARNING_CODES",
    "GIT_HELPER_WARNING_FILTERS",
    "GIT_HELPER_WARNING_HOOKS_PATH",
    "GIT_HELPER_WARNING_SUBMODULES",
    "GitHelperWarningAckStore",
    "HelperWarningState",
    "RepoInitDefaultsResult",
    "default_gitignore_lines",
    "detect_repo_helper_warnings",
    "ensure_repo_init_defaults",
    "evaluate_repo_helper_warning_state",
]
