"""Trusted Git binary policy helpers for Git Sync."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

GIT_TRUST_PREFERENCE_KEY = "git_sync_trusted_git_binary"
_TRUSTED_PATH_ENV_VARS = ("ProgramFiles", "ProgramFiles(x86)")
_LOCALAPPDATA_ENV_VAR = "LocalAppData"


def _now_local_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _normalize_required_text(value: Any, *, label: str) -> str:
    text = str(value).strip() if value is not None else ""
    if not text:
        raise ValueError(f"{label} must be a non-empty string.")
    return text


def _normalize_optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _resolve_path(value: Path | str) -> Path:
    return Path(value).expanduser().resolve(strict=False)


def _is_path_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _hash_file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class GitBinaryMetadata:
    resolved_path: str
    sha256: str
    size_bytes: int
    mtime_ns: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "resolved_path": self.resolved_path,
            "sha256": self.sha256,
            "size_bytes": self.size_bytes,
            "mtime_ns": self.mtime_ns,
        }


@dataclass(frozen=True)
class TrustedGitBinaryRecord:
    resolved_path: str
    sha256: str
    size_bytes: int
    mtime_ns: int
    approved_at_local: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "resolved_path": self.resolved_path,
            "sha256": self.sha256,
            "size_bytes": self.size_bytes,
            "mtime_ns": self.mtime_ns,
            "approved_at_local": self.approved_at_local,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> TrustedGitBinaryRecord:
        return cls(
            resolved_path=_normalize_required_text(payload.get("resolved_path"), label="resolved_path"),
            sha256=_normalize_required_text(payload.get("sha256"), label="sha256"),
            size_bytes=int(payload.get("size_bytes")),
            mtime_ns=int(payload.get("mtime_ns")),
            approved_at_local=_normalize_required_text(payload.get("approved_at_local"), label="approved_at_local"),
        )


@dataclass(frozen=True)
class GitTrustDecision:
    allowed: bool
    code: str
    resolved_path: str | None
    trust_source: str | None = None
    requires_approval: bool = False
    details: tuple[str, ...] = tuple()


class GitBinaryTrustStore:
    """Persist approved Git binary metadata in profile preferences."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def get_record(self) -> TrustedGitBinaryRecord | None:
        row = self._conn.execute(
            "SELECT value FROM profile_preferences WHERE key = ?",
            (GIT_TRUST_PREFERENCE_KEY,),
        ).fetchone()
        if not row or row[0] is None:
            return None
        try:
            payload = json.loads(str(row[0]))
        except Exception:
            return None
        if not isinstance(payload, Mapping):
            return None
        try:
            return TrustedGitBinaryRecord.from_dict(payload)
        except Exception:
            return None

    def set_record(self, record: TrustedGitBinaryRecord) -> None:
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO profile_preferences (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (
                    GIT_TRUST_PREFERENCE_KEY,
                    json.dumps(record.as_dict(), ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                ),
            )

    def clear_record(self) -> None:
        with self._conn:
            self._conn.execute(
                "DELETE FROM profile_preferences WHERE key = ?",
                (GIT_TRUST_PREFERENCE_KEY,),
            )

    def approve_path(self, path: Path | str) -> TrustedGitBinaryRecord:
        metadata = compute_git_binary_metadata(path)
        record = TrustedGitBinaryRecord(
            resolved_path=metadata.resolved_path,
            sha256=metadata.sha256,
            size_bytes=metadata.size_bytes,
            mtime_ns=metadata.mtime_ns,
            approved_at_local=_now_local_iso(),
        )
        self.set_record(record)
        return record


def discover_git_binary_path(
    *,
    resolve_which: Callable[[str], str | None] = shutil.which,
    command: str = "git",
) -> str | None:
    """Resolve Git executable path using OS lookup semantics."""

    candidate = _normalize_optional_text(resolve_which(command))
    if candidate is None:
        return None
    candidate_path = Path(candidate).expanduser()
    if not candidate_path.is_absolute():
        candidate_path = Path.cwd() / candidate_path
    return str(candidate_path.resolve(strict=False))


def trusted_install_roots(*, environment: Mapping[str, str] | None = None) -> tuple[Path, ...]:
    env = environment or os.environ
    roots: list[Path] = []
    for key in _TRUSTED_PATH_ENV_VARS:
        value = _normalize_optional_text(env.get(key))
        if value:
            roots.append(_resolve_path(value))
    local_app_data = _normalize_optional_text(env.get(_LOCALAPPDATA_ENV_VAR))
    if local_app_data:
        roots.append(_resolve_path(Path(local_app_data) / "Programs" / "Git"))
    deduped: list[Path] = []
    for root in roots:
        if root not in deduped:
            deduped.append(root)
    return tuple(deduped)


def is_trusted_install_path(path: Path | str, *, environment: Mapping[str, str] | None = None) -> bool:
    resolved_path = _resolve_path(path)
    return any(_is_path_within(resolved_path, root) for root in trusted_install_roots(environment=environment))


def compute_git_binary_metadata(path: Path | str) -> GitBinaryMetadata:
    resolved = _resolve_path(path)
    if not resolved.is_file():
        raise FileNotFoundError(f"Git binary is missing: {resolved}")
    stat = resolved.stat()
    return GitBinaryMetadata(
        resolved_path=str(resolved),
        sha256=_hash_file_sha256(resolved),
        size_bytes=int(stat.st_size),
        mtime_ns=int(stat.st_mtime_ns),
    )


def _normalize_workspace_roots(workspace_roots: Sequence[Path | str] | None) -> tuple[Path, ...]:
    roots: list[Path] = []
    for root in workspace_roots or ():
        roots.append(_resolve_path(root))
    return tuple(roots)


def evaluate_git_binary_trust(
    path: Path | str,
    *,
    project_root: Path | str | None = None,
    workspace_roots: Sequence[Path | str] | None = None,
    trust_store: GitBinaryTrustStore | None = None,
    environment: Mapping[str, str] | None = None,
) -> GitTrustDecision:
    """Evaluate whether a Git binary path is trusted for local execution."""

    raw_path = _normalize_required_text(path, label="path")
    candidate_path = Path(raw_path).expanduser()
    if not candidate_path.is_absolute():
        return GitTrustDecision(
            allowed=False,
            code="git-trust-reject-relative-path",
            resolved_path=None,
            details=("path must be absolute",),
        )

    resolved = candidate_path.resolve(strict=False)
    if not resolved.is_file():
        return GitTrustDecision(
            allowed=False,
            code="git-trust-binary-missing",
            resolved_path=str(resolved),
            details=("binary path is missing",),
        )

    if project_root is not None:
        resolved_project_root = _resolve_path(project_root)
        if _is_path_within(resolved, resolved_project_root):
            return GitTrustDecision(
                allowed=False,
                code="git-trust-reject-project-root",
                resolved_path=str(resolved),
                details=(f"project_root={resolved_project_root}",),
            )

    for workspace_root in _normalize_workspace_roots(workspace_roots):
        if _is_path_within(resolved, workspace_root):
            return GitTrustDecision(
                allowed=False,
                code="git-trust-reject-workspace-root",
                resolved_path=str(resolved),
                details=(f"workspace_root={workspace_root}",),
            )

    metadata = compute_git_binary_metadata(resolved)
    if is_trusted_install_path(resolved, environment=environment):
        return GitTrustDecision(
            allowed=True,
            code="git-trust-allowed-auto",
            resolved_path=metadata.resolved_path,
            trust_source="auto",
        )

    stored_record = trust_store.get_record() if trust_store is not None else None
    if stored_record is not None:
        stored_path = _resolve_path(stored_record.resolved_path)
        if stored_path == resolved:
            if (
                stored_record.sha256 == metadata.sha256
                and stored_record.size_bytes == metadata.size_bytes
                and stored_record.mtime_ns == metadata.mtime_ns
            ):
                return GitTrustDecision(
                    allowed=True,
                    code="git-trust-allowed-user-approved",
                    resolved_path=metadata.resolved_path,
                    trust_source="user-approved",
                )
            return GitTrustDecision(
                allowed=False,
                code="git-trust-approval-required-changed",
                resolved_path=metadata.resolved_path,
                requires_approval=True,
                details=("stored binary metadata changed",),
            )

    return GitTrustDecision(
        allowed=False,
        code="git-trust-approval-required",
        resolved_path=metadata.resolved_path,
        requires_approval=True,
        details=("binary is outside trusted install roots",),
    )


def resolve_trusted_git_binary_path(
    *,
    trust_store: GitBinaryTrustStore | None = None,
    project_root: Path | str | None = None,
    workspace_roots: Sequence[Path | str] | None = None,
    environment: Mapping[str, str] | None = None,
    resolve_which: Callable[[str], str | None] = shutil.which,
    command: str = "git",
) -> GitTrustDecision:
    """Discover and evaluate a trusted Git binary path for runtime execution."""

    discovered = discover_git_binary_path(resolve_which=resolve_which, command=command)
    if discovered is None:
        return GitTrustDecision(
            allowed=False,
            code="git-trust-binary-missing",
            resolved_path=None,
            requires_approval=False,
            details=("git executable not found in system lookup",),
        )
    return evaluate_git_binary_trust(
        discovered,
        project_root=project_root,
        workspace_roots=workspace_roots,
        trust_store=trust_store,
        environment=environment,
    )


__all__ = [
    "GIT_TRUST_PREFERENCE_KEY",
    "GitBinaryMetadata",
    "GitBinaryTrustStore",
    "GitTrustDecision",
    "TrustedGitBinaryRecord",
    "compute_git_binary_metadata",
    "discover_git_binary_path",
    "evaluate_git_binary_trust",
    "is_trusted_install_path",
    "resolve_trusted_git_binary_path",
    "trusted_install_roots",
]
