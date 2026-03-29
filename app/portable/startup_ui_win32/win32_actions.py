from __future__ import annotations

import os
import webbrowser

from app.portable.startup_shared.browsers_win import open_browser

from .win32_api import CB_GETCURSEL, send_message, set_clipboard_text


def handle_default_browser_open(dialog) -> None:
    if dialog._ready_info and dialog._ready_info.url:
        webbrowser.open(dialog._ready_info.url)
        prefs = getattr(dialog, "_prefs", None)
        if prefs and getattr(prefs, "auto_close_on_open", False):
            dialog.close()


def handle_selected_browser_open(dialog) -> None:
    if not dialog._ready_info or not dialog._ready_info.url:
        return
    index = int(send_message(dialog._controls["browser_combo"], CB_GETCURSEL, 0, 0))
    if index <= 0:
        webbrowser.open(dialog._ready_info.url)
        return
    browser = dialog._browsers[index - 1]
    open_browser(dialog._ready_info.url, browser)


def handle_open_folder(path: str | None) -> None:
    if path:
        try:
            os.startfile(path)
        except Exception:
            return


def handle_copy_diagnostics(dialog) -> None:
    if dialog._ready_info and dialog._ready_info.diagnostics_text:
        set_clipboard_text(dialog._ready_info.diagnostics_text)
