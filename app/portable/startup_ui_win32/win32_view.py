from __future__ import annotations

import ctypes

from app.portable.startup_shared.browsers_win import BrowserEntry
from app.portable.startup_shared.browser_pref import StartupPrefs

from .win32_api import (
    BM_GETCHECK,
    BM_SETCHECK,
    BS_AUTOCHECKBOX,
    BS_DEFPUSHBUTTON,
    BS_PUSHBUTTON,
    BST_CHECKED,
    CB_ADDSTRING,
    CB_GETCURSEL,
    CB_RESETCONTENT,
    CB_SETCURSEL,
    CBS_DROPDOWNLIST,
    PBM_SETBARCOLOR,
    PBM_SETMARQUEE,
    PBS_MARQUEE,
    SS_ICON,
    WS_CHILD,
    WS_TABSTOP,
    WS_VISIBLE,
    apply_font,
    create_font,
    create_solid_brush,
    create_window,
    delete_object,
    enable_window,
    get_client_rect,
    last_error_message,
    load_app_icon,
    move_window,
    send_message,
    set_window_theme,
    set_control_icon,
    set_dc_bk_color,
    set_dc_text_color,
    set_text,
    show_control,
    Win32ApiError,
)


def _handle(dialog, key: str) -> int | None:
    return dialog._controls.get(key)


def _safe_show(dialog, key: str, visible: bool) -> None:
    handle = _handle(dialog, key)
    if handle:
        show_control(handle, visible)


def _safe_enable(dialog, key: str, enabled: bool) -> None:
    handle = _handle(dialog, key)
    if handle:
        enable_window(handle, enabled)


def _safe_set_text(dialog, key: str, text: str) -> None:
    handle = _handle(dialog, key)
    if handle:
        set_text(handle, text)


def _require_handle(handle: int | None, message: str) -> int:
    if not handle:
        raise Win32ApiError(message)
    return int(handle)


def _create_control(name: str, *args) -> int:
    try:
        hwnd = create_window(*args)
    except Win32ApiError as exc:
        raise Win32ApiError(f"Create control {name} failed", exc.code, exc.details) from exc
    if not hwnd:
        raise Win32ApiError(f"Create control {name} failed", None, last_error_message())
    return int(hwnd)


