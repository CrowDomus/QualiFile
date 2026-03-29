"""Entry point for running the QualiFile backend in embedded portable mode."""

from __future__ import annotations

import json
import logging
import os
import platform
import socket
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Mapping

from werkzeug.serving import make_server

from app import create_app
from app.portable.startup_shared.constants import EVENT_PREFIX
from app.portable.startup_shared.diagnostics_text import build_diagnostics_text_from_paths
from app.portable.startup_shared.startup_log import StartupLogWriter
from app.shared.data_dir import resolve_paths


def _portable_root() -> Path:
    """Return the root folder that contains the embedded distribution."""

    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


def _resource_root() -> Path | None:
    """Return the PyInstaller extraction root when available."""

    raw = getattr(sys, "_MEIPASS", None)
    if raw:
        return Path(raw)
    return None


def _templates_root() -> Path:
    extracted = _resource_root()
    if extracted:
        return extracted / "templates"
    return Path(__file__).resolve().parents[2] / "app" / "templates"


def _static_root() -> Path:
    extracted = _resource_root()
    if extracted:
        return extracted / "static"
    return Path(__file__).resolve().parents[2] / "app" / "static"


def _parse_port(raw: str | None) -> tuple[int | None, str | None]:
    if raw is None:
        return None, None
    try:
        value = int(raw)
    except Exception:
        return None, "invalid"
    if value < 0 or value > 65535:
        return None, "out_of_range"
    return value, None


def _spd_enabled(env: Mapping[str, str]) -> bool:
    raw = env.get("QUALIFILE_SPD") or env.get("QUALIFILE_STARTUP_UI") or ""
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _emit_spd_event(
    event_type: str,
    *,
    stage_id: str | None = None,
    message: str | None = None,
    data: dict[str, object] | None = None,
    env: Mapping[str, str] | None = None,
    printer: Callable[..., None] = print,
    ts_fn: Callable[[], str] = _now_iso,
) -> str | None:
    env_values = env or os.environ
    if not _spd_enabled(env_values):
        return None
    payload: dict[str, object] = {"type": event_type, "ts": ts_fn()}
    if stage_id is not None:
        payload["id"] = stage_id
    if message is not None:
        payload["message"] = message
    if data:
        payload["data"] = data
    line = f"{EVENT_PREFIX}{json.dumps(payload, ensure_ascii=False)}"
    printer(line, flush=True)
    return line


def _maybe_spd_controller(
    env: Mapping[str, str],
    *,
    on_cancel: Callable[[], None] | None = None,
    log_error: Callable[[str], None] | None = None,
):
    if not _spd_enabled(env):
        return None
    try:
        from app.portable.startup_ui_win32.dialog import StartupDialogController
    except Exception:
        if log_error:
            log_error("SPD import failed.")
        return None
    try:
        controller = StartupDialogController(title="QualiFile", on_cancel=on_cancel, log_error=log_error)
        controller.show()
        return controller
    except Exception:
        if log_error:
            log_error("SPD initialization failed.")
        return None


def _update_spd_stage(controller, stage: str, message: str | None = None) -> None:
    if controller is None:
        return
    controller.update_stage(stage, message)


def _append_spd_log(controller, message: str) -> None:
    if controller is None:
        return
    controller.append_logs([message])


def _is_address_in_use(exc: OSError) -> bool:
    if getattr(exc, "errno", None) in {48, 98}:
        return True
    if getattr(exc, "winerror", None) in {10048, 10013}:
        return True
    return "address already in use" in str(exc).lower()


def _bind_exclusive_socket(host: str, port: int) -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        sock.bind((host, port))
        sock.listen(128)
        return sock.detach()
    except Exception:
        sock.close()
        raise


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


def _resolve_data_dir(root: Path) -> tuple[Path, str | None, bool]:
    override = os.environ.get("QUALIFILE_DATA_DIR")
    if override:
        data_dir = Path(override)
        if not _ensure_writable(data_dir):
            raise RuntimeError(f"QUALIFILE_DATA_DIR is not writable: {data_dir}")
        return data_dir, None, False

    data_dir = root / "data"
    if _ensure_writable(data_dir):
        return data_dir, None, False

    fallback = _fallback_data_dir()
    if not _ensure_writable(fallback):
        raise RuntimeError(f"Portable data directory is not writable and fallback failed: {fallback}")
    message = f"Portable data folder is not writable at {data_dir}. Using {fallback}."
    return fallback, message, True


def _select_log_path(portable_root: Path) -> Path | None:
    candidates: list[Path] = []
    override = os.environ.get("QUALIFILE_DATA_DIR")
    if override:
        candidates.append(Path(override) / "logs" / "embedded_backend_startup.log")
    else:
        candidates.append(portable_root / "data" / "logs" / "embedded_backend_startup.log")
    candidates.append(_fallback_data_dir() / "logs" / "embedded_backend_startup.log")
    temp_dir = os.environ.get("TEMP") or os.environ.get("TMP")
    if temp_dir:
        candidates.append(Path(temp_dir) / "qualifile_embedded_backend_startup.log")
    for candidate in candidates:
        try:
            candidate.parent.mkdir(parents=True, exist_ok=True)
            with candidate.open("a", encoding="utf-8") as handle:
                handle.write("")
            return candidate
        except Exception:
            continue
    return None


