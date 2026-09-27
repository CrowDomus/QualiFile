"""Entry point for running the QualiFile backend in portable mode."""

from __future__ import annotations

import json
import logging
import os
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Mapping

from werkzeug.serving import make_server

from app import create_app
from app.portable.startup_shared.constants import EVENT_PREFIX
from app.portable.startup_shared.diagnostics_text import build_diagnostics_text_from_paths
from app.portable.startup_shared.startup_log import StartupLogWriter
from app.shared.data_dir import resolve_paths
from app.shared.http_logging import PrivacyRequestHandler


def _portable_root() -> Path:
    """Return the root folder that contains the portable distribution."""

    if getattr(sys, "frozen", False):
        # PyInstaller one-folder build: executable lives in qualifile_server/.
        return Path(sys.executable).resolve().parent.parent
    return Path(__file__).resolve().parents[2]


def _parse_port(raw: str | None) -> int | None:
    if raw is None:
        return None
    try:
        value = int(raw)
    except Exception:
        return None
    if value < 0:
        return None
    return value


def _explicit_port() -> int | None:
    return _parse_port(os.environ.get("QUALIFILE_PORT"))


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
    if getattr(exc, "winerror", None) == 10048:
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


def _resolve_data_dir(root: Path) -> tuple[Path, str | None]:
    override = os.environ.get("QUALIFILE_DATA_DIR")
    if override:
        data_dir = Path(override)
        if not _ensure_writable(data_dir):
            raise RuntimeError(f"QUALIFILE_DATA_DIR is not writable: {data_dir}")
        return data_dir, None

    data_dir = root / "data"
    if _ensure_writable(data_dir):
        return data_dir, None

    fallback = _fallback_data_dir()
    if not _ensure_writable(fallback):
        raise RuntimeError(f"Portable data directory is not writable and fallback failed: {fallback}")
    message = f"Portable data folder is not writable at {data_dir}. Using {fallback}."
    return fallback, message


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
    os.environ.setdefault("QUALIFILE_STATIC_ROOT", str(root / "static"))
    os.environ.setdefault("QUALIFILE_TEMPLATES_ROOT", str(root / "templates"))
    print(
        "Portable mode enabled (offline assets: %s, data dir: %s)"
        % (os.environ.get("QUALIFILE_OFFLINE_ASSETS"), data_dir)
    )


def _create_server(host: str, app, explicit_port: int | None, preferred_port: int = 5000):
    fallback_from: int | None = None
    if explicit_port is not None:
        if explicit_port == 0:
            server = make_server(host, 0, app, threaded=True, request_handler=PrivacyRequestHandler)
            return server, server.server_address[1], fallback_from
        fd = _bind_exclusive_socket(host, explicit_port)
        server = make_server(host, explicit_port, app, threaded=True, fd=fd, request_handler=PrivacyRequestHandler)
        return server, server.server_address[1], fallback_from

    try:
        fd = _bind_exclusive_socket(host, preferred_port)
    except OSError as exc:
        if not _is_address_in_use(exc):
            raise
        fallback_from = preferred_port
        server = make_server(host, 0, app, threaded=True, request_handler=PrivacyRequestHandler)
        return server, server.server_address[1], fallback_from

    server = make_server(host, preferred_port, app, threaded=True, fd=fd, request_handler=PrivacyRequestHandler)
    return server, server.server_address[1], fallback_from


def main() -> None:
    host = "127.0.0.1"
    portable_root = _portable_root()
    explicit_port = _explicit_port()
    data_dir, data_message = _resolve_data_dir(portable_root)
    _prepare_environment(portable_root, host, explicit_port, data_dir)
    paths = resolve_paths(data_dir, os.environ)
    startup_log = StartupLogWriter(paths.logs_dir / "portable_startup.log")
    spd_env = os.environ
    spd_controller = _maybe_spd_controller(
        spd_env,
        on_cancel=lambda: os._exit(1),
        log_error=lambda msg: startup_log.append("spd", msg),
    )
    _emit_spd_event("stage", stage_id="LAUNCHER_INITIALIZING", message="Launcher initializing", env=spd_env)
    _update_spd_stage(spd_controller, "LAUNCHER_INITIALIZING", "Launcher initializing")
    _emit_spd_event("stage", stage_id="RESOLVING_DATA_DIR", message="Resolving data directory", env=spd_env)
    _update_spd_stage(spd_controller, "RESOLVING_DATA_DIR", "Resolving data directory")
    _emit_spd_event("stage", stage_id="LOADING_CONFIG", message="Loading configuration", env=spd_env)
    _update_spd_stage(spd_controller, "LOADING_CONFIG", "Loading configuration")

    app = create_app({"PORTABLE_ROOT": portable_root, "ALLOW_SHUTDOWN": True})
    _emit_spd_event("stage", stage_id="STARTING_SERVER", message="Starting server", env=spd_env)
    _update_spd_stage(spd_controller, "STARTING_SERVER", "Starting server")
    server, actual_port, fallback_from = _create_server(host, app, explicit_port)
    os.environ["QUALIFILE_PORT"] = str(actual_port)
    app.config["SERVER_PORT"] = actual_port
    app.config["SHUTDOWN_HANDLER"] = server.shutdown

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
    print(f"QUALIFILE_LISTENING_URL={url}", flush=True)
    print(f"QualiFile listening on {url}", flush=True)
    diagnostics_text = build_diagnostics_text_from_paths(
        paths.data_dir,
        url=url,
        port=actual_port,
        variant="portable",
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


if __name__ == "__main__":
    main()
