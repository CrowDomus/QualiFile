from __future__ import annotations

from dataclasses import dataclass
import os
import queue
import threading
from typing import Callable

from app.portable.startup_shared.browsers_win import BrowserEntry
from app.portable.startup_shared.browser_pref import StartupPrefs, save_prefs
from app.portable.startup_shared.constants import STAGES

from .win32_api import (
    CW_USEDEFAULT,
    MB_ICONERROR,
    MB_OK,
    PBM_SETMARQUEE,
    RDW_ALLCHILDREN,
    RDW_ERASE,
    RDW_INVALIDATE,
    RDW_UPDATENOW,
    SW_HIDE,
    SW_SHOW,
    WM_CLOSE,
    WM_COMMAND,
    WM_CREATE,
    WM_CTLCOLORSTATIC,
    WM_DESTROY,
    WM_SIZE,
    WM_TIMER,
    WS_OVERLAPPEDWINDOW,
    WS_MAXIMIZEBOX,
    WS_THICKFRAME,
    WS_VISIBLE,
    WNDPROC,
    create_window,
    destroy_window,
    get_dpi_for_window,
    init_common_controls,
    invalidate_rect,
    kill_timer,
    load_app_icon,
    last_error_message,
    message_loop,
    post_message,
    post_quit_message,
    redraw_window,
    register_class,
    send_message,
    set_text,
    set_timer,
    set_window_icons,
    show_control,
    show_window,
    update_window,
)
from .win32_view import (
    create_controls,
    dispose_resources,
    handle_prompt_submit,
    handle_static_paint,
    layout,
    populate_browsers,
    set_error_controls,
    set_ready_controls,
    set_settings_values,
    show_settings_controls,
    read_settings_values,
    show_prompt_controls,
    show_startup_controls,
)
from .win32_actions import handle_default_browser_open
from .spd_log import append_exc, append_line


class Win32Error(RuntimeError):
    pass


def safe_callback(context: str, fn: Callable[[], None], on_error: Callable[[str, Exception], None] | None) -> bool:
    try:
        fn()
        return True
    except Exception as exc:
        if on_error is not None:
            on_error(context, exc)
        return False


def drain_queue(
    queue_ref: "queue.Queue[UiAction]",
    apply_fn: Callable[[UiAction], None],
    *,
    on_success: Callable[[UiAction], None] | None = None,
    on_error: Callable[[UiAction, Exception], None] | None = None,
) -> tuple[int, int]:
    applied = 0
    failed = 0
    while True:
        try:
            action = queue_ref.get_nowait()
        except queue.Empty:
            break
        try:
            apply_fn(action)
        except Exception as exc:
            failed += 1
            if on_error is not None:
                on_error(action, exc)
            continue
        applied += 1
        if on_success is not None:
            on_success(action)
    return applied, failed


def _color_ref(red: int, green: int, blue: int) -> int:
    return (red & 0xFF) | ((green & 0xFF) << 8) | ((blue & 0xFF) << 16)


@dataclass(frozen=True)
class WindowHandle:
    hwnd: int | None


@dataclass
class DialogConfig:
    title: str
    width: int = 560
    height: int = 260
    resizable: bool = False


@dataclass
class ReadyInfo:
    url: str | None
    port: int | None
    data_dir: str | None
    logs_dir: str | None
    diagnostics_text: str | None
    browsers: list[BrowserEntry]


@dataclass
class UiAction:
    kind: str
    payload: dict


