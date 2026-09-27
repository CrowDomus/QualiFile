"""One bounded, thread-affine Office session for accelerated previews."""

from __future__ import annotations

import atexit
import contextlib
import queue
import shlex
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import office_preview as office

try:  # Windows-only ownership and crash cleanup, no additional dependency.
    import win32job
    from win32com.client import GetObject
except ImportError:  # pragma: no cover - platform dependent
    win32job = None
    GetObject = None


class _OwnedProcess:
    """Hold an exact process handle, never reopen a potentially recycled PID."""

    def __init__(self, application, kind, baseline):
        api, process, con = office.win32api, office.win32process, office.win32con
        if kind == "powerpoint":
            # Some PowerPoint versions expose no HWND. Accept only a single new
            # automation server from this installation, never a preexisting PID.
            expected_path = Path(application.Path) / "POWERPNT.EXE"
            candidates = []
            for candidate in GetObject("winmgmts:").ExecQuery(
                "SELECT ProcessId, CommandLine, ExecutablePath FROM Win32_Process WHERE Name='POWERPNT.EXE'"
            ):
                arguments = shlex.split(str(candidate.CommandLine or ""), posix=False)
                if (
                    int(candidate.ProcessId) not in baseline
                    and str(candidate.ExecutablePath or "").casefold() == str(expected_path).casefold()
                    and "/automation" in [arg.casefold() for arg in arguments]
                    and "-embedding" in [arg.casefold() for arg in arguments]
                ):
                    candidates.append(int(candidate.ProcessId))
            if len(candidates) != 1:
                raise office.OfficePreviewError("Unable to identify a separate PowerPoint preview process.")
            pid = candidates[0]
        elif kind == "word":
            # Word exposes HWND on a window, not on Application. A private,
            # unsaved blank document gives us that identity before opening input.
            previous_security = application.AutomationSecurity
            application.AutomationSecurity = 3
            try:
                document = application.Documents.Add(Visible=False)
                try:
                    hwnd = int(document.Windows.Item(1).Hwnd)
                    _, pid = process.GetWindowThreadProcessId(hwnd)
                finally:
                    document.Close(False)
            finally:
                application.AutomationSecurity = previous_security
        else:
            window = application.Hwnd
            hwnd = int(window() if callable(window) else window)
            _, pid = process.GetWindowThreadProcessId(hwnd)
        if not pid or pid in baseline:
            raise office.OfficePreviewError(
                "Office did not create a separate preview process. Open the file externally."
            )
        self.handle = api.OpenProcess(
            con.PROCESS_QUERY_INFORMATION | con.PROCESS_VM_READ | con.PROCESS_TERMINATE
            | con.PROCESS_SET_QUOTA | con.SYNCHRONIZE, False, pid
        )
        self.job = None
        self.lock = threading.Lock()
        verified = False
        try:
            expected = {"word": "winword.exe", "excel": "excel.exe", "powerpoint": "powerpnt.exe"}[kind]
            executable = process.GetModuleFileNameEx(self.handle, 0)
            if Path(executable).name.casefold() != expected:
                raise office.OfficePreviewError("Unable to verify the Office preview process.")
            verified = True
            self.job = win32job.CreateJobObject(None, "")
            limits = win32job.QueryInformationJobObject(self.job, win32job.JobObjectExtendedLimitInformation)
            limits["BasicLimitInformation"]["LimitFlags"] = win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            win32job.SetInformationJobObject(self.job, win32job.JobObjectExtendedLimitInformation, limits)
            win32job.AssignProcessToJobObject(self.job, self.handle)
        except Exception:
            # Identity was checked before assigning the process to our job.
            if verified:
                with contextlib.suppress(Exception):
                    api.TerminateProcess(self.handle, 1)
            if self.job is not None:
                api.CloseHandle(self.job)
            api.CloseHandle(self.handle)
            raise

    def terminate(self):
        with self.lock:
            if self.handle is not None:
                with contextlib.suppress(Exception):
                    office.win32api.TerminateProcess(self.handle, 1)

    def close(self):
        with self.lock:
            if self.job is not None:
                office.win32api.CloseHandle(self.job)
                self.job = None
            if self.handle is not None:
                office.win32api.CloseHandle(self.handle)
                self.handle = None


@dataclass
class _Request:
    renderer: object
    kind: str
    source: Path
    destination: Path
    cancel: threading.Event | None
    done: threading.Event = field(default_factory=threading.Event)
    error: Exception | None = None


