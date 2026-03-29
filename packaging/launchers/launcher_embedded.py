"""Embedded portable launcher with first-run browser selection and SPD-safe logs."""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

from app.portable.startup_shared.browser_pref import (
    BrowserChoice,
    StartupPrefs,
    describe_choice_for_log,
    load_prefs,
    prefs_to_choice,
    save_prefs,
)
from app.portable.startup_shared.browsers_win import BrowserEntry, list_browsers, open_browser
from app.portable.startup_shared.constants import STAGES
from app.portable.startup_ui_win32.dialog import BrowserChoiceEvent, StartupDialogController
from app.portable.startup_shared.startup_log import StartupLogWriter
from app.shared.data_dir import resolve_paths


def _portable_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


def _parse_port(raw: str | None) -> int | None:
    if raw is None:
        return None
    try:
        value = int(raw)
    except Exception:
        return None
    if value < 0 or value > 65535:
        return None
    return value


def _explicit_port() -> int | None:
    return _parse_port(os.environ.get("QUALIFILE_PORT"))


def _fallback_data_dir() -> Path:
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        return Path(local_appdata) / "QualiFilePortable" / "data"
    return Path.home() / "AppData" / "Local" / "QualiFilePortable" / "data"


def _ensure_writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        marker = path / f".qualifile_write_test_{os.getpid()}"
        with marker.open("w", encoding="utf-8") as handle:
            handle.write("ok")
        marker.unlink(missing_ok=True)
        return True
    except Exception:
        return False


def _resolve_data_dir(root: Path) -> tuple[Path, str | None, str | None]:
    override = os.environ.get("QUALIFILE_DATA_DIR")
    if override:
        data_dir = Path(override)
        if not _ensure_writable(data_dir):
            return data_dir, None, f"QUALIFILE_DATA_DIR is not writable: {data_dir}"
        return data_dir, None, None

    data_dir = root / "data"
    if _ensure_writable(data_dir):
        return data_dir, None, None

    fallback = _fallback_data_dir()
    if _ensure_writable(fallback):
        message = f"Portable data folder is not writable at {data_dir}. Using {fallback}."
        return fallback, message, None
    return fallback, None, f"Portable data directory is not writable and fallback failed: {fallback}"


def _prepare_environment(root: Path, host: str, port: int | None, data_dir: Path) -> dict:
    env = os.environ.copy()
    env.pop("QUALIFILE_SPD", None)
    env.pop("QUALIFILE_STARTUP_UI", None)
    env.setdefault("QUALIFILE_PORTABLE", "1")
    env.setdefault("QUALIFILE_MINIFIED", "1")
    env.setdefault("QUALIFILE_OFFLINE_ASSETS", "1")
    env.setdefault("QUALIFILE_PROFILE_MODE", "on")
    env.setdefault("QUALIFILE_PROFILE_AVATAR", "on")
    env.setdefault("QUALIFILE_HOST", host)
    if port is not None:
        env["QUALIFILE_PORT"] = str(port)
    else:
        env.pop("QUALIFILE_PORT", None)
    env.setdefault("QUALIFILE_DATA_DIR", str(data_dir))
    paths = resolve_paths(data_dir, env)
    env.setdefault("QUALIFILE_PREVIEW_CACHE", str(paths.preview_cache_dir))
    env.setdefault("QUALIFILE_OFFICE_CACHE", str(paths.office_cache_dir))
    env.setdefault("QUALIFILE_LOG_FILE", str(paths.log_file))
    env.setdefault("QUALIFILE_STATE", str(paths.notes_dir / "root_state.json"))
    env.setdefault("QUALIFILE_INSTANCE_PATH", str(paths.data_dir))
    return env


def _find_backend_command(root: Path) -> list[str]:
    candidates = [
        root / "qualifile_server.exe",
        root / "qualifile_server_embedded_onefile.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return [str(candidate)]
    script = root / "packaging" / "launchers" / "portable_server_embedded.py"
    if script.exists():
        return [sys.executable, str(script)]
    raise FileNotFoundError("Could not find the embedded backend server executable.")


def _wait_for_server(
    proc: subprocess.Popen,
    url: str,
    timeout: float = 60.0,
    *,
    cancel_event: threading.Event | None = None,
) -> bool:
    deadline = time.time() + timeout
    status_url = f"{url.rstrip('/')}/api/status"
    while time.time() < deadline:
        if cancel_event is not None and cancel_event.is_set():
            return False
        if proc.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(status_url, timeout=1.5) as response:
                if response.status == 200:
                    return True
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.35)
    return False