class Win32Dialog:
    _MAX_ACTION_FAILURES = 3
    _ID_OPEN_DEFAULT = 2003
    _ID_EXIT = 2010
    _ID_SETTINGS = 2011
    _ID_PROMPT_COMBO = 2101
    _ID_PROMPT_REMEMBER = 2102
    _ID_PROMPT_LAUNCH = 2103
    _ID_PROMPT_CANCEL = 2104
    _ID_SETTINGS_COMBO = 2201
    _ID_SETTINGS_AUTO_OPEN = 2202
    _ID_SETTINGS_AUTO_CLOSE = 2203
    _ID_SETTINGS_SAVE = 2204
    _ID_SETTINGS_BACK = 2205

    def __init__(
        self,
        config: DialogConfig,
        *,
        queue_ref: "queue.Queue[UiAction]",
        on_cancel: Callable[[], None] | None = None,
        on_user_event: Callable[[dict], None] | None = None,
        log_error: Callable[[str], None] | None = None,
        log_dir: str | None = None,
        pref_path: str | None = None,
        prefs: StartupPrefs | None = None,
    ) -> None:
        self.config = config
        self.handle = WindowHandle(hwnd=None)
        self._on_cancel = on_cancel
        self._on_user_event = on_user_event
        self._log_error = log_error
        self._log_dir = log_dir
        self._queue = queue_ref
        self._controls: dict[str, int] = {}
        self._fonts: dict[str, int] = {}
        self._header_brush: int | None = None
        self._prompt_mode = False
        self._current_stage = STAGES[0]
        self._status = "Starting"
        self._ready_info: ReadyInfo | None = None
        self._prompt_browsers: list[BrowserEntry] = []
        self._settings_browsers: list[BrowserEntry] = []
        self._layout_warned_controls: set[str] = set()
        self._error_shown = False
        self._failed = False
        self._last_client_size: tuple[int, int] | None = None
        self._last_layout_metrics: dict[str, int] | None = None
        self._state_label: str | None = None
        self._view_mode: str = "starting"
        self._settings_prev_mode: str | None = None
        self._action_failures = 0
        self._degraded_mode = False
        self._logged_degraded = False
        self._pref_path = pref_path
        self._prefs = prefs or StartupPrefs(mode="default", browser=None, auto_open_on_ready=False, auto_close_on_open=True)
        self._error_message: str | None = None
        self._scale = max(0.75, float(get_dpi_for_window(None)) / 96.0)
        self._colors = {
            "header_bg": _color_ref(0, 150, 136),
            "header_text": _color_ref(255, 255, 255),
            "text_main": _color_ref(30, 30, 30),
            "accent": _color_ref(0, 150, 136),
        }
        self._dialog_id = hex(id(self))

    def run(self) -> None:
        init_common_controls()
        wnd_proc = WNDPROC(self._wnd_proc)
        register_class("QualiFileSPD", wnd_proc)
        style = WS_OVERLAPPEDWINDOW | WS_VISIBLE
        if not self.config.resizable:
            style &= ~WS_THICKFRAME
            style &= ~WS_MAXIMIZEBOX
        hwnd = create_window(
            "QualiFileSPD",
            self.config.title,
            style,
            0,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            self._px(self.config.width),
            self._px(self.config.height),
        )
        self.handle = WindowHandle(hwnd=hwnd)
        self._log_context("window_created")
        self._scale = max(0.75, float(get_dpi_for_window(hwnd)) / 96.0)
        set_window_icons(hwnd, load_app_icon())
        show_window(hwnd, SW_SHOW)
        set_timer(hwnd, 1, 60)
        message_loop()

    def close(self) -> None:
        hwnd = self.handle.hwnd
        if hwnd:
            try:
                post_message(hwnd, WM_CLOSE, 0, 0)
            except Exception:
                destroy_window(hwnd)

    def _log_line(self, line: str) -> None:
        if self._log_error is not None:
            self._log_error(line)
            return
        append_line(self._log_dir, line)

    def _log_exc(self, context: str, exc: Exception) -> None:
        if self._log_error is not None:
            self._log_error(f"{context}: {exc}")
            return
        append_exc(self._log_dir, context, exc)

    def _log_context(self, event: str, extra: str | None = None) -> None:
        pid = os.getpid()
        tid = threading.get_ident()
        hwnd = self.handle.hwnd or 0
        suffix = f" {extra}" if extra else ""
        self._log_line(
            f"SPD: {event} pid={pid} tid={tid} dialog_id={self._dialog_id} hwnd={hwnd}{suffix}"
        )

    def _set_state(self, label: str) -> None:
        if self._state_label != label:
            self._state_label = label
            self._log_line(f"SPD: state={label}")
            subtitle_map = {
                "prompt": "Choose browser",
                "starting": "Starting...",
                "ready": "Ready",
                "error": "Error",
            }
            subtitle = subtitle_map.get(label)
            if subtitle and "subtitle" in self._controls:
                set_text(self._controls["subtitle"], subtitle)

    def _handle_wndproc_error(self, context: str, exc: Exception, hwnd: int | None) -> None:
        err = last_error_message()
        message = f"SPD: {context} failed: {type(exc).__name__}: {exc}"
        if err:
            message = f"{message} (last_error={err})"
        self._log_exc(context, exc)
        if not self._error_shown:
            self._error_shown = True
            try:
                message_box(
                    hwnd or 0,
                    "Startup UI failed; continuing without UI.\nSee logs for details.",
                    "QualiFile startup",
                    MB_OK | MB_ICONERROR,
                )
            except Exception:
                pass
        self._failed = True
        try:
            if hwnd:
                destroy_window(hwnd)
        except Exception:
            try:
                post_message(hwnd, WM_CLOSE, 0, 0)
            except Exception:
                return

    def _handle_nonfatal_wndproc_error(self, context: str, exc: Exception) -> None:
        err_type = type(exc).__name__
        err = last_error_message()
        if err and err != "No error.":
            self._log_line(f"SPD: {context} failed err={err_type} ({err})")
        else:
            self._log_line(f"SPD: {context} failed err={err_type}")
        self._action_failures += 1
        if self._action_failures >= self._MAX_ACTION_FAILURES:
            self._enable_degraded_mode()

    def _enable_degraded_mode(self) -> None:
        if not self._degraded_mode:
            self._degraded_mode = True
            if not self._logged_degraded:
                self._logged_degraded = True
                self._log_line("SPD: degraded mode enabled")

    def _redraw(self) -> None:
        hwnd = self.handle.hwnd
        if not hwnd:
            return
        try:
            redraw_window(hwnd, RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_ERASE | RDW_UPDATENOW)
            update_window(hwnd)
        except Exception:
            try:
                invalidate_rect(hwnd)
                update_window(hwnd)
            except Exception:
                return

    def _resolve_current_view(self) -> str:
        if self._state_label == "prompt":
            return "prompt"
        if self._state_label == "error":
            return "error"
        if self._state_label == "ready" or self._ready_info is not None:
            return "ready"
        return "starting"

    def _apply_view(self, view: str) -> None:
        prev = self._view_mode
        self._view_mode = view
        if view != "settings":
            self._set_state(view)
        if view == "settings":
            show_prompt_controls(self, False)
            show_startup_controls(self, False)
            set_ready_controls(self, False)
            show_settings_controls(self, True)
            if "settings_btn" in self._controls:
                show_control(self._controls["settings_btn"], False)
        elif view == "prompt":
            show_prompt_controls(self, True)
            show_settings_controls(self, False)
            show_startup_controls(self, False)
            set_ready_controls(self, False)
            if "settings_btn" in self._controls:
                show_control(self._controls["settings_btn"], True)
        elif view == "ready":
            show_prompt_controls(self, False)
            show_settings_controls(self, False)
            show_startup_controls(self, False)
            set_ready_controls(self, True)
            if "settings_btn" in self._controls:
                show_control(self._controls["settings_btn"], True)
        elif view == "error":
            show_settings_controls(self, False)
            set_error_controls(self, self._error_message or "Error")
            if "settings_btn" in self._controls:
                show_control(self._controls["settings_btn"], False)
        else:
            show_prompt_controls(self, False)
            show_settings_controls(self, False)
            set_ready_controls(self, False)
            show_startup_controls(self, True)
            if "settings_btn" in self._controls:
                show_control(self._controls["settings_btn"], True)
        layout(self)
        self._redraw()
        if view != prev:
            self._log_context(f"view={view}")

    def _apply_minimal_action(self, action: UiAction) -> None:
        status = self._controls.get("status")
        if not status:
            return
        kind = action.kind
        payload = action.payload
        text = None
        if kind == "status":
            text = str(payload.get("status") or self._status)
        elif kind == "stage":
            text = str(payload.get("message") or payload.get("stage") or self._current_stage)
        elif kind == "ready":
            text = "Ready"
        elif kind == "error":
            text = str(payload.get("message") or "Error")
        if text:
            try:
                set_text(status, text)
            except Exception:
                pass

    def _log_action_failure(self, action: UiAction, exc: Exception) -> None:
        err_type = type(exc).__name__
        self._log_line(f"SPD: action failed kind={action.kind} err={err_type}")
        self._action_failures += 1
        if self._action_failures >= self._MAX_ACTION_FAILURES:
            self._enable_degraded_mode()

    def _ensure_controls(self, keys: tuple[str, ...]) -> bool:
        missing = [key for key in keys if not self._controls.get(key)]
        if missing:
            self._log_line(f"SPD: missing controls {', '.join(missing)}")
            self._enable_degraded_mode()
            return False
        return True

    def _wnd_proc(self, hwnd, msg, wparam, lparam):
        if msg == WM_CREATE:
            if not self.handle.hwnd:
                self.handle = WindowHandle(hwnd=hwnd)
            if not safe_callback(
                "WM_CREATE",
                lambda: create_controls(self, hwnd),
                lambda ctx, exc: self._handle_wndproc_error(ctx, exc, hwnd),
            ):
                return 0
            self._log_line("SPD: created controls OK")
            return 0
        if msg == WM_TIMER:
            safe_callback(
                "WM_TIMER",
                self._drain_queue,
                lambda ctx, exc: self._handle_nonfatal_wndproc_error(ctx, exc),
            )
            return 0
        if msg == WM_COMMAND:
            safe_callback(
                "WM_COMMAND",
                lambda: self._handle_command(wparam & 0xFFFF),
                lambda ctx, exc: self._handle_nonfatal_wndproc_error(ctx, exc),
            )
            return 0
        if msg == WM_SIZE:
            ok = safe_callback(
                "WM_SIZE",
                lambda: layout(self),
                lambda ctx, exc: self._handle_wndproc_error(ctx, exc, hwnd),
            )
            if not ok:
                safe_callback(
                    "WM_SIZE_fallback",
                    lambda: layout(self, fallback=True),
                    lambda ctx, exc: self._handle_wndproc_error(ctx, exc, hwnd),
                )
            return 0
        if msg == WM_CTLCOLORSTATIC:
            holder: dict[str, int] = {"brush": 0}

            def _paint() -> None:
                brush = handle_static_paint(self, int(wparam), int(lparam))
                if brush:
                    holder["brush"] = int(brush)

            ok = safe_callback(
                "WM_CTLCOLORSTATIC",
                _paint,
                lambda ctx, exc: self._handle_nonfatal_wndproc_error(ctx, exc),
            )
            if ok and holder["brush"]:
                return holder["brush"]
        if msg == WM_DESTROY:
            safe_callback(
                "WM_DESTROY",
                lambda: (kill_timer(hwnd, 1), dispose_resources(self), post_quit_message()),
                lambda ctx, exc: self._handle_nonfatal_wndproc_error(ctx, exc),
            )
            return 0
        if msg == WM_CLOSE:
            try:
                return self._handle_close(hwnd)
            except Exception as exc:
                self._handle_nonfatal_wndproc_error("WM_CLOSE", exc)
                return 0
        from .win32_api import def_window_proc

        return def_window_proc(hwnd, msg, wparam, lparam)

    def _handle_close(self, hwnd) -> int:
        if self._prompt_mode:
            self._emit_user_event({"type": "browser_choice", "cancelled": True})
            if self._on_cancel is not None:
                self._on_cancel()
            destroy_window(hwnd)
            return 0
        if self._view_mode == "settings":
            self._exit_settings()
            current = self._resolve_current_view()
            if current not in {"ready", "error"}:
                if self._on_cancel is not None:
                    self._on_cancel()
            destroy_window(hwnd)
            return 0
        if self._status not in {"Ready", "Error"}:
            if self._on_cancel is not None:
                self._on_cancel()
            destroy_window(hwnd)
            return 0
        destroy_window(hwnd)
        return 0

    def _px(self, value: int) -> int:
        return max(1, int(round(value * self._scale)))

    def _handle_command(self, control_id: int) -> None:
        if control_id == self._ID_OPEN_DEFAULT:
            handle_default_browser_open(self)
        elif control_id == self._ID_EXIT:
            self._handle_close(self.handle.hwnd)
        elif control_id == self._ID_SETTINGS:
            self._enter_settings()
        elif control_id == self._ID_PROMPT_CANCEL:
            self._emit_user_event({"type": "browser_choice", "cancelled": True})
            if self._on_cancel is not None:
                self._on_cancel()
            self.close()
        elif control_id == self._ID_PROMPT_LAUNCH:
            handle_prompt_submit(self)
            self._apply_view("starting")
        elif control_id == self._ID_SETTINGS_SAVE:
            self._save_settings()
        elif control_id == self._ID_SETTINGS_BACK:
            self._exit_settings()

    def _emit_user_event(self, payload: dict) -> None:
        if self._on_user_event is not None:
            self._on_user_event(payload)

    def _drain_queue(self) -> None:
        logged_start = False

        def _on_success(action: UiAction) -> None:
            nonlocal logged_start
            if not logged_start:
                self._log_line("SPD: WM_TIMER drain start")
                logged_start = True
            self._log_line(f"SPD: applied action kind={action.kind}")

        def _on_error(action: UiAction, exc: Exception) -> None:
            nonlocal logged_start
            if not logged_start:
                self._log_line("SPD: WM_TIMER drain start")
                logged_start = True
            self._log_action_failure(action, exc)

        drain_queue(self._queue, self._apply_action, on_success=_on_success, on_error=_on_error)

    def _apply_action(self, action: UiAction) -> None:
        if self._degraded_mode:
            self._apply_minimal_action(action)
            return
        kind = action.kind
        payload = action.payload
        if self._view_mode == "settings" and kind in {"stage", "status", "ready", "error"}:
            if kind == "stage":
                stage = payload.get("stage")
                if stage:
                    self._current_stage = str(stage)
                message = payload.get("message")
                if message:
                    self._status = str(message)
                self._set_state("starting")
            elif kind == "status":
                value = str(payload.get("status") or self._status)
                self._status = value
                self._set_state("starting")
            elif kind == "ready":
                info = payload.get("info")
                if isinstance(info, ReadyInfo):
                    self._ready_info = info
                self._status = "Ready"
                self._set_state("ready")
            elif kind == "error":
                message = str(payload.get("message") or "Error")
                self._status = "Error"
                self._error_message = message
                self._set_state("error")
            return
        if kind == "prefs":
            prefs = payload.get("prefs")
            browsers = payload.get("browsers", [])
            if isinstance(prefs, StartupPrefs):
                self._prefs = prefs
            if isinstance(browsers, list):
                self._settings_browsers = [entry for entry in browsers if isinstance(entry, BrowserEntry)]
            if self._view_mode == "settings":
                set_settings_values(self, self._prefs, self._settings_browsers)
                self._redraw()
            return
        if kind == "stage":
            if not self._ensure_controls(("status", "progress", "exit")):
                return
            if self._state_label in {"ready", "error"} or self._ready_info is not None:
                # Ignore late stage updates after ready/error to avoid reverting the view.
                return
            self._apply_view("starting")
            stage = payload.get("stage")
            if stage:
                self._current_stage = str(stage)
            message = payload.get("message")
            handle = self._controls.get("status")
            if handle:
                set_text(handle, str(message or self._current_stage))
        elif kind == "status":
            if not self._ensure_controls(("status",)):
                return
            if self._state_label not in {"prompt", "ready", "error"}:
                self._apply_view("starting")
            value = str(payload.get("status") or self._status)
            self._status = value
            handle = self._controls.get("status")
            if handle:
                set_text(handle, value)
        elif kind == "logs":
            return
        elif kind == "prompt":
            if not self._ensure_controls(("prompt_label", "prompt_combo", "prompt_remember", "prompt_launch", "prompt_cancel")):
                return
            browsers = payload.get("browsers", [])
            message = payload.get("message") or "Choose browser before startup:"
            self._prompt_browsers = [entry for entry in browsers if isinstance(entry, BrowserEntry)]
            populate_browsers(self, "prompt_combo", self._prompt_browsers)
            prompt_label = self._controls.get("prompt_label")
            if prompt_label:
                set_text(prompt_label, str(message))
            status_handle = self._controls.get("status")
            if status_handle:
                set_text(status_handle, "Starting")
            self._apply_view("prompt")
        elif kind == "ready":
            if not self._ensure_controls(("status", "ready_info")):
                return
            info = payload.get("info")
            if isinstance(info, ReadyInfo):
                self._ready_info = info
                self._status = "Ready"
                status_handle = self._controls.get("status")
                if status_handle:
                    set_text(status_handle, "Ready")
                ready_info = self._controls.get("ready_info")
                if ready_info:
                    set_text(ready_info, ready_text(info))
                self._apply_view("ready")
                progress = self._controls.get("progress")
                if progress:
                    send_message(progress, PBM_SETMARQUEE, 0, 0)
                    show_control(progress, False)
        elif kind == "error":
            message = str(payload.get("message") or "Error")
            self._status = "Error"
            self._error_message = message
            status_handle = self._controls.get("status")
            if status_handle:
                set_text(status_handle, message)
            self._apply_view("error")
            progress = self._controls.get("progress")
            if progress:
                send_message(progress, PBM_SETMARQUEE, 0, 0)

    def _enter_settings(self) -> None:
        if self._view_mode == "settings":
            return
        self._settings_prev_mode = self._resolve_current_view()
        self._prompt_mode = False
        set_settings_values(self, self._prefs, self._settings_browsers)
        self._apply_view("settings")
        settings_btn = self._controls.get("settings_btn")
        if settings_btn:
            show_control(settings_btn, False)

    def _exit_settings(self) -> None:
        if self._view_mode != "settings":
            return
        settings_btn = self._controls.get("settings_btn")
        if settings_btn:
            show_control(settings_btn, True)
        target = self._resolve_current_view()
        self._apply_view(target)

    def _save_settings(self) -> None:
        mode, browser_name, auto_open, auto_close = read_settings_values(self)
        browser = None
        if mode == "selected" and browser_name:
            for entry in self._settings_browsers:
                if entry.name.strip().lower() == browser_name.strip().lower():
                    browser = entry
                    break
            if browser is None:
                mode = "default"
        self._prefs = StartupPrefs(
            mode=mode,
            browser=browser,
            auto_open_on_ready=auto_open,
            auto_close_on_open=auto_close,
        )
        if self._pref_path:
            try:
                save_prefs(self._pref_path, self._prefs)
                self._log_line("SPD: settings saved")
            except Exception as exc:
                self._log_exc("SPD: settings save failed", exc)
        self._exit_settings()


def ready_text(info: ReadyInfo) -> str:
    return f"URL: {info.url or 'n/a'}"


__all__ = [
    "DialogConfig",
    "ReadyInfo",
    "UiAction",
    "Win32Dialog",
    "WindowHandle",
    "Win32Error",
]
