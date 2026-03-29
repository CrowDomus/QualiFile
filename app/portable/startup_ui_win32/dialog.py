from __future__ import annotations

from dataclasses import dataclass
import os
import queue
import threading
from typing import Callable, Iterable

from app.portable.startup_shared.browsers_win import BrowserEntry, list_browsers
from app.portable.startup_shared.browser_pref import StartupPrefs

from .win32_controls import DialogConfig, ReadyInfo, UiAction, Win32Dialog
from .spd_log import append_line


@dataclass
class DialogState:
    stage: str = "LAUNCHER_INITIALIZING"
    message: str = "Starting..."
    status: str = "Starting"
    ready_info: ReadyInfo | None = None
    error_message: str | None = None


@dataclass(frozen=True)
class BrowserChoiceEvent:
    cancelled: bool
    mode: str | None = None
    browser_name: str | None = None
    remember: bool = False


class StartupDialogController:
    def __init__(
        self,
        title: str = "QualiFile",
        *,
        on_cancel: Callable[[], None] | None = None,
        log_error: Callable[[str], None] | None = None,
        log_dir: str | None = None,
        pref_path: str | None = None,
        prefs: StartupPrefs | None = None,
    ) -> None:
        self.state = DialogState()
        self._queue: "queue.Queue[UiAction]" = queue.Queue()
        self._user_events: "queue.Queue[BrowserChoiceEvent]" = queue.Queue()
        self._thread: threading.Thread | None = None
        self._window: Win32Dialog | None = None
        self._on_cancel = on_cancel
        self._log_error = log_error
        self._log_dir = log_dir
        self._title = title
        self._pref_path = pref_path
        self._prefs = prefs
        self._controller_id = hex(id(self))
        self._log_line(
            f"SPD: controller init pid={os.getpid()} tid={threading.get_ident()} "
            f"controller_id={self._controller_id} ppid={os.getppid()}"
        )

    def _log_line(self, line: str) -> None:
        if self._log_error is not None:
            self._log_error(line)
            return
        append_line(self._log_dir, line)

    def update_stage(self, stage: str, message: str | None = None) -> None:
        self.state.stage = stage
        if message is not None:
            self.state.message = message
        payload = {"stage": stage}
        if message is not None:
            payload["message"] = message
        self._queue.put(UiAction("stage", payload))

    def append_logs(self, lines: Iterable[str]) -> None:
        buffered = list(lines)
        if buffered:
            self._queue.put(UiAction("logs", {"lines": buffered}))

    def set_status(self, status: str) -> None:
        self.state.status = status
        self._queue.put(UiAction("status", {"status": status}))

    def begin_browser_prompt(
        self,
        *,
        browsers: list[BrowserEntry] | None = None,
        message: str | None = None,
    ) -> None:
        self._queue.put(
            UiAction(
                "prompt",
                {
                    "browsers": list_browsers() if browsers is None else browsers,
                    "message": message or "Choose browser before startup:",
                },
            )
        )

    def wait_for_browser_choice(self, timeout: float | None = None) -> BrowserChoiceEvent | None:
        try:
            if timeout is None:
                return self._user_events.get()
            return self._user_events.get(timeout=timeout)
        except queue.Empty:
            return None

    def set_ready_info(
        self,
        *,
        url: str | None,
        port: int | None,
        data_dir: str | None,
        logs_dir: str | None,
        diagnostics_text: str | None,
        browsers: list[BrowserEntry] | None = None,
    ) -> None:
        info = ReadyInfo(
            url=url,
            port=port,
            data_dir=data_dir,
            logs_dir=logs_dir,
            diagnostics_text=diagnostics_text,
            browsers=browsers if browsers is not None else list_browsers(),
        )
        self.state.ready_info = info
        self.state.status = "Ready"
        self._queue.put(UiAction("ready", {"info": info}))

    def set_preferences(self, prefs: StartupPrefs, browsers: list[BrowserEntry]) -> None:
        self._prefs = prefs
        self._queue.put(UiAction("prefs", {"prefs": prefs, "browsers": browsers}))

    def set_error(self, message: str) -> None:
        self.state.error_message = message
        self.state.status = "Error"
        self._queue.put(UiAction("error", {"message": message}))

    def show(self) -> bool:
        if self._thread and self._thread.is_alive():
            return True

        try:
            self._window = Win32Dialog(
                DialogConfig(title=self._title),
                queue_ref=self._queue,
                on_cancel=self._on_cancel,
                on_user_event=self._on_user_event,
                log_error=self._log_error,
                log_dir=self._log_dir,
                pref_path=self._pref_path,
                prefs=self._prefs,
            )
        except Exception as exc:
            if self._log_error:
                self._log_error(f"SPD init failed: {exc}")
            return False
        self._log_line(
            f"SPD: controller show pid={os.getpid()} tid={threading.get_ident()} "
            f"controller_id={self._controller_id} dialog_id={hex(id(self._window))}"
        )

        def _runner() -> None:
            try:
                if self._window:
                    self._window.run()
            except Exception as exc:
                if self._log_error:
                    self._log_error(f"SPD run failed: {exc}")

        self._thread = threading.Thread(target=_runner, daemon=True)
        self._thread.start()
        return True

    def close(self) -> None:
        if self._window:
            self._window.close()

    def drain_actions_for_test(self) -> list[UiAction]:
        actions: list[UiAction] = []
        while True:
            try:
                actions.append(self._queue.get_nowait())
            except queue.Empty:
                break
        return actions

    def push_user_event_for_test(self, payload: dict) -> None:
        self._on_user_event(payload)

    def _on_user_event(self, payload: dict) -> None:
        event = BrowserChoiceEvent(
            cancelled=bool(payload.get("cancelled")),
            mode=payload.get("mode") if isinstance(payload.get("mode"), str) else None,
            browser_name=payload.get("browser_name") if isinstance(payload.get("browser_name"), str) else None,
            remember=bool(payload.get("remember")),
        )
        self._user_events.put(event)


__all__ = ["BrowserChoiceEvent", "DialogState", "StartupDialogController"]
