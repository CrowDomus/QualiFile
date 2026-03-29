"""User-facing Git Sync failure guidance catalog and code normalization."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence


@dataclass(frozen=True)
class GitSyncFailureGuidance:
    code: str
    title: str
    summary: str
    next_steps: tuple[str, ...]
    suggested_commands: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "title": self.title,
            "summary": self.summary,
            "next_steps": list(self.next_steps),
            "suggested_commands": list(self.suggested_commands),
        }


_GUIDANCE_BY_CANONICAL_CODE: dict[str, GitSyncFailureGuidance] = {
    "git-sync-conflict": GitSyncFailureGuidance(
        code="git-sync-conflict",
        title="Unresolved PPS conflicts",
        summary="Git reports unresolved conflicts in `.qualifile_sync`; import is blocked until conflicts are resolved.",
        next_steps=(
            "Resolve merge conflicts in `.qualifile_sync` files.",
            "Commit the conflict resolution, then retry Pull & Import.",
        ),
        suggested_commands=(
            "git status",
            "git diff --name-only --diff-filter=U -- .qualifile_sync/",
            "git ls-files -u -- .qualifile_sync/",
        ),
    ),
    "git-sync-incomplete-pps": GitSyncFailureGuidance(
        code="git-sync-incomplete-pps",
        title="Incomplete or invalid PPS snapshot",
        summary="The metadata snapshot is missing required files or failed integrity checks.",
        next_steps=(
            "Re-pull latest changes and ensure `.qualifile_sync` is complete.",
            "If this is your source machine, run Export metadata before retrying.",
        ),
        suggested_commands=(
            "git status",
            "git pull --ff-only",
        ),
    ),
    "git-sync-dirty-local": GitSyncFailureGuidance(
        code="git-sync-dirty-local",
        title="Local metadata is dirty",
        summary="Local DB metadata differs from last exported/imported snapshot; Pull & Import is blocked to prevent overwrite.",
        next_steps=(
            "Use Export metadata and Commit & Push first (recommended).",
            "Use Force Import only if you intentionally want to discard local metadata.",
        ),
        suggested_commands=(),
    ),
    "git-sync-id-collision": GitSyncFailureGuidance(
        code="git-sync-id-collision",
        title="ID collision detected",
        summary="Incoming metadata ID conflicts with a different local scope; import was blocked without overwrite.",
        next_steps=(
            "Reconcile conflicting entities manually.",
            "Migrate legacy short IDs to UUID/ULID before retrying sync.",
        ),
        suggested_commands=(),
    ),
    "git-sync-git-missing": GitSyncFailureGuidance(
        code="git-sync-git-missing",
        title="Git executable unavailable",
        summary="QualiFile cannot run Git because no trusted Git executable is available.",
        next_steps=(
            "Install Git on this machine or fix PATH resolution.",
            "Approve/trust the Git binary in Sync settings if prompted.",
        ),
        suggested_commands=(
            "git --version",
        ),
    ),
    "git-sync-auth-failed": GitSyncFailureGuidance(
        code="git-sync-auth-failed",
        title="Git authentication failed",
        summary="Remote authentication failed in non-interactive mode.",
        next_steps=(
            "Configure SSH keys or your system credential helper outside QualiFile.",
            "Retry the same Git Sync action after credentials are fixed.",
        ),
        suggested_commands=(
            "git remote -v",
            "git fetch --all",
        ),
    ),
}

_ALIASES_TO_CANONICAL: dict[str, str] = {
    "git-sync-pps-unmerged": "git-sync-conflict",
    "import-conflict-unmerged": "git-sync-conflict",
    "import-conflict-check-failed": "git-sync-conflict",
    "manifest-missing": "git-sync-incomplete-pps",
    "manifest-invalid-json": "git-sync-incomplete-pps",
    "manifest-fingerprint-mismatch": "git-sync-incomplete-pps",
    "manifest-schema-unsupported": "git-sync-incomplete-pps",
    "import-required-path-missing": "git-sync-incomplete-pps",
    "import-required-path-invalid": "git-sync-incomplete-pps",
    "import-entity-invalid-json": "git-sync-incomplete-pps",
    "pull-import-dirty-local": "git-sync-dirty-local",
    "pull-import-export-required": "git-sync-dirty-local",
    "dirty-fingerprint-mismatch": "git-sync-dirty-local",
    "dirty-baseline-missing": "git-sync-dirty-local",
    "id-collision": "git-sync-id-collision",
    "git-missing": "git-sync-git-missing",
    "git-path-invalid": "git-sync-git-missing",
    "git-not-trusted": "git-sync-git-missing",
    "git-auth-failed": "git-sync-auth-failed",
}


def canonical_failure_code(code: str | None) -> str | None:
    normalized = str(code).strip() if code is not None else ""
    if not normalized:
        return None
    if normalized in _GUIDANCE_BY_CANONICAL_CODE:
        return normalized
    return _ALIASES_TO_CANONICAL.get(normalized)


def guidance_for_failure_code(code: str | None) -> dict[str, Any] | None:
    canonical = canonical_failure_code(code)
    if canonical is None:
        return None
    guidance = _GUIDANCE_BY_CANONICAL_CODE.get(canonical)
    if guidance is None:
        return None
    payload = guidance.as_dict()
    if code is not None:
        payload["source_code"] = str(code).strip()
    return payload


def build_failure_guidance_catalog(*, codes: Sequence[str] | None = None) -> list[dict[str, Any]]:
    if codes is None:
        selected_codes = tuple(sorted(_GUIDANCE_BY_CANONICAL_CODE))
    else:
        selected_codes = tuple(code for code in codes if code in _GUIDANCE_BY_CANONICAL_CODE)
    return [_GUIDANCE_BY_CANONICAL_CODE[code].as_dict() for code in selected_codes]


def map_failure_codes_to_guidance(codes: Iterable[str | None]) -> list[dict[str, Any]]:
    resolved: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw_code in codes:
        guidance = guidance_for_failure_code(raw_code)
        if guidance is None:
            continue
        canonical = str(guidance["code"])
        if canonical in seen:
            continue
        seen.add(canonical)
        resolved.append(guidance)
    return resolved


def guidance_map_by_code(*, codes: Sequence[str] | None = None) -> Mapping[str, dict[str, Any]]:
    catalog = build_failure_guidance_catalog(codes=codes)
    return {item["code"]: item for item in catalog}


__all__ = [
    "GitSyncFailureGuidance",
    "build_failure_guidance_catalog",
    "canonical_failure_code",
    "guidance_for_failure_code",
    "guidance_map_by_code",
    "map_failure_codes_to_guidance",
]
