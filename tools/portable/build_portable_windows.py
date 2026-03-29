"""Build a Windows portable distribution with offline assets."""

from __future__ import annotations

import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIST_ROOT = ROOT / "dist"
PORTABLE_DIR = DIST_ROOT / "QualiFile_Portable"
LATEST_POINTER = DIST_ROOT / "QualiFile_Portable_LATEST.txt"
LAUNCHER_DIST = DIST_ROOT / "QualiFile"
SERVER_DIST = DIST_ROOT / "qualifile_server"
LICENSES_DIR = ROOT / "docs" / "portable_windows" / "licenses"
NOTICES_FILE = ROOT / "docs" / "portable_windows" / "vendor" / "THIRD_PARTY_NOTICES.md"
README_PORTABLE = ROOT / "README-Portable.txt"


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


def _prepare_output_dir(path: Path, pointer: Path) -> tuple[Path, bool]:
    if path.exists():
        try:
            shutil.rmtree(path)
        except OSError as exc:
            if _is_lock_error(exc):
                fallback = _timestamped_output_dir(path)
                fallback.mkdir(parents=True, exist_ok=True)
                return fallback, True
            raise
    path.mkdir(parents=True, exist_ok=True)
    if pointer.exists():
        pointer.unlink()
    return path, False


def _copy_tree(src: Path, dest: Path) -> None:
    if not src.exists():
        raise FileNotFoundError(f"Missing source: {src}")
    shutil.copytree(src, dest, dirs_exist_ok=True)


def _copy_file(src: Path, dest: Path) -> None:
    if not src.exists():
        raise FileNotFoundError(f"Missing source: {src}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)


def _prune_minified_duplicates(root: Path, parts: tuple[str, ...]) -> None:
    for candidate in root.rglob(parts[-1]):
        if not candidate.is_dir():
            continue
        if candidate.parts[-len(parts):] != parts:
            continue
        for path in candidate.rglob("*.js"):
            if path.name.endswith(".min.js"):
                continue
            min_path = path.with_name(f"{path.stem}.min.js")
            if min_path.exists():
                path.unlink()


def _install_requirements(python: str) -> None:
    requirements = ROOT / "requirements" / "portable_build.txt"
    if not requirements.exists():
        print("portable_build.txt not found; skipping dependency install.")
        return
    _run([python, "-m", "pip", "install", "-r", str(requirements)], "[0/8] Installing portable build dependencies...")


def _prepare_assets(python: str) -> None:
    _run([python, str(ROOT / "tools" / "portable" / "vendor_web_assets.py")], "[1/8] Downloading vendored web assets...")
    _run([python, str(ROOT / "tools" / "build_assets.py")], "[2/8] Building minified frontend assets...")
    _run([python, str(ROOT / "tools" / "portable" / "verify_offline_assets.py")], "[3/8] Verifying offline asset references...")


def _build_bundles(python: str) -> None:
    spec_root = ROOT / "packaging" / "pyinstaller"
    _run([python, "-m", "PyInstaller", "--noconfirm", "--clean", str(spec_root / "qualifile_server.spec")], "[4/8] Building backend bundle...")
    _run([python, "-m", "PyInstaller", "--noconfirm", "--clean", str(spec_root / "QualiFile.spec")], "[5/8] Building launcher bundle...")


def _assemble_portable() -> Path:
    print("[6/8] Assembling portable folder...")
    output_dir, used_fallback = _prepare_output_dir(PORTABLE_DIR, LATEST_POINTER)
    _copy_tree(LAUNCHER_DIST, output_dir)
    _copy_tree(SERVER_DIST, output_dir / "qualifile_server")
    _copy_tree(ROOT / "app" / "static" / "dist", output_dir / "static" / "dist")
    _copy_tree(ROOT / "app" / "static" / "img", output_dir / "static" / "img")
    _copy_tree(ROOT / "app" / "static" / "icons", output_dir / "static" / "icons")
    tutorial_root = ROOT / "docs" / "user_tutorial"
    if tutorial_root.exists():
        _copy_tree(tutorial_root, output_dir / "static" / "user_tutorial")
    _copy_tree(ROOT / "app" / "templates", output_dir / "templates")
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

    _prune_minified_duplicates(output_dir, ("static", "dist", "js"))
    _prune_minified_duplicates(output_dir, ("static", "dist", "vendor", "prism", "components"))
    if used_fallback:
        _write_latest_pointer(LATEST_POINTER, output_dir)
    return output_dir


def main() -> int:
    python = sys.executable
    _install_requirements(python)
    _prepare_assets(python)
    _build_bundles(python)
    output_dir = _assemble_portable()
    print(f"[7/8] Portable bundle ready at {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