def _make_startup_logger(portable_root: Path):
    state = {"path": _select_log_path(portable_root), "writer": None}

    def log_line(message: str) -> None:
        if not state["writer"]:
            if not state["path"]:
                state["path"] = _select_log_path(portable_root)
            if not state["path"]:
                return
            state["writer"] = StartupLogWriter(state["path"])
        timestamp = datetime.now(timezone.utc).isoformat()
        line = f"[pid={os.getpid()}] {message}"
        state["writer"].append("startup", f"{timestamp} {line}")

    return log_line, state["path"]


def _prepare_environment(root: Path, host: str, port: int | None, data_dir: Path) -> None:
    """Populate environment variables used by the Flask factory."""
    os.environ.setdefault("QUALIFILE_PORTABLE", "1")
    os.environ.setdefault("QUALIFILE_MINIFIED", "1")
    os.environ.setdefault("QUALIFILE_OFFLINE_ASSETS", "1")
    os.environ.setdefault("QUALIFILE_PROFILE_MODE", "on")
    os.environ.setdefault("QUALIFILE_PROFILE_AVATAR", "on")
    os.environ.setdefault("QUALIFILE_HOST", host)
    if port is not None:
        os.environ["QUALIFILE_PORT"] = str(port)
    else:
        os.environ.pop("QUALIFILE_PORT", None)
    os.environ.setdefault("QUALIFILE_DATA_DIR", str(data_dir))
    paths = resolve_paths(data_dir, os.environ)
    os.environ.setdefault("QUALIFILE_PREVIEW_CACHE", str(paths.preview_cache_dir))
    os.environ.setdefault("QUALIFILE_OFFICE_CACHE", str(paths.office_cache_dir))
    os.environ.setdefault("QUALIFILE_LOG_FILE", str(paths.log_file))
    os.environ.setdefault("QUALIFILE_STATE", str(paths.notes_dir / "root_state.json"))
    os.environ.setdefault("QUALIFILE_INSTANCE_PATH", str(paths.data_dir))
    os.environ.setdefault("QUALIFILE_TEMPLATES_ROOT", str(_templates_root()))
    os.environ.setdefault("QUALIFILE_STATIC_ROOT", str(_static_root()))
    print(
        "Embedded portable mode enabled (offline assets: %s, data dir: %s)"
        % (os.environ.get("QUALIFILE_OFFLINE_ASSETS"), data_dir)
    )


def _create_server(host: str, app, explicit_port: int | None, preferred_port: int = 5000):
    fallback_from: int | None = None
    bind_strategy = "fd"
    used_fd = False
    if explicit_port is not None:
        if explicit_port == 0:
            bind_strategy = "direct"
            server = make_server(host, 0, app, threaded=True)
            return server, server.server_address[1], fallback_from, bind_strategy, used_fd
        try:
            fd = _bind_exclusive_socket(host, explicit_port)
        except OSError as exc:
            if _is_address_in_use(exc):
                raise RuntimeError(f"Port {explicit_port} is already in use.") from exc
            raise
        used_fd = True
        server = make_server(host, explicit_port, app, threaded=True, fd=fd)
        return server, server.server_address[1], fallback_from, bind_strategy, used_fd

    try:
        fd = _bind_exclusive_socket(host, preferred_port)
    except OSError as exc:
        if not _is_address_in_use(exc):
            raise
        fallback_from = preferred_port
        bind_strategy = "direct"
        server = make_server(host, 0, app, threaded=True)
        return server, server.server_address[1], fallback_from, bind_strategy, used_fd

    used_fd = True
    server = make_server(host, preferred_port, app, threaded=True, fd=fd)
    return server, server.server_address[1], fallback_from, bind_strategy, used_fd


