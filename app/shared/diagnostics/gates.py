"""Data release gates helpers."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

from ..data_contract.yaml_loader import load_yaml

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MANIFEST_PATH = ROOT / "docs" / "data" / "examples" / "fixtures_manifest.yaml"
FIXTURES_DIR = ROOT / "docs" / "data" / "examples" / "fixtures"
GOLDEN_DIR = ROOT / "docs" / "data" / "examples" / "golden"
ENV_MANIFEST_VAR = "QUALIFILE_DATA_GATES_MANIFEST"


def _run(cmd: list[str], *, check: bool = True) -> int:
    proc = subprocess.run(cmd, text=True)
    if check and proc.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}")
    return proc.returncode


def _fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def resolve_manifest_path(cli_path: str | None = None) -> Path:
    env_value = os.getenv(ENV_MANIFEST_VAR)
    if env_value:
        return Path(env_value)
    if cli_path:
        return Path(cli_path)
    return DEFAULT_MANIFEST_PATH


def _load_manifest(path: Path) -> dict:
    payload = load_yaml(path)
    if isinstance(payload, dict):
        return payload
    return {}


def _manifest_missing_entries(manifest: dict) -> list[str]:
    missing: list[str] = []
    for entry in manifest.get("fixtures", []) or []:
        if entry.get("status") == "missing":
            missing.append(f"fixture:{entry.get('schema_id')}:{entry.get('version')}")
    for entry in manifest.get("migration_tests", []) or []:
        if entry.get("status") == "missing":
            missing.append(f"migration:{entry.get('schema_id')}:{entry.get('from')}->{entry.get('to')}")
    return missing


def _manifest_missing_files(manifest: dict) -> list[str]:
    missing: list[str] = []
    for entry in manifest.get("fixtures", []) or []:
        for filename in entry.get("files", []) or []:
            path = FIXTURES_DIR / filename
            if not path.exists():
                missing.append(str(path))
    for entry in manifest.get("migration_tests", []) or []:
        input_file = entry.get("input")
        expected_file = entry.get("expected")
        if input_file:
            input_path = FIXTURES_DIR / input_file
            if not input_path.exists():
                missing.append(str(input_path))
        if expected_file:
            expected_path = GOLDEN_DIR / expected_file
            if not expected_path.exists():
                expected_path = FIXTURES_DIR / expected_file
            if not expected_path.exists():
                missing.append(str(expected_path))
    return missing


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run data release gates.")
    parser.add_argument("--check", action="store_true", help="Run validation-only gates (no upgrade simulation).")
    parser.add_argument("--manifest", help="Override fixtures manifest path.")
    parser.add_argument("--skip-upgrade", action="store_true", help="Skip upgrade simulation (fast gate).")
    parser.add_argument("--skip-fixtures", action="store_true", help="Skip fixtures manifest gate.")
    parser.add_argument("--skip-registry", action="store_true", help="Skip registry audit gate.")
    return parser.parse_args()


def run_data_gates(
    *,
    check_only: bool = False,
    skip_registry: bool = False,
    skip_fixtures: bool = False,
    skip_upgrade: bool = False,
    manifest_path: Path | None = None,
) -> int:
    if check_only:
        skip_upgrade = True

    if not skip_registry:
        audit_cmd = [sys.executable, str(ROOT / "scripts" / "data_contract_audit.py"), "--check"]
        if _run(audit_cmd, check=False) != 0:
            return 1

    if not skip_fixtures:
        manifest_path = resolve_manifest_path(str(manifest_path) if manifest_path else None)
        if not manifest_path.exists():
            return _fail(f"Missing manifest: {manifest_path}")
        try:
            manifest = _load_manifest(manifest_path)
        except Exception as exc:
            return _fail(f"Failed to load manifest: {exc}")
        missing_entries = _manifest_missing_entries(manifest)
        if missing_entries:
            return _fail("Manifest still has missing entries: " + ", ".join(missing_entries))
        missing_files = _manifest_missing_files(manifest)
        if missing_files:
            return _fail("Missing fixture files: " + ", ".join(missing_files))

    if not skip_upgrade:
        upgrade_cmd = [sys.executable, str(ROOT / "tools" / "run_data_upgrade_sim.py")]
        if _run(upgrade_cmd, check=False) != 0:
            return 1

    print("data_gates=ok")
    return 0


def main() -> int:
    args = parse_args()
    return run_data_gates(
        check_only=args.check,
        skip_registry=args.skip_registry,
        skip_fixtures=args.skip_fixtures,
        skip_upgrade=args.skip_upgrade,
        manifest_path=Path(args.manifest) if args.manifest else None,
    )


__all__ = [
    "ENV_MANIFEST_VAR",
    "DEFAULT_MANIFEST_PATH",
    "run_data_gates",
    "parse_args",
]
