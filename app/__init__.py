"""Flask application factory and root-path persistence helpers."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Mapping, Optional
import logging
import secrets
from logging.handlers import TimedRotatingFileHandler
from uuid import uuid4

from flask import Flask, g

from .blueprints.api import api_bp
from .blueprints.pages import page_bp
from .shared.capability_security import cache_root_identity
from .shared.data_dir import ensure_directories, resolve_data_dir, resolve_paths
from .shared.diagnostics.state import write_data_state
from .shared.logging import JSONFormatter, RequestContextFilter
from .shared.request_security import enforce_trusted_authority
from .shared.response_security import new_csp_nonce, secure_response
from .shared.db import close_db
from .shared.db_validation import DatabaseValidationError, ensure_db_ready
from .shared.preferences import get_preference, set_preference
from .shared.support_bundle import apply_retention_policies
from .shared.version import get_version
from .features.task_alerts import ensure_task_alert_scheduler, run_startup_alert_evaluation


class SafeTimedRotatingFileHandler(TimedRotatingFileHandler):
    """TimedRotatingFileHandler that tolerates locked files (Windows)."""

    def doRollover(self):
        try:
            super().doRollover()
        except PermissionError:
            # If the log file is locked by another process, skip rotation but keep logging.
            if not self.stream:
                self.stream = self._open()


def _state_file_path(data_dir: Path | None = None) -> Path:
    """Return the location used to persist the selected root."""

    override = os.environ.get("QUALIFILE_STATE")
    if override:
        return Path(override)
    if data_dir:
        return Path(data_dir) / "notes" / "root_state.json"
    env_data_dir = os.environ.get("QUALIFILE_DATA_DIR")
    if env_data_dir:
        return Path(env_data_dir) / "notes" / "root_state.json"
    # Fallback to a stable location within the package hierarchy (not CWD).
    return Path(__file__).resolve().parent / "instance" / "notes" / "root_state.json"


def _first_existing_path(candidates: list[Path]) -> Path:
    """Return the first existing directory from *candidates* or the last item."""

    for candidate in candidates:
        if candidate.exists() and candidate.is_dir():
            return candidate
    return candidates[-1]


def _minified_assets_available(static_root: Path) -> bool:
    """Return True if the bundled minified assets are present under *static_root*."""

    required = [
        static_root / "dist" / "css" / "app.min.css",
        static_root / "dist" / "css" / "prism-theme.min.css",
        static_root / "dist" / "js" / "entrypoints" / "main.min.js",
        static_root / "dist" / "js" / "entrypoints" / "projects_page.min.js",
    ]
    return all(path.exists() for path in required)


def _validate_minified_manifest(static_root: Path) -> None:
    manifest = static_root / "dist" / "manifest.json"
    if not manifest.exists():
        raise RuntimeError("Minified assets manifest is missing. Run `python tools/build_assets.py`.")
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError("Minified assets manifest is invalid. Rebuild assets.") from exc
    entries = data.get("entries") or {}
    missing = []
    for info in entries.values():
        output = info.get("output")
        if not output:
            continue
        # Manifest outputs are recorded with a project-root prefix (e.g. app/static/dist/...).
        # Align them to the resolved static_root by trimming everything before the dist folder.
        output_parts = Path(output).parts
        if "dist" in output_parts:
            dist_index = output_parts.index("dist")
            normalized = Path(*output_parts[dist_index:])
        elif "static" in output_parts:
            static_index = output_parts.index("static") + 1
            normalized = Path(*output_parts[static_index:])
        else:
            normalized = Path(output)
        target = static_root / normalized
        if not target.exists():
            missing.append(output)
    if missing:
        joined = ", ".join(missing)
        raise RuntimeError(f"Minified assets missing: {joined}. Run `python tools/build_assets.py`.")


def load_root_path(
    state_file: Path | None = None,
    *,
    data_dir: Path | None = None,
    config: Mapping[str, Any] | None = None,
) -> Optional[Path]:
    """Load the persisted root path from SQLite preferences."""

    _ = state_file
    if data_dir is None:
        return None
    db_value = get_preference(Path(data_dir), config or {}, "root_state")
    if not db_value:
        return None
    candidate = Path(db_value).expanduser().resolve()
    if candidate.exists() and candidate.is_dir():
        return candidate
    return None


def save_root_path(
    path: Optional[Path],
    state_file: Path | None = None,
    *,
    data_dir: Path | None = None,
    config: Mapping[str, Any] | None = None,
) -> None:
    """Persist the selected root directory for subsequent sessions."""

    _ = state_file
    if data_dir is None:
        return
    set_preference(Path(data_dir), config or {}, "root_state", str(path) if path else None)


def _bool_env(key: str, default: bool = False) -> bool:
    value = os.environ.get(key)
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _storage_mode_env(key: str) -> Optional[str]:
    value = os.environ.get(key)
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in {"legacy", "dual", "new"}:
        return normalized
    return None


_PROFILE_MODES = {"off", "shadow", "on"}
_PROFILE_TOGGLES = {"off", "on"}


def _profile_mode_env(key: str) -> Optional[str]:
    value = os.environ.get(key)
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in _PROFILE_MODES:
        return normalized
    return None


def _profile_toggle_env(key: str) -> Optional[str]:
    value = os.environ.get(key)
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in _PROFILE_TOGGLES:
        return normalized
    return None


def _normalize_profile_mode(value: object) -> str:
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in _PROFILE_MODES:
            return normalized
    if isinstance(value, bool):
        return "on" if value else "off"
    return "off"


def _normalize_profile_toggle(value: object) -> str:
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in _PROFILE_TOGGLES:
            return normalized
    if isinstance(value, bool):
        return "on" if value else "off"
    return "off"


def _content_length_env(default: int = 100 * 1024 * 1024) -> int | None:
    for key in ("QUALIFILE_MAX_CONTENT_LENGTH", "MAX_CONTENT_LENGTH"):
        value = os.environ.get(key)
        if value is None:
            continue
        raw = value.strip()
        if not raw:
            continue
        try:
            parsed = int(raw)
        except ValueError:
            continue
        if parsed >= 0:
            return parsed
    return default


def create_app(config: Mapping[str, Any] | None = None) -> Flask:
    """Create and configure the Flask application instance."""

    default_static = Path(__file__).parent / "static"
    default_templates = Path(__file__).parent / "templates"
    static_candidates = []
    templates_candidates = []
    static_override = os.environ.get("QUALIFILE_STATIC_ROOT")
    templates_override = os.environ.get("QUALIFILE_TEMPLATES_ROOT")
    if static_override:
        static_candidates.append(Path(static_override))
    static_candidates.append(default_static)
    if templates_override:
        templates_candidates.append(Path(templates_override))
    templates_candidates.append(default_templates)
    static_root = _first_existing_path(static_candidates)
    templates_root = _first_existing_path(templates_candidates)
    use_minified_env = _bool_env("QUALIFILE_MINIFIED", False)
    use_minified_assets = use_minified_env and _minified_assets_available(static_root)
    if use_minified_env:
        if not _minified_assets_available(static_root):
            raise RuntimeError("QUALIFILE_MINIFIED is set but dist assets are missing. Run `python tools/build_assets.py`.")
        _validate_minified_manifest(static_root)
    instance_override = os.environ.get("QUALIFILE_INSTANCE_PATH")
    instance_path = Path(instance_override) if instance_override else None
    if instance_path:
        instance_path.mkdir(parents=True, exist_ok=True)

    app = Flask(
        __name__,
        static_folder=str(static_root),
        template_folder=str(templates_root),
        instance_path=str(instance_path) if instance_path else None,
    )

    Path(app.instance_path).mkdir(parents=True, exist_ok=True)
    app.config["MAX_CONTENT_LENGTH"] = _content_length_env()
    app.config.setdefault("PORTABLE_MODE", _bool_env("QUALIFILE_PORTABLE", False))
    app.config.setdefault("USE_MINIFIED_ASSETS", use_minified_assets)
    app.config.setdefault("OFFLINE_ASSETS", _bool_env("QUALIFILE_OFFLINE_ASSETS", False))
    app.config.setdefault("SERVER_HOST", os.environ.get("QUALIFILE_HOST", "127.0.0.1"))
    app.config.setdefault("SERVER_PORT", int(os.environ.get("QUALIFILE_PORT", "5000")))
    app.config.setdefault(
        "GREENSHOT_EXECUTABLE",
        os.environ.get("QUALIFILE_GREENSHOT_EXECUTABLE", ""),
    )
    app.config.setdefault(
        "GREENSHOT_HOTKEY",
        os.environ.get("QUALIFILE_GREENSHOT_HOTKEY", ""),
    )
    app.config.setdefault(
        "GREENSHOT_DELAY_MS",
        os.environ.get("QUALIFILE_GREENSHOT_DELAY_MS", "350"),
    )
    data_dir = resolve_data_dir(Path(app.instance_path))
    paths = resolve_paths(data_dir)
    app.config.setdefault("DATA_DIR", paths.data_dir)
    app.config.setdefault("PREVIEW_CACHE_DIR", paths.preview_cache_dir)
    app.config.setdefault("OFFICE_CACHE_DIR", paths.office_cache_dir)
    app.config.setdefault("LOG_FILE", paths.log_file)
    app.config.setdefault("DIAGNOSTICS_DIR", paths.diagnostics_dir)
    storage_mode = _storage_mode_env("QUALIFILE_STORAGE_MODE") or "legacy"
    app.config.setdefault("STORAGE_MODE", storage_mode)
    app.config.setdefault("STORAGE_MODE_PROJECTS", _storage_mode_env("QUALIFILE_STORAGE_PROJECTS"))
    app.config.setdefault("STORAGE_MODE_ENTRIES", _storage_mode_env("QUALIFILE_STORAGE_ENTRIES"))
    app.config.setdefault("STORAGE_MODE_TAGS", _storage_mode_env("QUALIFILE_STORAGE_TAGS"))
    app.config.setdefault("STORAGE_MODE_NOTES", _storage_mode_env("QUALIFILE_STORAGE_NOTES"))
    app.config.setdefault("STORAGE_MODE_VALIDATION", _storage_mode_env("QUALIFILE_STORAGE_VALIDATION"))
    app.config.setdefault("STORAGE_MODE_ROOT_STATE", _storage_mode_env("QUALIFILE_STORAGE_ROOT_STATE"))
    app.config.setdefault("ALLOW_SHUTDOWN", app.config.get("PORTABLE_MODE", False))
    app.config.setdefault("CSRF_TOKEN", secrets.token_hex(32))
    profile_mode_raw = os.environ.get("QUALIFILE_PROFILE_MODE")
    profile_mode_env = _profile_mode_env("QUALIFILE_PROFILE_MODE")
    invalid_profile_mode = profile_mode_raw is not None and profile_mode_env is None
    profile_avatar_raw = os.environ.get("QUALIFILE_PROFILE_AVATAR")
    profile_avatar_env = _profile_toggle_env("QUALIFILE_PROFILE_AVATAR")
    invalid_profile_avatar = profile_avatar_raw is not None and profile_avatar_env is None
    app.config.setdefault("PROFILE_MODE", profile_mode_env or "on")
    app.config.setdefault("PROFILE_AVATAR_MODE", profile_avatar_env or "off")

    logs_dir = paths.logs_dir
    ensure_directories(paths)

    if config:
        app.config.update(config)

    try:
        app.config["CACHE_CLEAR_ROOT_IDENTITIES"] = {
            "preview": cache_root_identity(app.config["PREVIEW_CACHE_DIR"]),
            "office": cache_root_identity(app.config["OFFICE_CACHE_DIR"]),
        }
    except (OSError, TypeError, ValueError):
        # Preserve startup for diagnostics, but fail closed if cache clear is
        # requested with an invalid configured root.
        app.config["CACHE_CLEAR_ROOT_IDENTITIES"] = None

    state_file = _state_file_path(data_dir)
    app.config["ROOT_STATE_FILE"] = state_file
    app.config["QUALIFILE_ROOT"] = load_root_path(
        state_file=state_file,
        data_dir=data_dir,
        config=app.config,
    )

    _configure_logging(app, logs_dir)

    logger = logging.getLogger("qualifile")
    logger.info("QualiFile version %s", get_version())
    try:
        ensure_db_ready(Path(app.config["DATA_DIR"]), app.config, logger=logger)
    except DatabaseValidationError as exc:
        logger.error("Database validation failed: %s", exc)
        raise
    try:
        run_startup_alert_evaluation(app)
    except Exception:
        logger.exception("Task alert startup evaluation failed; continuing without blocking startup.")
    try:
        write_data_state(data_dir, config=app.config)
    except Exception:
        logger.exception("Failed to write diagnostics data_state.json")
    try:
        apply_retention_policies(Path(app.config["DATA_DIR"]), app.config)
    except Exception:
        logger.exception("Failed to apply retention policies")
    if invalid_profile_mode:
        logger.warning("Invalid QUALIFILE_PROFILE_MODE value '%s'; forcing off.", profile_mode_raw)
    if invalid_profile_avatar:
        logger.warning("Invalid QUALIFILE_PROFILE_AVATAR value '%s'; forcing off.", profile_avatar_raw)
    profile_mode = _normalize_profile_mode(app.config.get("PROFILE_MODE", "on"))
    if invalid_profile_mode:
        profile_mode = "off"
    app.config["PROFILE_MODE"] = profile_mode
    avatar_mode = _normalize_profile_toggle(app.config.get("PROFILE_AVATAR_MODE", "off"))
    app.config["PROFILE_AVATAR_MODE"] = avatar_mode

    app.register_blueprint(api_bp, url_prefix="/api")
    app.register_blueprint(page_bp)
    app.teardown_appcontext(close_db)

    @app.before_request
    def _enforce_trusted_authority():
        return enforce_trusted_authority()

    @app.before_request
    def _assign_request_id():
        from flask import g

        g.request_id = str(uuid4())
        g.csp_nonce = new_csp_nonce()

    @app.before_request
    def _ensure_task_alert_scheduler_running():
        ensure_task_alert_scheduler(app)

    @app.after_request
    def _attach_request_id(response):
        from flask import g

        request_id = getattr(g, "request_id", None)
        if request_id:
            response.headers["X-Request-ID"] = request_id
        return secure_response(response)

    @app.context_processor
    def inject_globals():
        """Expose shared template variables."""

        data_dir = app.config.get("DATA_DIR")
        data_dir_value = str(data_dir) if data_dir else ""
        portable_root = app.config.get("PORTABLE_ROOT")
        portable_root_value = str(portable_root) if portable_root else None
        portable_data_in_root = None
        if portable_root and data_dir:
            try:
                Path(data_dir).resolve().relative_to(Path(portable_root).resolve())
                portable_data_in_root = True
            except Exception:
                portable_data_in_root = False

        return {
            "app_name": "QualiFile",
            "app_version": get_version(),
            "portable_mode": bool(app.config.get("PORTABLE_MODE")),
            "use_minified_assets": bool(app.config.get("USE_MINIFIED_ASSETS")),
            "offline_assets": bool(app.config.get("OFFLINE_ASSETS")),
            "csrf_token": app.config.get("CSRF_TOKEN"),
            "csp_nonce": getattr(g, "csp_nonce", ""),
            "profile_mode": app.config.get("PROFILE_MODE", "off"),
            "profile_avatar_mode": app.config.get("PROFILE_AVATAR_MODE", "off"),
            "data_dir": data_dir_value,
            "portable_root": portable_root_value,
            "portable_data_in_root": portable_data_in_root,
        }

    return app


def _configure_logging(app: Flask, logs_dir: Path) -> None:
    """Set up bounded JSON logging with daily rotation."""

    log_file = logs_dir / "errors.log"
    try:
        retention_days = int(os.environ.get("QUALIFILE_LOG_RETENTION", "30"))
    except (TypeError, ValueError):
        retention_days = 30
    retention_days = min(max(retention_days, 1), 3650)
    handler = SafeTimedRotatingFileHandler(
        log_file,
        when="midnight",
        backupCount=retention_days,
        encoding="utf-8",
        utc=False,
        delay=True,
    )
    handler.setFormatter(JSONFormatter())
    handler.addFilter(RequestContextFilter())
    app_logger = logging.getLogger("qualifile")
    app_logger.setLevel(logging.INFO)
    app_logger.handlers = []
    app_logger.propagate = False
    app_logger.addHandler(handler)

    # Also route Flask app logger to the same handler to capture exceptions.
    flask_logger = app.logger
    flask_logger.handlers = []
    flask_logger.propagate = False
    flask_logger.setLevel(logging.INFO)
    flask_logger.addHandler(handler)


__all__ = ["create_app", "save_root_path", "load_root_path"]