def main() -> None:
    host = "127.0.0.1"
    portable_root = _portable_root()
    log_line, log_path = _make_startup_logger(portable_root)
    spd_env = os.environ
    spd_controller = _maybe_spd_controller(
        spd_env,
        on_cancel=lambda: os._exit(1),
        log_error=log_line,
    )
    _emit_spd_event("stage", stage_id="LAUNCHER_INITIALIZING", message="Launcher initializing", env=spd_env)
    _update_spd_stage(spd_controller, "LAUNCHER_INITIALIZING", "Launcher initializing")
    try:
        log_line("=== QualiFile embedded backend startup ===")
        log_line(f"log_path={log_path}")
        log_line(f"sys.executable={sys.executable}")
        log_line(f"sys.argv={sys.argv}")
        log_line(f"sys.version={sys.version}")
        log_line(f"platform={platform.platform()}")
        log_line(f"os.name={os.name}")
        log_line(f"cwd={os.getcwd()}")

        meipass_raw = getattr(sys, "_MEIPASS", None)
        meipass_exists = bool(meipass_raw and Path(meipass_raw).exists())
        meipass_length = len(meipass_raw) if isinstance(meipass_raw, str) else 0
        log_line(f"sys._MEIPASS={meipass_raw!r} exists={meipass_exists} length={meipass_length}")

        resource_root = _resource_root()
        templates_root = _templates_root()
        static_root = _static_root()
        log_line(f"portable_root={portable_root}")
        log_line(f"resource_root={resource_root}")
        log_line(f"templates_root={templates_root} exists={templates_root.exists()}")
        log_line(f"static_root={static_root} exists={static_root.exists()}")

        explicit_port_raw = os.environ.get("QUALIFILE_PORT")
        explicit_port, explicit_port_error = _parse_port(explicit_port_raw)
        if explicit_port_raw is not None and explicit_port is None:
            log_line(f"explicit_port_raw={explicit_port_raw!r} parsed=None rejected={explicit_port_error}")
        else:
            log_line(f"explicit_port_raw={explicit_port_raw!r} parsed={explicit_port}")

        data_dir_override = os.environ.get("QUALIFILE_DATA_DIR")
        if data_dir_override:
            log_line(f"QUALIFILE_DATA_DIR raw={data_dir_override}")

        _emit_spd_event("stage", stage_id="RESOLVING_DATA_DIR", message="Resolving data directory", env=spd_env)
        _update_spd_stage(spd_controller, "RESOLVING_DATA_DIR", "Resolving data directory")
        for key in sorted(os.environ):
            if key.startswith("QUALIFILE_"):
                log_line(f"env:{key}={os.environ.get(key)}")

        try:
            data_dir, data_message, used_fallback = _resolve_data_dir(portable_root)
        except Exception as exc:
            log_line(f"data_dir_error={type(exc).__name__} {exc}")
            log_line(traceback.format_exc())
            raise

        log_line(f"data_dir={data_dir} fallback_used={used_fallback}")
        if data_message:
            log_line(f"data_dir_message={data_message}")

        _emit_spd_event("stage", stage_id="LOADING_CONFIG", message="Loading configuration", env=spd_env)
        _update_spd_stage(spd_controller, "LOADING_CONFIG", "Loading configuration")
        _prepare_environment(portable_root, host, explicit_port, data_dir)
        for key in sorted(os.environ):
            if key.startswith("QUALIFILE_"):
                log_line(f"env_after:{key}={os.environ.get(key)}")

        app = create_app({"PORTABLE_ROOT": portable_root, "ALLOW_SHUTDOWN": True})
        _emit_spd_event("stage", stage_id="STARTING_SERVER", message="Starting server", env=spd_env)
        _update_spd_stage(spd_controller, "STARTING_SERVER", "Starting server")
        server, actual_port, fallback_from, bind_strategy, used_fd = _create_server(host, app, explicit_port)
        os.environ["QUALIFILE_PORT"] = str(actual_port)
        app.config["SERVER_PORT"] = actual_port
        app.config["SHUTDOWN_HANDLER"] = server.shutdown

        log_line(
            "bind_strategy=%s used_fd=%s preferred_port=%s fallback_from=%s actual_port=%s"
            % (bind_strategy, used_fd, 5000, fallback_from, actual_port)
        )

        logger = logging.getLogger("qualifile")
        if data_message:
            logger.warning(data_message)
            print(data_message, flush=True)
            _emit_spd_event("warn", message=data_message, env=spd_env)
            _append_spd_log(spd_controller, data_message)
        if fallback_from is not None and fallback_from != actual_port:
            message = f"Port {fallback_from} is in use; using {actual_port}."
            logger.warning(message)
            print(message, flush=True)
            print(f"QUALIFILE_PORT_FALLBACK={fallback_from}", flush=True)
            _emit_spd_event(
                "warn",
                message=message,
                data={"fallback_from": fallback_from, "actual_port": actual_port},
                env=spd_env,
            )
            _append_spd_log(spd_controller, message)

        url = f"http://{host}:{actual_port}"
        log_line(f"QUALIFILE_LISTENING_URL={url}")
        print(f"QUALIFILE_LISTENING_URL={url}", flush=True)
        print(f"QualiFile listening on {url}", flush=True)
        diagnostics_text = build_diagnostics_text_from_paths(
            data_dir,
            url=url,
            port=actual_port,
            variant="embedded",
            version=os.environ.get("QUALIFILE_VERSION"),
            build_id=os.environ.get("QUALIFILE_BUILD_ID"),
            ready=True,
        )
        _emit_spd_event(
            "ready",
            stage_id="READY",
            message="Ready",
            data={"url": url, "port": actual_port, "data_dir": str(data_dir)},
            env=spd_env,
        )
        _update_spd_stage(spd_controller, "READY", "Ready")
        if spd_controller:
            paths = resolve_paths(data_dir, os.environ)
            spd_controller.set_ready_info(
                url=url,
                port=actual_port,
                data_dir=str(paths.data_dir),
                logs_dir=str(paths.logs_dir),
                diagnostics_text=diagnostics_text,
            )

        try:
            server.serve_forever()
        finally:
            server.server_close()
    except Exception as exc:
        log_line(f"startup_exception={type(exc).__name__} {exc}")
        log_line(traceback.format_exc())
        raise


if __name__ == "__main__":
    main()
