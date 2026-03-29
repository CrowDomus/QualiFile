"""Utilities for rendering Microsoft Office documents into previewable artifacts."""

from __future__ import annotations

import contextlib
import hashlib
import logging
import os
import platform
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional

from PyPDF2 import PdfReader

logger = logging.getLogger(__name__)

OFFICE_SUFFIX_MAP: Dict[str, str] = {
    ".doc": "word",
    ".docx": "word",
    ".docm": "word",
    ".dot": "word",
    ".dotx": "word",
    ".dotm": "word",
    ".rtf": "word",
    ".odt": "word",
    ".xls": "excel",
    ".xlsx": "excel",
    ".xlsm": "excel",
    ".xlsb": "excel",
    ".xlt": "excel",
    ".xltx": "excel",
    ".xltm": "excel",
    ".csv": "excel",
    ".ods": "excel",
    ".ppt": "powerpoint",
    ".pptx": "powerpoint",
    ".pptm": "powerpoint",
    ".pps": "powerpoint",
    ".ppsx": "powerpoint",
    ".odp": "powerpoint",
}


class OfficePreviewError(RuntimeError):
    """Raised when an Office document cannot be converted."""


class OfficePreviewCancelledError(OfficePreviewError):
    """Raised when a preview conversion was cancelled."""


class OfficePreviewUnavailableError(OfficePreviewError):
    """Raised when previews are not available on this platform."""


@dataclass(slots=True)
class PreviewArtifact:
    """Metadata about a generated preview artifact."""

    token: str
    path: Path
    mime: str = "application/pdf"
    pages: Optional[int] = None


try:  # pragma: no cover - platform specific
    import pythoncom  # type: ignore
    from win32com.client import DispatchEx  # type: ignore
except ImportError:  # pragma: no cover - handled gracefully
    pythoncom = None  # type: ignore
    DispatchEx = None  # type: ignore

try:  # pragma: no cover - optional UI suppression helpers
    import win32api  # type: ignore
    import win32con  # type: ignore
    import win32gui  # type: ignore
    import win32process  # type: ignore
except ImportError:  # pragma: no cover - optional dependency
    win32api = None  # type: ignore
    win32con = None  # type: ignore
    win32gui = None  # type: ignore
    win32process = None  # type: ignore


class _CancellationRegistry:
    """Track active conversion tokens and provide signalling for cancellation."""

    def __init__(self) -> None:
        self._tokens: Dict[str, threading.Event] = {}
        self._lock = threading.Lock()

    def register(self, token: str) -> threading.Event:
        with self._lock:
            event = self._tokens.get(token)
            if event is None:
                event = threading.Event()
                self._tokens[token] = event
            return event

    def cancel(self, token: str) -> bool:
        with self._lock:
            event = self._tokens.get(token)
        if event is None:
            return False
        event.set()
        return True

    def clear(self, token: str) -> None:
        with self._lock:
            self._tokens.pop(token, None)


_CANCELLATIONS = _CancellationRegistry()


def _load_conversion_concurrency() -> int:
    raw = os.getenv("QUALIFILE_OFFICE_CONCURRENCY", "1").strip()
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        return 1
    return max(1, parsed)


_OFFICE_CONVERSION_LIMIT = _load_conversion_concurrency()
_CONVERSION_SEMAPHORE = threading.BoundedSemaphore(_OFFICE_CONVERSION_LIMIT)


