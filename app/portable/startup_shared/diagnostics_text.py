from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping

from app.shared.data_dir import resolve_paths


@dataclass(frozen=True)
class DiagnosticsInfo:
    url: str | None = None
    port: int | None = None
    data_dir: str | Path | None = None
    logs_dir: str | Path | None = None
    diagnostics_dir: str | Path | None = None
    version: str | None = None
    build_id: str | None = None
    variant: str | None = None
    ready: bool | None = None


def _normalize(value) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, Path):
        return str(value)
    return str(value)


def _lines_from_items(items: Iterable[tuple[str, object]]) -> list[str]:
    lines: list[str] = []
    for label, value in items:
        lines.append(f"{label}: {_normalize(value)}")
    return lines


def build_diagnostics_text(info: DiagnosticsInfo) -> str:
    header = ["QualiFile startup diagnostics", ""]
    items = [
        ("URL", info.url),
        ("Port", info.port),
        ("Variant", info.variant),
        ("Version", info.version),
        ("Build ID", info.build_id),
        ("Ready", info.ready),
        ("Data dir", info.data_dir),
        ("Logs dir", info.logs_dir),
        ("Diagnostics dir", info.diagnostics_dir),
    ]
    lines = header + _lines_from_items(items)
    return "\n".join(lines).rstrip() + "\n"


def build_diagnostics_text_from_paths(
    data_dir: str | Path,
    *,
    url: str | None = None,
    port: int | None = None,
    variant: str | None = None,
    version: str | None = None,
    build_id: str | None = None,
    ready: bool | None = None,
    env: Mapping[str, str] | None = None,
) -> str:
    paths = resolve_paths(Path(data_dir), env=env)
    info = DiagnosticsInfo(
        url=url,
        port=port,
        variant=variant,
        version=version,
        build_id=build_id,
        ready=ready,
        data_dir=paths.data_dir,
        logs_dir=paths.logs_dir,
        diagnostics_dir=paths.diagnostics_dir,
    )
    return build_diagnostics_text(info)


__all__ = ["DiagnosticsInfo", "build_diagnostics_text", "build_diagnostics_text_from_paths"]