MB_ICONERROR = 0x00000010
MB_ICONINFORMATION = 0x00000040


def _alert(message: str, title: str = "QualiFile", flags: int = MB_ICONERROR) -> None:
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, message, title, flags)
    except Exception:
        pass


def _alert_async(message: str, title: str = "QualiFile", flags: int = MB_ICONERROR) -> None:
    threading.Thread(target=_alert, args=(message, title, flags), daemon=True).start()


def _start_output_reader(
    proc: subprocess.Popen,
    state: dict,
    ready_event: threading.Event,
    backend_log_path: Path,
    startup_log: StartupLogWriter,
) -> None:
    def _reader() -> None:
        handle = None
        try:
            backend_log_path.parent.mkdir(parents=True, exist_ok=True)
            handle = backend_log_path.open("a", encoding="utf-8")
        except Exception:
            handle = None
        try:
            if proc.stdout is None:
                return
            for raw in proc.stdout:
                line = raw.rstrip()
                startup_log.append("backend_stdout", line)
                if handle:
                    handle.write(line + "\n")
                    handle.flush()
                if line.startswith("QUALIFILE_LISTENING_URL="):
                    url = line.split("=", 1)[1].strip()
                    if url:
                        state["listening_url"] = url
                        ready_event.set()
                elif line.startswith("QUALIFILE_PORT_FALLBACK="):
                    value = line.split("=", 1)[1].strip()
                    try:
                        state["fallback_port"] = int(value)
                    except Exception:
                        pass
        finally:
            if handle:
                handle.close()

    threading.Thread(target=_reader, daemon=True).start()


def _choice_from_event(event: BrowserChoiceEvent, browsers: list[BrowserEntry]) -> BrowserChoice:
    if event.mode == "selected" and event.browser_name:
        for entry in browsers:
            if entry.name.strip().lower() == event.browser_name.strip().lower():
                return BrowserChoice(mode="selected", browser=entry)
    return BrowserChoice(mode="default", browser=None)


def _spd_stage(
    controller: StartupDialogController | None,
    startup_log: StartupLogWriter,
    stage: str,
    message: str,
) -> None:
    if controller:
        controller.update_stage(stage, message)
    startup_log.append("launcher", f"spd_stage={stage}")


def _select_browser_choice(
    *,
    startup_log: StartupLogWriter,
    pref_path: Path,
    browsers: list[BrowserEntry],
    controller: StartupDialogController | None,
) -> tuple[StartupPrefs | None, bool]:
    pref_exists = pref_path.exists()
    startup_log.append("launcher", f"browser_pref_exists={pref_exists}")
    startup_log.append("launcher", f"browser_pref={'present' if pref_exists else 'absent'}")
    prefs = load_prefs(pref_path, browsers)
    if prefs is not None:
        startup_log.append("launcher", f"browser_prompt_shown=False browser_mode={describe_choice_for_log(prefs.mode, prefs.browser)}")
        startup_log.append("launcher", f"browser_choice={describe_choice_for_log(prefs.mode, prefs.browser)}")
        if controller:
            controller.set_preferences(prefs, browsers)
        return prefs, False
    if pref_exists:
        startup_log.append("launcher", "browser_pref_invalid=True fallback=prompt")
        startup_log.append("launcher", "browser_pref=invalid")

    if controller is None:
        startup_log.append("launcher", "browser_prompt_unavailable=True fallback=default")
        prefs = StartupPrefs(mode="default", browser=None, auto_open_on_ready=False, auto_close_on_open=True)
        return prefs, False
    controller.set_preferences(
        StartupPrefs(mode="default", browser=None, auto_open_on_ready=False, auto_close_on_open=True),
        browsers,
    )
    controller.begin_browser_prompt(browsers=browsers, message="Choose browser and click Start to launch QualiFile.")
    event = controller.wait_for_browser_choice(timeout=300.0)
    if event is None or event.cancelled:
        startup_log.append("launcher", "browser_prompt_shown=True browser_prompt_cancelled=True")
        return None, True

    selected = _choice_from_event(event, browsers)
    if event.mode == "selected" and selected.mode != "selected":
        startup_log.append("launcher", "browser_choice_validation_failed=True fallback=default")
    prefs = StartupPrefs(
        mode=selected.mode,
        browser=selected.browser,
        auto_open_on_ready=False,
        auto_close_on_open=True,
    )
    startup_log.append(
        "launcher",
        f"browser_prompt_shown=True browser_mode={describe_choice_for_log(prefs.mode, prefs.browser)}",
    )
    startup_log.append("launcher", f"browser_choice={describe_choice_for_log(prefs.mode, prefs.browser)}")
    if event.remember:
        try:
            save_prefs(pref_path, prefs)
        except Exception as exc:
            startup_log.append("launcher", f"browser_pref_save_failed={type(exc).__name__}")
    if controller:
        controller.set_preferences(prefs, browsers)
    return prefs, False


