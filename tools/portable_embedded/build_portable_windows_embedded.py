"""Build an embedded onefile portable distribution with offline assets."""

from __future__ import annotations

import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIST_ROOT = ROOT / "dist"
OUTPUT_DIR = DIST_ROOT / "QualiFile_Portable_Embedded"
LATEST_POINTER = DIST_ROOT / "QualiFile_Portable_Embedded_LATEST.txt"
LAUNCHER_ONEFILE = DIST_ROOT / "QualiFile_embedded_onefile.exe"
SERVER_ONEFILE = DIST_ROOT / "qualifile_server_embedded_onefile.exe"
LICENSES_DIR = ROOT / "docs" / "portable_windows" / "licenses"
NOTICES_FILE = ROOT / "docs" / "portable_windows" / "vendor" / "THIRD_PARTY_NOTICES.md"
README_PORTABLE = ROOT / "README-Portable.txt"
SPEC_LAUNCHER = ROOT / "packaging" / "pyinstaller" / "QualiFile_embedded_onefile.spec"
SPEC_SERVER = ROOT / "packaging" / "pyinstaller" / "qualifile_server_embedded_onefile.spec"


def _run(cmd: list[str], label: str) -> None:
    print(label)
    subprocess.run(cmd, cwd=str(ROOT), check=True)


def _is_lock_error(exc: OSError) -> bool:
    winerror = getattr(exc, "winerror", None)
    return isinstance(exc, PermissionError) or winerror in {5, 32}


def _timestamped_output_dir(base: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    candidate = base.with_name(f"{base.name}_{stamp}")
    counter = 1
    while candidate.exists():
        candidate = base.with_name(f"{base.name}_{stamp}_{counter}")
        counter += 1
    return candidate


def _write_latest_pointer(pointer: Path, target: Path) -> None:
    pointer.parent.mkdir(parents=True, exist_ok=True)
    try:
        rel = target.relative_to(ROOT)
        pointer.write_text(str(rel), encoding="utf-8")
    except Exception:
        pointer.write_text(str(target), encoding="utf-8")


def _prepare_output_dir(path: Path) -> Path:
    if path.exists():
        try:
            shutil.rmtree(path)
        except OSError as exc:
            if _is_lock_error(exc):
                fallback = _timestamped_output_dir(path)
                fallback.mkdir(parents=True, exist_ok=True)
                return fallback
            raise
    path.mkdir(parents=True, exist_ok=True)
    return path


def _copy_tree(src: Path, dest: Path) -> None:
    if not src.exists():
        raise FileNotFoundError(f"Missing source: {src}")
    shutil.copytree(src, dest, dirs_exist_ok=True)


def _copy_file(src: Path, dest: Path) -> None:
    if not src.exists():
        raise FileNotFoundError(f"Missing source: {src}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)


def _install_requirements(python: str) -> None:
    requirements = ROOT / "requirements" / "portable_build.txt"
    if not requirements.exists():
        print("portable_build.txt not found; skipping dependency install.")
        return
    _run([python, "-m", "pip", "install", "-r", str(requirements)], "[0/6] Installing embedded build dependencies...")


def _prepare_assets(python: str) -> None:
    _run([python, str(ROOT / "tools" / "portable" / "vendor_web_assets.py")], "[1/6] Downloading vendored web assets...")
    _run([python, str(ROOT / "tools" / "build_assets.py")], "[2/6] Building minified frontend assets...")
    _run([python, str(ROOT / "tools" / "portable" / "verify_offline_assets.py")], "[3/6] Verifying offline asset references...")


def _build_bundles(python: str) -> None:
    if not SPEC_SERVER.exists():
        raise FileNotFoundError(f"Missing spec: {SPEC_SERVER}")
    if not SPEC_LAUNCHER.exists():
        raise FileNotFoundError(f"Missing spec: {SPEC_LAUNCHER}")
    _run([python, "-m", "PyInstaller", "--noconfirm", "--clean", str(SPEC_SERVER)], "[4/6] Building embedded backend...")
    _run([python, "-m", "PyInstaller", "--noconfirm", "--clean", str(SPEC_LAUNCHER)], "[5/6] Building embedded launcher...")


def _assemble_output() -> Path:
    print("[6/6] Assembling embedded portable folder...")
    output_dir = _prepare_output_dir(OUTPUT_DIR)
    _copy_file(LAUNCHER_ONEFILE, output_dir / "QualiFile.exe")
    _copy_file(SERVER_ONEFILE, output_dir / "qualifile_server.exe")
    if README_PORTABLE.exists():
        _copy_file(README_PORTABLE, output_dir / "README-Portable.txt")
    _copy_file(NOTICES_FILE, output_dir / "THIRD_PARTY_NOTICES.md")
    if LICENSES_DIR.exists():
        _copy_tree(LICENSES_DIR, output_dir / "licenses")

    for folder in (
        output_dir / "data",
        output_dir / "data" / "preview_cache",
        output_dir / "data" / "office_cache",
        output_dir / "data" / "notes",
        output_dir / "config",
    ):
        folder.mkdir(parents=True, exist_ok=True)
    _write_latest_pointer(LATEST_POINTER, output_dir)
    return output_dir


def main() -> int:
    python = sys.executable
    _install_requirements(python)
    _prepare_assets(python)
    _build_bundles(python)
    output_dir = _assemble_output()
    print(f"[DONE] Embedded portable bundle ready at {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