def create_controls(dialog, hwnd) -> None:
    dialog._header_brush = _require_handle(create_solid_brush(dialog._colors["header_bg"]), "Create header brush failed")
    dialog._fonts["title"] = _require_handle(create_font("Segoe UI", 13, 600), "Create title font failed")
    dialog._fonts["body"] = _require_handle(create_font("Segoe UI", 9, 400), "Create body font failed")

    dialog._controls["header_band"] = _create_control(
        "header_band",
        "STATIC",
        "",
        WS_CHILD | WS_VISIBLE,
        0,
        0,
        0,
        0,
        0,
        hwnd,
        None,
    )
    dialog._controls["logo"] = _create_control(
        "logo",
        "STATIC",
        "",
        WS_CHILD | WS_VISIBLE | SS_ICON,
        0,
        0,
        0,
        0,
        0,
        hwnd,
        None,
    )
    set_control_icon(dialog._controls["logo"], load_app_icon())
    dialog._controls["title"] = _create_control(
        "title",
        "STATIC",
        "QualiFile",
        WS_CHILD | WS_VISIBLE,
        0,
        0,
        0,
        0,
        0,
        hwnd,
        None,
    )
    dialog._controls["subtitle"] = _create_control(
        "subtitle",
        "STATIC",
        "Startup progress",
        WS_CHILD | WS_VISIBLE,
        0,
        0,
        0,
        0,
        0,
        hwnd,
        None,
    )
    dialog._controls["status"] = _create_control(
        "status",
        "STATIC",
        "Starting",
        WS_CHILD | WS_VISIBLE,
        0,
        0,
        0,
        0,
        0,
        hwnd,
        None,
    )
    dialog._controls["progress"] = _create_control(
        "progress",
        "msctls_progress32",
        "",
        WS_CHILD | WS_VISIBLE | PBS_MARQUEE,
        0,
        0,
        0,
        0,
        0,
        hwnd,
        None,
    )
    send_message(dialog._controls["progress"], PBM_SETMARQUEE, 1, 25)
    send_message(dialog._controls["progress"], PBM_SETBARCOLOR, 0, dialog._colors["accent"])
    dialog._controls["ready_info"] = _create_control(
        "ready_info",
        "STATIC",
        "",
        WS_CHILD | WS_VISIBLE,
        0,
        0,
        0,
        0,
        0,
        hwnd,
        None,
    )

    dialog._controls["open_default"] = _add_button(dialog, hwnd, "Open", dialog._ID_OPEN_DEFAULT)
    dialog._controls["exit"] = _add_button(dialog, hwnd, "Close", dialog._ID_EXIT)
    dialog._controls["settings_btn"] = _add_button(dialog, hwnd, "Settings", dialog._ID_SETTINGS)

    dialog._controls["prompt_label"] = _create_control(
        "prompt_label",
        "STATIC",
        "Choose browser before startup:",
        WS_CHILD | WS_VISIBLE,
        0,
        0,
        0,
        0,
        0,
        hwnd,
        None,
    )
    dialog._controls["prompt_combo"] = _create_control(
        "prompt_combo",
        "COMBOBOX",
        "",
        WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST | WS_TABSTOP,
        0,
        0,
        0,
        0,
        0,
        hwnd,
        dialog._ID_PROMPT_COMBO,
    )
    dialog._controls["prompt_remember"] = _create_control(
        "prompt_remember",
        "BUTTON",
        "Remember this browser",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
        0,
        0,
        0,
        0,
        0,
        hwnd,
        dialog._ID_PROMPT_REMEMBER,
    )
    dialog._controls["prompt_launch"] = _create_control(
        "prompt_launch",
        "BUTTON",
        "Start",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
        0,
        0,
        0,
        0,
        0,
        hwnd,
        dialog._ID_PROMPT_LAUNCH,
    )
    dialog._controls["prompt_cancel"] = _add_button(dialog, hwnd, "Cancel", dialog._ID_PROMPT_CANCEL)

    dialog._controls["settings_label"] = _create_control(
        "settings_label",
        "STATIC",
        "Settings",
        WS_CHILD | WS_VISIBLE,
        0,
        0,
        0,
        0,
        0,
        hwnd,
        None,
    )
    dialog._controls["settings_combo"] = _create_control(
        "settings_combo",
        "COMBOBOX",
        "",
        WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST | WS_TABSTOP,
        0,
        0,
        0,
        0,
        0,
        hwnd,
        dialog._ID_SETTINGS_COMBO,
    )
    dialog._controls["settings_auto_open"] = _create_control(
        "settings_auto_open",
        "BUTTON",
        "Auto-open browser when ready",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
        0,
        0,
        0,
        0,
        0,
        hwnd,
        dialog._ID_SETTINGS_AUTO_OPEN,
    )
    dialog._controls["settings_auto_close"] = _create_control(
        "settings_auto_close",
        "BUTTON",
        "Close dialog after opening browser",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
        0,
        0,
        0,
        0,
        0,
        hwnd,
        dialog._ID_SETTINGS_AUTO_CLOSE,
    )
    dialog._controls["settings_save"] = _add_button(dialog, hwnd, "Save", dialog._ID_SETTINGS_SAVE)
    dialog._controls["settings_back"] = _add_button(dialog, hwnd, "Back", dialog._ID_SETTINGS_BACK)

    for key in (
        "progress",
        "open_default",
        "exit",
        "settings_btn",
        "prompt_combo",
        "prompt_remember",
        "prompt_launch",
        "prompt_cancel",
        "settings_combo",
        "settings_auto_open",
        "settings_auto_close",
        "settings_save",
        "settings_back",
    ):
        handle = dialog._controls.get(key)
        if handle:
            set_window_theme(handle, "Explorer")

    apply_fonts(dialog)
    set_ready_controls(dialog, False)
    show_prompt_controls(dialog, False)
    show_settings_controls(dialog, False)
    show_startup_controls(dialog, True)
    layout(dialog)


def dispose_resources(dialog) -> None:
    for font in dialog._fonts.values():
        delete_object(font)
    dialog._fonts.clear()
    if dialog._header_brush:
        delete_object(dialog._header_brush)
        dialog._header_brush = None