class OfficePreviewRenderer:
    """Convert Microsoft Office documents into cached PDF previews."""

    # Tunable timing parameters for produced file stabilization.
    _FILE_APPEAR_TIMEOUT: float = 8.0
    _FILE_STABLE_SECONDS: float = 0.25

    def __init__(self, cache_dir: Path, quality: str = "standard") -> None:
        self.cache_dir = cache_dir
        self.quality = self._normalize_quality(quality)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _normalize_quality(value: object) -> str:
        normalized = str(value or "").strip().lower()
        if normalized in {"fast", "standard"}:
            return normalized
        return "standard"

    @staticmethod
    def is_supported_document(path: Path) -> bool:
        return path.suffix.lower() in OFFICE_SUFFIX_MAP

    def prepare_preview(self, source: Path, cancel_token: str | None = None) -> PreviewArtifact:
        source = source.resolve()
        self._validate_source(source)
        self._ensure_available()

        cancel_event = _CANCELLATIONS.register(cancel_token) if cancel_token else None
        cache_file = self._cache_path_for(source)

        try:
            self._check_cancel(cancel_event)
            if self._is_cache_fresh(cache_file):
                logger.debug("Using cached Office preview artifact quality=%s", self.quality)
            else:
                logger.info("Generating Office preview artifact quality=%s", self.quality)
                self._render_with_lock(source, cache_file, cancel_event=cancel_event)

            pages = self._count_pages(cache_file)
            return PreviewArtifact(token=cache_file.name, path=cache_file, pages=pages)
        finally:
            if cancel_token:
                _CANCELLATIONS.clear(cancel_token)

    def _cache_path_for(self, source: Path) -> Path:
        stat = source.stat()
        key = f"{source.resolve()}|{stat.st_size}|{stat.st_mtime_ns}|q={self.quality}".encode("utf-8", "ignore")
        digest = hashlib.sha256(key).hexdigest()
        return self.cache_dir / f"{digest}.pdf"

    def _render_with_lock(
        self,
        source: Path,
        destination: Path,
        cancel_event: threading.Event | None = None,
    ) -> None:
        """Render *source* while coordinating concurrent conversions via a lock file."""

        lock_path = destination.with_suffix(destination.suffix + ".lock")
        lock_acquired = False
        wait_deadline = time.time() + 15.0
        destination.parent.mkdir(parents=True, exist_ok=True)

        while not lock_acquired:
            self._check_cancel(cancel_event)
            lock_acquired = self._try_acquire_lock(lock_path)
            if lock_acquired:
                break
            if self._is_cache_fresh(destination):
                # Another worker produced the artifact while we waited.
                return
            if time.time() > wait_deadline:
                if self._lock_stale(lock_path):
                    logger.warning("Stale Office preview lock detected; removing it.")
                    self._release_lock(lock_path)
                    continue
                raise OfficePreviewError("Timed out waiting for another Office preview to finish.")
            time.sleep(0.2)

        conversion_slot_acquired = False
        try:
            self._acquire_conversion_slot(cancel_event)
            conversion_slot_acquired = True
            if self._is_cache_fresh(destination):
                return
            self._render_to_pdf(source, destination, cancel_event=cancel_event)
        finally:
            if conversion_slot_acquired:
                _CONVERSION_SEMAPHORE.release()
            if lock_acquired:
                self._release_lock(lock_path)

    @staticmethod
    def _acquire_conversion_slot(cancel_event: threading.Event | None) -> None:
        while True:
            OfficePreviewRenderer._check_cancel(cancel_event)
            if _CONVERSION_SEMAPHORE.acquire(timeout=0.1):
                return

    def _render_to_pdf(
        self,
        source: Path,
        destination: Path,
        cancel_event: threading.Event | None = None,
    ) -> None:
        kind = OFFICE_SUFFIX_MAP.get(source.suffix.lower())
        if not kind:
            raise OfficePreviewError("Unsupported Office document type.")
        temp_destination = destination.with_suffix(destination.suffix + ".tmp")
        with contextlib.suppress(FileNotFoundError):
            temp_destination.unlink()

        self._check_cancel(cancel_event)
        try:
            if kind == "word":
                self._convert_word(source, temp_destination, cancel_event=cancel_event)
            elif kind == "excel":
                self._convert_excel(source, temp_destination, cancel_event=cancel_event)
            elif kind == "powerpoint":
                self._convert_powerpoint(source, temp_destination, cancel_event=cancel_event)
            else:  # pragma: no cover - exhaustive guard
                raise OfficePreviewError("Unsupported Office application.")
        except FileNotFoundError:
            raise
        except OfficePreviewError:
            raise
        except Exception as exc:  # pragma: no cover - depends on Office installation
            raise OfficePreviewError(f"Office conversion failed: {exc}") from exc

        try:
            self._check_cancel(cancel_event)
            produced = self._resolve_produced_file(temp_destination, destination, cancel_event=cancel_event)
            if not produced:
                raise OfficePreviewError("Conversion did not produce a preview file.")

            # Re-check cancellation after the wait/resolve phase, before finalising.
            self._check_cancel(cancel_event)

            produced.replace(destination)
            logger.info("Office preview generated quality=%s", self.quality)
        except OfficePreviewCancelledError:
            with contextlib.suppress(FileNotFoundError):
                temp_destination.unlink()
            raise
        except Exception as exc:
            with contextlib.suppress(FileNotFoundError):
                temp_destination.unlink()
            raise OfficePreviewError(f"Unable to finalise preview file: {exc}") from exc
        else:
            with contextlib.suppress(FileNotFoundError):
                temp_destination.unlink()

    def _convert_word(
        self,
        source: Path,
        destination: Path,
        cancel_event: threading.Event | None = None,
    ) -> None:
        app_ref: dict[str, object | None] = {"app": None}

        def _work() -> None:
            pythoncom.CoInitialize()  # type: ignore[call-arg]
            document = None
            try:
                app = DispatchEx("Word.Application")
                app_ref["app"] = app
                self._set_bool(app, "Visible", False)
                self._set_bool(app, "DisplayAlerts", False)
                self._set_bool(app, "ScreenUpdating", False)
                self._set_attr(app, "AutomationSecurity", 3)  # msoAutomationSecurityForceDisable
                document = app.Documents.Open(str(source), ReadOnly=True, AddToRecentFiles=False)
                document.ExportAsFixedFormat(
                    OutputFileName=str(destination),
                    ExportFormat=17,
                    OpenAfterExport=False,
                    OptimizeFor=1 if self.quality == "fast" else 0,
                    Item=0,
                    IncludeDocProps=True,
                    KeepIRM=True,
                    CreateBookmarks=1,
                    DocStructureTags=self.quality != "fast",
                    BitmapMissingFonts=self.quality != "fast",
                    UseISO19005_1=False,
                )
            finally:
                if document is not None:
                    with contextlib.suppress(Exception):
                        document.Close(False)
                if app_ref["app"] is not None:
                    with contextlib.suppress(Exception):
                        app_ref["app"].Quit()  # type: ignore[attr-defined]
                with contextlib.suppress(Exception):
                    pythoncom.CoUninitialize()  # type: ignore[call-arg]

        self._execute_conversion(_work, cancel_event=cancel_event, app_ref=app_ref)

    def _convert_excel(
        self,
        source: Path,
        destination: Path,
        cancel_event: threading.Event | None = None,
    ) -> None:
        app_ref: dict[str, object | None] = {"app": None}

        def _work() -> None:
            pythoncom.CoInitialize()  # type: ignore[call-arg]
            workbook = None
            suppress_stop = threading.Event()
            pid: int | None = None
            try:
                app = DispatchEx("Excel.Application")
                app_ref["app"] = app

                # Resolve the Excel process id as robustly as possible, even if the app starts invisible.
                pid = self._get_app_pid(app)

                # Now configure the application for headless operation.
                self._set_bool(app, "Visible", False)
                self._set_bool(app, "DisplayAlerts", False)
                self._set_bool(app, "ScreenUpdating", False)
                self._set_bool(app, "EnableEvents", False)
                self._set_bool(app, "Interactive", False)
                self._set_bool(app, "AskToUpdateLinks", False)
                self._set_bool(app, "AlertBeforeOverwriting", False)
                self._set_bool(app, "DisplayStatusBar", False)
                self._set_bool(app, "ShowWindowsInTaskbar", False)
                self._set_attr(app, "DisplayFullScreen", 0)
                self._set_attr(app, "IgnoreRemoteRequests", 1)
                self._set_attr(app, "AutomationSecurity", 3)  # msoAutomationSecurityForceDisable

                workbook = app.Workbooks.Open(str(source), ReadOnly=True, AddToMru=False)
                suppress_thread = self._start_excel_suppression(pid, suppress_stop)
                try:
                    self._suppress_excel_windows(pid)
                    workbook.ExportAsFixedFormat(
                        0,  # xlTypePDF
                        str(destination),
                        Quality=1 if self.quality == "fast" else 0,
                        IncludeDocProperties=self.quality != "fast",
                        IgnorePrintAreas=False,
                        OpenAfterPublish=False,
                    )
                    self._suppress_excel_windows(pid)
                finally:
                    suppress_stop.set()
                    if suppress_thread:
                        suppress_thread.join(timeout=2)
            finally:
                if workbook is not None:
                    with contextlib.suppress(Exception):
                        workbook.Close(False)
                if app_ref["app"] is not None:
                    with contextlib.suppress(Exception):
                        app_ref["app"].Quit()  # type: ignore[attr-defined]
                with contextlib.suppress(Exception):
                    pythoncom.CoUninitialize()  # type: ignore[call-arg]

        self._execute_conversion(_work, cancel_event=cancel_event, app_ref=app_ref)

    def _convert_powerpoint(
        self,
        source: Path,
        destination: Path,
        cancel_event: threading.Event | None = None,
    ) -> None:
        app_ref: dict[str, object | None] = {"app": None}

        def _work() -> None:
            pythoncom.CoInitialize()  # type: ignore[call-arg]
            presentation = None
            try:
                app = DispatchEx("PowerPoint.Application")
                app_ref["app"] = app
                self._set_bool(app, "DisplayAlerts", False)
                self._set_bool(app, "Visible", False)
                presentation = app.Presentations.Open(str(source), WithWindow=False, ReadOnly=True)
                presentation.ExportAsFixedFormat(str(destination), 2, PrintRange=None)
            finally:
                if presentation is not None:
                    with contextlib.suppress(Exception):
                        presentation.Close()
                if app_ref["app"] is not None:
                    with contextlib.suppress(Exception):
                        app_ref["app"].Quit()  # type: ignore[attr-defined]
                with contextlib.suppress(Exception):
                    pythoncom.CoUninitialize()  # type: ignore[call-arg]

        self._execute_conversion(_work, cancel_event=cancel_event, app_ref=app_ref)

    @staticmethod
    def _set_bool(obj: object, name: str, value: bool) -> None:
        try:
            setattr(obj, name, value)
        except Exception:
            # Fallback silently if the Office COM interface rejects the flag.
            pass

    @staticmethod
    def _set_attr(obj: object, name: str, value: int) -> None:
        try:
            setattr(obj, name, value)
        except Exception:
            pass

    def _get_app_pid(self, app: object) -> int | None:
        """Resolve the process id for an Office application, with Excel-specific robustness.

        Excel can report an Hwnd of 0 when invisible; in that case we briefly toggle
        visibility to force window creation, read the handle, then restore visibility.
        """
        if win32process is None:
            return None

        hwnd = 0
        try:
            hwnd = int(getattr(app, "Hwnd", 0))
        except Exception:
            hwnd = 0

        if not hwnd:
            # Try to force a window handle to be created by toggling visibility.
            try:
                visible_before = bool(getattr(app, "Visible", False))
            except Exception:
                visible_before = False

            try:
                # Make it visible briefly to obtain a valid hwnd, then hide again.
                self._set_bool(app, "Visible", True)
                time.sleep(0.05)
                try:
                    hwnd = int(getattr(app, "Hwnd", 0))
                except Exception:
                    hwnd = 0
            finally:
                if not visible_before:
                    self._set_bool(app, "Visible", False)

        if not hwnd:
            logger.debug("Unable to resolve Excel window handle for PID lookup.")
            return None

        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            if not pid:
                logger.debug("Excel PID resolution returned 0 for hwnd %s", hwnd)
                return None
            return int(pid)
        except Exception:
            logger.debug("Failed to resolve PID from Excel hwnd %s", hwnd)
            return None

    def _suppress_excel_windows(self, pid: int | None) -> None:
        """Best-effort attempt to hide Excel UI (e.g., 'Publication...' dialog) for a given PID."""

        if pid is None or win32gui is None or win32con is None or win32process is None:
            return

        def _callback(window: int, _param: object) -> bool:
            try:
                _, window_pid = win32process.GetWindowThreadProcessId(window)
                if window_pid != pid:
                    return True
                if win32gui.IsWindowVisible(window):
                    win32gui.ShowWindow(window, win32con.SW_HIDE)
            except Exception:
                return True
            return True

        try:
            win32gui.EnumWindows(_callback, None)
        except Exception:
            return

    def _start_excel_suppression(self, pid: int | None, stop_event: threading.Event) -> threading.Thread | None:
        """Continuously hide Excel windows for the given process id while conversion is running."""

        if pid is None or win32gui is None or win32con is None or win32process is None:
            return None

        def _loop() -> None:
            while not stop_event.is_set():
                try:
                    self._suppress_excel_windows(pid)
                except Exception:
                    pass
                stop_event.wait(0.1)

        thread = threading.Thread(target=_loop, daemon=True)
        thread.start()
        return thread

    def _count_pages(self, path: Path) -> Optional[int]:
        try:
            with path.open("rb") as handle:
                reader = PdfReader(handle)
                return len(reader.pages)
        except Exception:
            logger.debug("Unable to count pages for Office preview artifact.")
            return None

    @staticmethod
    def _is_cache_fresh(cache_file: Path) -> bool:
        try:
            return cache_file.exists() and cache_file.stat().st_size > 0
        except FileNotFoundError:
            return False

    def _resolve_produced_file(
        self,
        temp_destination: Path,
        destination: Path,
        cancel_event: threading.Event | None = None,
    ) -> Path | None:
        """Locate the file produced by Office (handles Excel adding .pdf)."""

        candidates = [
            temp_destination,
            temp_destination.with_suffix(temp_destination.suffix + ".pdf"),
            destination.with_name(destination.name + ".tmp.pdf"),
        ]
        for candidate in candidates:
            if self._wait_for_file(
                candidate,
                cancel_event=cancel_event,
                timeout=self._FILE_APPEAR_TIMEOUT,
                interval=0.1,
                stable_seconds=self._FILE_STABLE_SECONDS,
            ):
                return candidate
        return None

    def _wait_for_file(
        self,
        path: Path,
        cancel_event: threading.Event | None = None,
        timeout: float = 5.0,
        interval: float = 0.1,
        stable_seconds: float = 0.25,
    ) -> bool:
        """Wait for a file to appear, become non-empty, and have a stable size.

        The file is considered ready when:
        - It exists.
        - It has size > 0.
        - Its size hasn't changed for at least `stable_seconds`.
        """

        deadline = time.time() + max(0.0, timeout)
        last_size: int | None = None
        last_change: float = time.time()

        # If stable_seconds <= 0, treat any non-zero size as ready.
        require_stable = stable_seconds > 0

        while time.time() < deadline:
            self._check_cancel(cancel_event)
            try:
                if path.exists():
                    try:
                        size = path.stat().st_size
                    except FileNotFoundError:
                        size = 0

                    now = time.time()
                    if size > 0:
                        if last_size is None or size != last_size:
                            last_size = size
                            last_change = now
                        elif not require_stable or (now - last_change) >= stable_seconds:
                            return True
                # If it doesn't exist yet, we just keep waiting until timeout.
            except FileNotFoundError:
                pass

            time.sleep(max(0.01, interval))

        # Final non-empty + stability check before giving up.
        try:
            if path.exists():
                size = path.stat().st_size
                if size > 0:
                    if not require_stable:
                        return True
                    # If we have no history, treat current size as stable enough at timeout.
                    if last_size is None or size == last_size:
                        return True
        except FileNotFoundError:
            return False

        return False

    @staticmethod
    def _try_acquire_lock(lock_path: Path) -> bool:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            return False
        except OSError as exc:
            logger.error("Unable to create Office preview lock: %s", exc)
            raise OfficePreviewError(f"Unable to create preview lock: {exc}") from exc
        os.close(fd)
        return True

    def _execute_conversion(
        self,
        work: callable,
        cancel_event: threading.Event | None = None,
        app_ref: dict | None = None,
    ) -> None:
        """Run COM work on a helper thread so cancellation can abort safely."""

        exc: Exception | None = None

        def _runner() -> None:
            nonlocal exc
            try:
                work()
            except Exception as err:  # pragma: no cover - depends on Office install
                exc = err

        thread = threading.Thread(target=_runner, daemon=True)
        thread.start()

        while thread.is_alive():
            if cancel_event and cancel_event.is_set():
                if app_ref and app_ref.get("app") is not None:
                    self._terminate_app_process(app_ref["app"])
                thread.join(timeout=2)
                raise OfficePreviewCancelledError("Office preview was cancelled.")
            time.sleep(0.1)

        if exc:
            raise exc

    def _terminate_app_process(self, app: object) -> None:
        if win32process is None or win32api is None or win32con is None:
            return
        try:
            hwnd = int(getattr(app, "Hwnd", 0))
        except Exception:
            hwnd = 0
        if not hwnd:
            return
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
        except Exception:
            return
        if not pid:
            return
        with contextlib.suppress(Exception):
            handle = win32api.OpenProcess(win32con.PROCESS_TERMINATE, False, pid)
            try:
                win32api.TerminateProcess(handle, 1)
            finally:
                win32api.CloseHandle(handle)

    @staticmethod
    def _release_lock(lock_path: Path) -> None:
        with contextlib.suppress(FileNotFoundError):
            lock_path.unlink()

    @staticmethod
    def _lock_stale(lock_path: Path, threshold_seconds: float = 300.0) -> bool:
        try:
            mtime = lock_path.stat().st_mtime
        except FileNotFoundError:
            return False
        return (time.time() - mtime) > threshold_seconds

    @staticmethod
    def _check_cancel(cancel_event: threading.Event | None) -> None:
        if cancel_event and cancel_event.is_set():
            raise OfficePreviewCancelledError("Office preview was cancelled.")

    def _validate_source(self, source: Path) -> None:
        if not source.exists():
            raise FileNotFoundError(f"File '{source}' does not exist.")
        if source.is_dir():
            raise OfficePreviewError(f"Path '{source}' is a directory, not a file.")
        if not self.is_supported_document(source):
            raise OfficePreviewError("Unsupported Office document type.")
        try:
            with source.open("rb"):
                pass
        except PermissionError as exc:
            raise OfficePreviewError(f"File is not readable: {exc}") from exc
        except OSError as exc:
            raise OfficePreviewError(f"Unable to access the file: {exc}") from exc

    @staticmethod
    def _ensure_available() -> None:
        if platform.system() != "Windows":
            raise OfficePreviewUnavailableError(
                "Office previews currently require Windows with Microsoft Office installed."
            )
        if DispatchEx is None or pythoncom is None:
            raise OfficePreviewUnavailableError(
                "pywin32 is not installed. Install pywin32 to enable Office previews."
            )


def register_preview_cancellation(token: str) -> threading.Event:
    """Expose cancellation registration for API handlers."""

    return _CANCELLATIONS.register(token)


def cancel_preview(token: str) -> bool:
    """Signal cancellation for a running preview conversion."""

    return _CANCELLATIONS.cancel(token)


def clear_preview_cancellation(token: str) -> None:
    """Remove a cancellation token after completion."""

    _CANCELLATIONS.clear(token)


__all__ = [
    "OfficePreviewRenderer",
    "PreviewArtifact",
    "OfficePreviewError",
    "OfficePreviewCancelledError",
    "OfficePreviewUnavailableError",
    "OFFICE_SUFFIX_MAP",
    "cancel_preview",
    "register_preview_cancellation",
    "clear_preview_cancellation",
]
