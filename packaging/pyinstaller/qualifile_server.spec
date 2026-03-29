# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

block_cipher = None
import os
project_root = Path(os.getcwd())
notices_file = project_root / "docs" / "portable_windows" / "vendor" / "THIRD_PARTY_NOTICES.md"
licenses_dir = project_root / "docs" / "portable_windows" / "licenses"
tutorial_dir = project_root / "docs" / "user_tutorial"


datas = []
datas += collect_data_files("app", includes=["templates/**"])
datas += collect_data_files("app", includes=["static/dist/**", "static/img/**", "static/icons/**"])
datas.append((str(project_root / "README-Portable.txt"), "README-Portable.txt"))
datas.append((str(notices_file), "THIRD_PARTY_NOTICES.md"))
datas.append((str(licenses_dir), "licenses"))
datas.append((str(tutorial_dir), "static/user_tutorial"))

hiddenimports = collect_submodules("app")
hiddenimports += collect_submodules("win32com")

a = Analysis(
    ["packaging/launchers/portable_server.py"],
    pathex=[str(project_root)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="qualifile_server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="qualifile_server",
    distpath=str(project_root / "dist"),
    workpath=str(project_root / "out" / "build_server"),
)