def apply_fonts(dialog) -> None:
    for key, handle in dialog._controls.items():
        if key == "title":
            apply_font(handle, dialog._fonts["title"])
        else:
            apply_font(handle, dialog._fonts["body"])


def compute_layout(width: int, height: int, scale: float) -> dict[str, tuple[int, int, int, int]]:
    def px(value: int) -> int:
        return max(1, int(round(value * scale)))

    pad = px(14)
    gap = px(8)
    header_h = px(50)
    line_h = px(20)
    btn_h = px(28)
    btn_w = px(92)
    btn_primary = px(120)
    settings_w = px(86)
    settings_h = px(24)

    rects: dict[str, tuple[int, int, int, int]] = {}
    rects["header_band"] = (0, 0, width, header_h)
    rects["logo"] = (pad, px(8), px(32), px(32))
    title_w = max(px(140), width - (pad + px(40)) - pad)
    rects["title"] = (pad + px(40), px(8), title_w, px(20))
    rects["subtitle"] = (pad + px(40), px(28), width - (pad + px(40)) - pad, px(16))
    rects["settings_btn"] = (width - pad - settings_w, px(12), settings_w, settings_h)

    content_top = header_h + gap
    button_y = height - pad - btn_h
    content_bottom = max(content_top + line_h, button_y - gap)

    rects["status"] = (pad, content_top, width - 2 * pad, line_h)
    rects["progress"] = (pad, content_top + line_h + gap, width - 2 * pad, px(12))
    rects["ready_info"] = (pad, content_top, width - 2 * pad, line_h * 2)

    label_y = content_top
    combo_y = label_y + line_h + gap
    remember_y = combo_y + line_h + gap
    rects["prompt_label"] = (pad, label_y, width - 2 * pad, line_h)
    rects["prompt_combo"] = (pad, combo_y, width - 2 * pad, line_h)
    rects["prompt_remember"] = (pad, remember_y, width - 2 * pad, line_h)

    cancel_x = width - pad - btn_w
    primary_x = max(pad, cancel_x - gap - btn_primary)
    rects["prompt_launch"] = (primary_x, button_y, btn_primary, btn_h)
    rects["prompt_cancel"] = (cancel_x, button_y, btn_w, btn_h)
    rects["open_default"] = (primary_x, button_y, btn_primary, btn_h)
    rects["exit"] = (cancel_x, button_y, btn_w, btn_h)

    settings_label_y = content_top
    settings_combo_y = settings_label_y + line_h + gap
    settings_open_y = settings_combo_y + line_h + gap
    settings_close_y = settings_open_y + line_h + gap
    rects["settings_label"] = (pad, settings_label_y, width - 2 * pad, line_h)
    rects["settings_combo"] = (pad, settings_combo_y, width - 2 * pad, line_h)
    rects["settings_auto_open"] = (pad, settings_open_y, width - 2 * pad, line_h)
    rects["settings_auto_close"] = (pad, settings_close_y, width - 2 * pad, line_h)
    rects["settings_save"] = (primary_x, button_y, btn_primary, btn_h)
    rects["settings_back"] = (cancel_x, button_y, btn_w, btn_h)

    for key, (x, y, w, h) in list(rects.items()):
        if y + h > content_bottom and key not in {
            "prompt_launch",
            "prompt_cancel",
            "open_default",
            "exit",
            "settings_save",
            "settings_back",
        }:
            rects[key] = (x, min(y, max(content_top, content_bottom - h)), w, h)

    return rects


