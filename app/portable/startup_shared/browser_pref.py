from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Iterable

from .browsers_win import BrowserEntry


VALID_MODES = {"default", "selected"}
SCHEMA_VERSION = 2


@dataclass(frozen=True)
class BrowserChoice:
    mode: str
    browser: BrowserEntry | None


@dataclass(frozen=True)
class StartupPrefs:
    mode: str
    browser: BrowserEntry | None
    auto_open_on_ready: bool = False
    auto_close_on_open: bool = True


def _browser_by_name(name: str, browsers: Iterable[BrowserEntry]) -> BrowserEntry | None:
    normalized = name.strip().lower()
    for entry in browsers:
        if entry.name.strip().lower() == normalized:
            return entry
    return None


def load_choice(pref_path: str | Path, browsers: list[BrowserEntry]) -> BrowserChoice | None:
    prefs = load_prefs(pref_path, browsers)
    if prefs is None:
        return None
    return BrowserChoice(mode=prefs.mode, browser=prefs.browser)


def save_choice(pref_path: str | Path, mode: str, browser: BrowserEntry | None) -> None:
    prefs = StartupPrefs(mode=mode, browser=browser, auto_open_on_ready=False, auto_close_on_open=True)
    save_prefs(pref_path, prefs)


def _prefs_from_payload(payload: dict, browsers: list[BrowserEntry]) -> StartupPrefs | None:
    mode = payload.get("mode")
    if not isinstance(mode, str) or mode not in VALID_MODES:
        return None

    auto_open = payload.get("auto_open_on_ready", False)
    auto_close = payload.get("auto_close_on_open", True)
    auto_open = bool(auto_open)
    auto_close = bool(auto_close)

    if mode == "default":
        return StartupPrefs(mode="default", browser=None, auto_open_on_ready=auto_open, auto_close_on_open=auto_close)

    browser_name = payload.get("browser_name")
    if not isinstance(browser_name, str) or not browser_name.strip():
        return None
    browser = _browser_by_name(browser_name, browsers)
    if browser is None:
        return None
    return StartupPrefs(mode="selected", browser=browser, auto_open_on_ready=auto_open, auto_close_on_open=auto_close)


def load_prefs(pref_path: str | Path, browsers: list[BrowserEntry]) -> StartupPrefs | None:
    path = Path(pref_path)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None

    schema_version = payload.get("schema_version", 1)
    if schema_version not in {1, 2}:
        return None

    if schema_version == 1:
        payload = {
            "mode": payload.get("mode"),
            "browser_name": payload.get("browser_name"),
            "auto_open_on_ready": False,
            "auto_close_on_open": True,
        }
    return _prefs_from_payload(payload, browsers)


def save_prefs(pref_path: str | Path, prefs: StartupPrefs) -> None:
    if prefs.mode not in VALID_MODES:
        raise ValueError(f"Unsupported browser mode: {prefs.mode}")
    payload = {
        "schema_version": SCHEMA_VERSION,
        "mode": prefs.mode,
        "browser_name": None,
        "auto_open_on_ready": bool(prefs.auto_open_on_ready),
        "auto_close_on_open": bool(prefs.auto_close_on_open),
    }
    if prefs.mode == "selected":
        if prefs.browser is None:
            raise ValueError("Browser entry is required when mode='selected'.")
        payload["browser_name"] = prefs.browser.name

    path = Path(pref_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def describe_choice_for_log(mode: str, browser: BrowserEntry | None) -> str:
    if mode == "selected" and browser is not None:
        return f"selected:{browser.name}"
    return "default"


def prefs_to_choice(prefs: StartupPrefs) -> BrowserChoice:
    return BrowserChoice(mode=prefs.mode, browser=prefs.browser)


__all__ = [
    "BrowserChoice",
    "StartupPrefs",
    "SCHEMA_VERSION",
    "VALID_MODES",
    "describe_choice_for_log",
    "load_choice",
    "load_prefs",
    "prefs_to_choice",
    "save_prefs",
    "save_choice",
]
