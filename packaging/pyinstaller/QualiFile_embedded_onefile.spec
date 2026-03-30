# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

block_cipher = None
import os

project_root = Path(os.getcwd())
icon_file = project_root / "app" / "static" / "icons" / "favicon.ico"

datas = [
    (str(project_root / "app" / "templates"), "templates"),
    (str(project_root / "app" / "static" / "dist"), "static/dist"),
    (str(project_root / "app" / "static" / "img"), "static/img"),
    (str(project_root / "app" / "static" / "icons"), "static/icons"),
    (str(project_root / "docs" / "user_tutorial"), "static/user_tutorial"),
]

a = Analysis(
    [str(project_root / "packaging" / "launchers" / "launcher_embedded.py")],
    pathex=[str(project_root)],
    binaries=[],
    datas=datas,
    hiddenimports=[],
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
    a.binaries,
    a.zipfiles,
    a.datas,
    name="QualiFile_embedded_onefile",
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
    icon=str(icon_file),
)