def _open_browser_choice(url: str, choice: BrowserChoice, startup_log: StartupLogWriter) -> None:
    if choice.mode == "selected" and choice.browser is not None:
        try:
            launched = open_browser(url, choice.browser)
            if launched is not None:
                startup_log.append("launcher", f"browser_open_mode=selected browser={choice.browser.name}")
                startup_log.append("launcher", "open_app: selected_mode=selected result=ok")
                return
            startup_log.append("launcher", "browser_open_selected_failed=True fallback=default")
            startup_log.append("launcher", "open_app: selected_mode=selected result=fallback_default")
        except Exception:
            startup_log.append("launcher", "browser_open_selected_exception=True fallback=default")
            startup_log.append("launcher", "open_app: selected_mode=selected result=fallback_default")
    webbrowser.open(url)
    startup_log.append("launcher", "browser_open_mode=default")
    startup_log.append("launcher", "open_app: selected_mode=default result=ok")


def _port_from_url(url: str | None) -> int | None:
    if not url:
        return None
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return None
    if parsed.port is not None:
        return parsed.port
    return None


def main() -> None:
    portable_root = _portable_root()
    host = "127.0.0.1"
    explicit_port = _explicit_port()

    data_dir, data_message, data_error = _resolve_data_dir(portable_root)
    paths = resolve_paths(data_dir, os.environ)
    startup_log = StartupLogWriter(paths.logs_dir / "launcher_startup.log")
    startup_log.append("launcher", "startup_begin")
    startup_log.append("launcher", f"portable_root={portable_root}")
    startup_log.append("launcher", f"data_dir={data_dir}")
    startup_log.append("launcher", f"explicit_port={explicit_port}")

    pref_path = paths.internal_dir / "startup_browser_choice.json"
    cancel_event = threading.Event()
    proc_holder: dict[str, subprocess.Popen | None] = {"proc": None}

    def _on_cancel() -> None:
        startup_log.append("launcher", "startup_cancel_requested=True")
        cancel_event.set()
        proc = proc_holder.get("proc")
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass

    controller: StartupDialogController | None = StartupDialogController(
        title="QualiFile",
        on_cancel=_on_cancel,
        log_error=lambda msg: startup_log.append("spd", msg),
        log_dir=str(paths.logs_dir),
        pref_path=str(pref_path),
    )
    if not controller.show():
        controller = None
        startup_log.append("launcher", "spd_unavailable=True fallback=headless")
    _spd_stage(controller, startup_log, STAGES[0], "Initializing launcher")
    _spd_stage(controller, startup_log, "RESOLVING_DATA_DIR", "Resolving data directory")

    if data_error:
        startup_log.append("launcher", f"data_dir_error={data_error}")
        if controller:
            controller.set_error(data_error)
        _alert(data_error, title="QualiFile error")
        sys.exit(1)
    if data_message:
        startup_log.append("launcher", data_message)
        _alert_async(
            f"{data_message}\n\nTo keep data portable, move QualiFile to a writable folder or set QUALIFILE_DATA_DIR.",
            title="QualiFile data folder",
        )

    _spd_stage(controller, startup_log, "PREPARING_STORAGE", "Preparing local storage")
    browsers = list_browsers()
    prefs, cancelled = _select_browser_choice(
        startup_log=startup_log,
        pref_path=pref_path,
        browsers=browsers,
        controller=controller,
    )
    if cancelled:
        startup_log.append("launcher", "startup_aborted_by_user=True")
        if controller:
            controller.close()
        sys.exit(0)
    if cancel_event.is_set():
        startup_log.append("launcher", "startup_cancelled=True")
        if controller:
            controller.close()
        sys.exit(0)
    if prefs is None:
        prefs = StartupPrefs(mode="default", browser=None, auto_open_on_ready=False, auto_close_on_open=True)
        startup_log.append("launcher", "browser_choice_missing=True fallback=default")
    choice = prefs_to_choice(prefs)

    _spd_stage(controller, startup_log, "LOADING_CONFIG", "Preparing environment")
    env = _prepare_environment(portable_root, host, explicit_port, data_dir)
    try:
        command = _find_backend_command(portable_root)
    except FileNotFoundError as exc:
        startup_log.append("launcher", f"backend_command_error={exc}")
        if controller:
            controller.set_error(str(exc))
        _alert(str(exc))
        sys.exit(1)

    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        _spd_stage(controller, startup_log, "STARTING_BACKEND", "Starting backend process")
        proc = subprocess.Popen(
            command,
            env=env,
            cwd=str(portable_root),
            creationflags=creation_flags,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        proc_holder["proc"] = proc
    except Exception as exc:  # pragma: no cover - user environment dependent
        startup_log.append("launcher", f"backend_start_error={type(exc).__name__}")
        if controller:
            controller.set_error(f"Failed to start backend: {exc}")
        _alert(f"Failed to start QualiFile backend: {exc}")
        sys.exit(1)

    state: dict[str, object] = {"listening_url": None, "fallback_port": None}
    ready_event = threading.Event()
    backend_log = paths.logs_dir / "portable_backend.log"
    _start_output_reader(proc, state, ready_event, backend_log, startup_log)
    _spd_stage(controller, startup_log, "STARTING_SERVER", "Starting local server")

    _spd_stage(controller, startup_log, "WAITING_READINESS", "Waiting for readiness")
    deadline = time.time() + 60.0
    while time.time() < deadline and not ready_event.is_set():
        if cancel_event.is_set():
            break
        ready_event.wait(timeout=0.2)
    if cancel_event.is_set():
        startup_log.append("launcher", "startup_cancelled=True")
        if proc.poll() is None:
            proc.terminate()
        if controller:
            controller.close()
        sys.exit(0)
    base_url = state.get("listening_url") if isinstance(state.get("listening_url"), str) else None
    if not base_url:
        if explicit_port and explicit_port > 0:
            base_url = f"http://{host}:{explicit_port}"
        elif explicit_port is None:
            base_url = f"http://{host}:5000"

    if base_url and _wait_for_server(proc, base_url, cancel_event=cancel_event):
        fallback_port = state.get("fallback_port")
        if fallback_port and isinstance(fallback_port, int):
            startup_log.append("launcher", f"port_fallback={fallback_port}")
            _alert_async(
                f"Port {fallback_port} is in use. QualiFile started on {base_url}.",
                title="QualiFile port in use",
                flags=MB_ICONINFORMATION,
            )
        if controller:
            controller.set_ready_info(
                url=base_url,
                port=_port_from_url(base_url) or (fallback_port if isinstance(fallback_port, int) else None) or explicit_port,
                data_dir=str(paths.data_dir),
                logs_dir=str(paths.logs_dir),
                diagnostics_text=None,
                browsers=browsers,
            )
            _spd_stage(controller, startup_log, "READY", "Ready")
        if prefs.auto_open_on_ready:
            _open_browser_choice(base_url, choice, startup_log)
            if prefs.auto_close_on_open and controller:
                controller.close()
        proc.wait()
        sys.exit(proc.returncode or 0)

    if cancel_event.is_set():
        startup_log.append("launcher", "startup_cancelled=True")
        if proc.poll() is None:
            proc.terminate()
        if controller:
            controller.close()
        sys.exit(0)

    proc.terminate()
    startup_log.append("launcher", "startup_failure=backend_not_ready")
    if controller:
        controller.set_error("QualiFile could not start. Please retry or check the logs.")
    _alert(
        "QualiFile could not start. Please retry or check the logs in the data folder.",
        title="QualiFile error",
    )
    sys.exit(1)


if __name__ == "__main__":
    main()
