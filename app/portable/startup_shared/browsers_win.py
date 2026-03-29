from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import sys
from typing import Iterable

import subprocess


def _load_winreg():
    if sys.platform != "win32":
        return None
    try:
        import winreg

        return winreg
    except Exception:
        return None


@dataclass(frozen=True)
class BrowserEntry:
    name: str
    exe_path: str


def _iter_registry_roots(winreg_module) -> Iterable[tuple[int, str]]:
    return (
        (winreg_module.HKEY_CURRENT_USER, r"Software\Clients\StartMenuInternet"),
        (winreg_module.HKEY_LOCAL_MACHINE, r"Software\Clients\StartMenuInternet"),
    )


def _read_default_value(winreg_module, key):
    try:
        value, _ = winreg_module.QueryValueEx(key, "")
        return value
    except OSError:
        return None


def _read_command(winreg_module, key):
    try:
        command_key = winreg_module.OpenKey(key, "shell\\open\\command")
    except OSError:
        return None
    with command_key:
        return _read_default_value(winreg_module, command_key)


def _extract_exe(command: str) -> str | None:
    command = command.strip()
    if not command:
        return None
    if command.startswith('"'):
        closing = command.find('"', 1)
        if closing == -1:
            return None
        return command[1:closing]
    return command.split()[0]


def list_browsers(winreg_module=None) -> list[BrowserEntry]:
    winreg_module = winreg_module or _load_winreg()
    if sys.platform != "win32" or winreg_module is None:
        return []
    entries: list[BrowserEntry] = []
    seen = set()
    for root, path in _iter_registry_roots(winreg_module):
        try:
            base = winreg_module.OpenKey(root, path)
        except OSError:
            continue
        with base:
            for index in range(0, winreg_module.QueryInfoKey(base)[0]):
                try:
                    subkey_name = winreg_module.EnumKey(base, index)
                    subkey = winreg_module.OpenKey(base, subkey_name)
                except OSError:
                    continue
                with subkey:
                    display = _read_default_value(winreg_module, subkey) or subkey_name
                    command = _read_command(winreg_module, subkey)
                if not command:
                    continue
                exe = _extract_exe(command)
                if not exe:
                    continue
                path_obj = Path(exe)
                if not path_obj.exists():
                    continue
                key = (display, str(path_obj).lower())
                if key in seen:
                    continue
                seen.add(key)
                entries.append(BrowserEntry(name=display, exe_path=str(path_obj)))
    entries.sort(key=lambda item: item.name.lower())
    return entries


def open_browser(url: str, browser: BrowserEntry | None = None) -> subprocess.Popen | None:
    if browser is None:
        return None
    exe_path = Path(browser.exe_path)
    if not exe_path.exists():
        return None
    return subprocess.Popen([str(exe_path), url])
