"""Migration runner utilities (dry-run skeleton)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .runner import run_migration_dry_run as run_migration_dry_run
    from .version_probe import detect_schema_versions as detect_schema_versions


def run_migration_dry_run(*args: Any, **kwargs: Any):
    from .runner import run_migration_dry_run as impl

    return impl(*args, **kwargs)


def detect_schema_versions(*args: Any, **kwargs: Any):
    from .version_probe import detect_schema_versions as impl

    return impl(*args, **kwargs)


__all__ = ["detect_schema_versions", "run_migration_dry_run"]