def layout(dialog, *, fallback: bool = False) -> None:
    hwnd = dialog.handle.hwnd
    if not hwnd:
        return
    width: int | None = None
    height: int | None = None
    if not fallback:
        ok, rect = get_client_rect(hwnd)
        if ok:
            width = rect.right - rect.left
            height = rect.bottom - rect.top
            if width <= 1 or height <= 1:
                if hasattr(dialog, "_log_line"):
                    dialog._log_line("SPD: layout sanity failed, applying fallback rect")
                layout(dialog, fallback=True)
                return
            dialog._last_client_size = (width, height)
        else:
            if hasattr(dialog, "_log_line"):
                dialog._log_line("SPD: GetClientRect failed; using fallback layout size")
            layout(dialog, fallback=True)
            return
    if width is None or height is None:
        width = dialog._px(max(dialog.config.width, 560))
        height = dialog._px(max(dialog.config.height, 260))

    rects = compute_layout(width, height, dialog._scale)
    for key, (x, y, w, h) in rects.items():
        set_bounds(dialog, key, x, y, w, h)

    title_w = rects.get("title", (0, 0, 0, 0))[2]
    progress_w = rects.get("progress", (0, 0, 0, 0))[2]
    critical = {
        "title": title_w,
        "progress": progress_w,
        "status": rects.get("status", (0, 0, 1, 1))[2],
    }
    if any(value <= 1 for value in critical.values()):
        if hasattr(dialog, "_log_line"):
            dialog._log_line("SPD: layout sanity failed, applying fallback rect")
        if not fallback:
            layout(dialog, fallback=True)
            return
        if hasattr(dialog, "_log_line"):
            dialog._log_line("SPD: layout sanity failed after fallback")
        if hasattr(dialog, "close"):
            dialog.close()
    dialog._last_layout_metrics = {"title_w": title_w, "progress_w": progress_w}


def set_bounds(dialog, key: str, x: int, y: int, w: int, h: int) -> None:
    hwnd = dialog._controls.get(key)
    if hwnd:
        ok, error = move_window(hwnd, x, y, w, h)
        if not ok and hasattr(dialog, "_log_line") and key not in dialog._layout_warned_controls:
            dialog._layout_warned_controls.add(key)
            dialog._log_line(f"SPD: MoveWindow failed for {key} ({error})")


def handle_static_paint(dialog, hdc: int, control: int) -> int:
    if control in {
        dialog._controls.get("header_band"),
        dialog._controls.get("title"),
        dialog._controls.get("subtitle"),
        dialog._controls.get("logo"),
    }:
        set_dc_bk_color(hdc, dialog._colors["header_bg"])
        if control in {dialog._controls.get("title"), dialog._controls.get("subtitle")}:
            set_dc_text_color(hdc, dialog._colors["header_text"])
        return int(dialog._header_brush or 0)
    if control in {dialog._controls.get("status")}:
        set_dc_text_color(hdc, dialog._colors["text_main"])
    return 0


def show_startup_controls(dialog, visible: bool) -> None:
    for key in ("status", "progress"):
        _safe_show(dialog, key, visible)
    if visible:
        _safe_set_text(dialog, "exit", "Cancel")
        _safe_enable(dialog, "exit", True)
        _safe_show(dialog, "exit", True)
    else:
        _safe_show(dialog, "exit", False)
    if visible:
        _safe_show(dialog, "ready_info", False)


def show_prompt_controls(dialog, visible: bool) -> None:
    for key in ("prompt_label", "prompt_combo", "prompt_remember", "prompt_launch", "prompt_cancel"):
        _safe_show(dialog, key, visible)
    dialog._prompt_mode = visible
    if visible:
        _safe_show(dialog, "exit", False)
        _safe_show(dialog, "status", False)
        _safe_show(dialog, "progress", False)
        _safe_show(dialog, "ready_info", False)
    show_startup_controls(dialog, not visible)


def show_settings_controls(dialog, visible: bool) -> None:
    for key in (
        "settings_label",
        "settings_combo",
        "settings_auto_open",
        "settings_auto_close",
        "settings_save",
        "settings_back",
    ):
        _safe_show(dialog, key, visible)
    if visible:
        _safe_set_text(dialog, "settings_save", "Save")
        _safe_set_text(dialog, "settings_back", "Back")
        _safe_show(dialog, "status", False)
        _safe_show(dialog, "progress", False)
        _safe_show(dialog, "ready_info", False)
        _safe_show(dialog, "open_default", False)
        _safe_show(dialog, "exit", False)
        _safe_show(dialog, "prompt_label", False)
        _safe_show(dialog, "prompt_combo", False)
        _safe_show(dialog, "prompt_remember", False)
        _safe_show(dialog, "prompt_launch", False)
        _safe_show(dialog, "prompt_cancel", False)