class OfficeSession:
    """All COM calls live on this worker's STA, including document and app close."""

    def __init__(self, idle_seconds=120.0, conversion_seconds=120.0):
        self.idle_seconds = idle_seconds
        self.conversion_seconds = conversion_seconds
        self.requests = queue.Queue(maxsize=1)
        self.submission = threading.Lock()
        self.stopping = threading.Event()
        self.process_lock = threading.Lock()
        self.process = None
        self.application = None
        self.kind = None
        self.thread = threading.Thread(target=self._run, name="qualifile-office-preview", daemon=True)
        self.thread.start()

    def convert(self, renderer, kind, source, destination, cancel):
        deadline = time.monotonic() + self.conversion_seconds
        while not self.submission.acquire(timeout=0.05):
            office.OfficePreviewRenderer._check_cancel(cancel)
            if time.monotonic() >= deadline:
                raise office.OfficePreviewError("Office preview queue timed out.")
        try:
            office.OfficePreviewRenderer._check_cancel(cancel)
            if self.stopping.is_set() or not self.thread.is_alive():
                raise office.OfficePreviewError("Office preview is still shutting down. Try again shortly.")
            request = _Request(renderer, kind, source, destination, cancel)
            self.requests.put_nowait(request)
            while not request.done.wait(0.05):
                if cancel and cancel.is_set():
                    self.close()
                    raise office.OfficePreviewCancelledError("Office preview was cancelled.")
                if time.monotonic() >= deadline:
                    self.close()
                    raise office.OfficePreviewError("Office preview conversion timed out.")
                if self.stopping.is_set():
                    raise office.OfficePreviewCancelledError("Office preview was stopped.")
            if request.error:
                raise request.error
            office.OfficePreviewRenderer._check_cancel(cancel)
        finally:
            self.submission.release()

    def _open(self, kind):
        if self.application is not None and self.kind == kind:
            return self.application
        self._close_application()
        if win32job is None or office.win32process is None:
            raise office.OfficePreviewUnavailableError("Accelerated Office previews require Windows process controls.")
        baseline = set(office.win32process.EnumProcesses())
        application = office.DispatchEx({
            "word": "Word.Application", "excel": "Excel.Application", "powerpoint": "PowerPoint.Application"
        }[kind])
        # Do not Quit an application whose ownership has not been established.
        owned = _OwnedProcess(application, kind, baseline)
        with self.process_lock:
            self.process = owned
            if self.stopping.is_set():
                owned.terminate()
                raise office.OfficePreviewCancelledError("Office preview was stopped.")
        self.application, self.kind = application, kind
        return application

    def _close_application(self):
        application, self.application = self.application, None
        self.kind = None
        try:
            if application is not None:
                # A watchdog bounds Quit, which itself can block on Office UI.
                with self.process_lock:
                    process = self.process
                watchdog = threading.Timer(2.0, process.terminate) if process else None
                if watchdog:
                    watchdog.daemon = True
                    watchdog.start()
                try:
                    with contextlib.suppress(Exception):
                        application.Quit()
                finally:
                    if watchdog:
                        watchdog.cancel()
        finally:
            with self.process_lock:
                if self.process:
                    self.process.close()
                    self.process = None

    def _run(self):
        initialized = False
        try:
            office.pythoncom.CoInitialize()
            initialized = True
            while not self.stopping.is_set():
                try:
                    request = self.requests.get(timeout=self.idle_seconds if self.application else None)
                except queue.Empty:
                    self._close_application()
                    continue
                if request is None:
                    break
                try:
                    office.OfficePreviewRenderer._check_cancel(request.cancel)
                    application = self._open(request.kind)
                    if self.stopping.is_set():
                        raise office.OfficePreviewCancelledError("Office preview was stopped.")
                    converter = getattr(request.renderer, f"_convert_{request.kind}")
                    reusable = converter(request.source, request.destination, request.cancel, application=application)
                    if reusable is False:
                        self._close_application()
                except Exception as exc:
                    request.error = exc
                    self._close_application()
                finally:
                    request.done.set()
        finally:
            self.stopping.set()
            self._close_application()
            if initialized:
                office.pythoncom.CoUninitialize()

    def close(self):
        self.stopping.set()
        with contextlib.suppress(queue.Full):
            self.requests.put_nowait(None)
        self.thread.join(timeout=0.5)
        if self.thread.is_alive():
            with self.process_lock:
                if self.process:
                    self.process.terminate()
            self.thread.join(timeout=1.5)


_session = None
_session_lock = threading.Lock()


def convert_with_session(renderer, kind, source, destination, cancel):
    global _session
    with _session_lock:
        if _session is None or not _session.thread.is_alive():
            _session = OfficeSession()
        session = _session
    session.convert(renderer, kind, source, destination, cancel)


def close_office_session():
    with _session_lock:
        session = _session
    if session is not None:
        session.close()


atexit.register(close_office_session)