def set_ready_controls(dialog, ready: bool) -> None:
    for key in ("open_default", "ready_info"):
        _safe_enable(dialog, key, ready)
        _safe_show(dialog, key, ready)
    if ready:
        _safe_set_text(dialog, "exit", "Close")
        _safe_enable(dialog, "exit", True)
        _safe_show(dialog, "exit", True)
        _safe_show(dialog, "status", False)
        _safe_show(dialog, "progress", False)
    else:
        _safe_show(dialog, "exit", False)


def set_error_controls(dialog, message: str) -> None:
    set_ready_controls(dialog, False)
    show_prompt_controls(dialog, False)
    show_startup_controls(dialog, False)
    _safe_set_text(dialog, "ready_info", message)
    _safe_show(dialog, "ready_info", True)
    _safe_set_text(dialog, "exit", "Close")
    _safe_enable(dialog, "exit", True)
    _safe_show(dialog, "exit", True)


def populate_browsers(dialog, combo_key: str, browsers: list[BrowserEntry]) -> None:
    combo = dialog._controls.get(combo_key)
    if not combo:
        return
    send_message(combo, CB_RESETCONTENT, 0, 0)
    send_message(combo, CB_ADDSTRING, 0, ctypes.c_wchar_p("Default browser"))
    for entry in browsers:
        send_message(combo, CB_ADDSTRING, 0, ctypes.c_wchar_p(entry.name))
    send_message(combo, CB_SETCURSEL, 0, 0)


def set_settings_values(dialog, prefs: StartupPrefs, browsers: list[BrowserEntry]) -> None:
    populate_browsers(dialog, "settings_combo", browsers)
    combo = dialog._controls.get("settings_combo")
    if combo and prefs.mode == "selected" and prefs.browser is not None:
        for idx, entry in enumerate(browsers, start=1):
            if entry.name.strip().lower() == prefs.browser.name.strip().lower():
                send_message(combo, CB_SETCURSEL, idx, 0)
                break
    _safe_set_check(dialog, "settings_auto_open", prefs.auto_open_on_ready)
    _safe_set_check(dialog, "settings_auto_close", prefs.auto_close_on_open)


def read_settings_values(dialog) -> tuple[str, str | None, bool, bool]:
    combo = dialog._controls.get("settings_combo")
    if not combo:
        return "default", None, False, True
    index = int(send_message(combo, CB_GETCURSEL, 0, 0))
    mode = "default"
    browser_name = None
    if index > 0 and index - 1 < len(dialog._settings_browsers):
        mode = "selected"
        browser_name = dialog._settings_browsers[index - 1].name
    auto_open_handle = dialog._controls.get("settings_auto_open")
    auto_close_handle = dialog._controls.get("settings_auto_close")
    auto_open = int(send_message(auto_open_handle, BM_GETCHECK, 0, 0)) == BST_CHECKED if auto_open_handle else False
    auto_close = int(send_message(auto_close_handle, BM_GETCHECK, 0, 0)) == BST_CHECKED if auto_close_handle else True
    return mode, browser_name, auto_open, auto_close


def handle_prompt_submit(dialog) -> None:
    combo = dialog._controls.get("prompt_combo")
    remember_handle = dialog._controls.get("prompt_remember")
    if not combo or not remember_handle:
        dialog._emit_user_event({"type": "browser_choice", "cancelled": True})
        return
    index = int(send_message(combo, CB_GETCURSEL, 0, 0))
    remember = int(send_message(remember_handle, BM_GETCHECK, 0, 0)) == BST_CHECKED
    mode = "default"
    browser_name = None
    if index > 0 and index - 1 < len(dialog._prompt_browsers):
        mode = "selected"
        browser_name = dialog._prompt_browsers[index - 1].name
    dialog._emit_user_event(
        {
            "type": "browser_choice",
            "cancelled": False,
            "mode": mode,
            "browser_name": browser_name,
            "remember": remember,
        }
    )
    dialog._prompt_mode = False
    show_prompt_controls(dialog, False)
    show_startup_controls(dialog, True)


def _add_button(dialog, hwnd, text: str, control_id: int) -> int:
    return create_window(
        "BUTTON",
        text,
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
        0,
        0,
        0,
        0,
        0,
        hwnd,
        control_id,
    )
def _safe_set_check(dialog, key: str, checked: bool) -> None:
    handle = _handle(dialog, key)
    if handle:
        send_message(handle, BM_SETCHECK, BST_CHECKED if checked else 0, 0)
