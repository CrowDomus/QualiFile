from __future__ import annotations

from dataclasses import dataclass
import json
import time
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urlunparse
from urllib.request import ProxyHandler, Request, build_opener


@dataclass(frozen=True)
class ReadyResult:
    ok: bool
    status: str
    url: str
    elapsed: float
    attempts: int
    soft_timeout_exceeded: bool
    last_error: str | None
    last_status_code: int | None


def _status_url(base_url: str) -> str:
    parsed = urlparse(base_url)
    path = parsed.path or ""
    if path.endswith("/api/status"):
        new_path = path
    else:
        base = path.rstrip("/")
        new_path = f"{base}/api/status"
    return urlunparse(parsed._replace(path=new_path, params="", query="", fragment=""))


def _build_opener(proxy_bypass: bool):
    if proxy_bypass:
        return build_opener(ProxyHandler({}))
    return build_opener()


def _is_ready(status_code: int, body: bytes) -> bool:
    if status_code != 200:
        return False
    try:
        payload = json.loads(body.decode("utf-8"))
        return payload.get("status") == "ok"
    except (ValueError, UnicodeDecodeError, AttributeError):
        return True


def wait_ready(
    base_url: str,
    *,
    timeout: float = 30.0,
    interval: float = 0.5,
    soft_timeout: float | None = 10.0,
    proxy_bypass: bool = True,
    request_timeout: float = 2.0,
    sleep_fn: Callable[[float], None] = time.sleep,
    now_fn: Callable[[], float] = time.monotonic,
) -> ReadyResult:
    status_url = _status_url(base_url)
    opener = _build_opener(proxy_bypass)
    start = now_fn()
    attempts = 0
    soft_exceeded = False
    last_error = None
    last_status_code = None

    while True:
        attempts += 1
        try:
            req = Request(
                status_url,
                headers={"Accept": "application/json", "Cache-Control": "no-cache"},
            )
            with opener.open(req, timeout=request_timeout) as resp:
                body = resp.read(1024)
                last_status_code = resp.getcode()
                if _is_ready(last_status_code, body):
                    elapsed = now_fn() - start
                    if soft_timeout is not None and elapsed >= soft_timeout:
                        soft_exceeded = True
                    return ReadyResult(
                        ok=True,
                        status="ready",
                        url=status_url,
                        elapsed=elapsed,
                        attempts=attempts,
                        soft_timeout_exceeded=soft_exceeded,
                        last_error=last_error,
                        last_status_code=last_status_code,
                    )
        except HTTPError as exc:
            last_status_code = exc.code
            last_error = f"HTTP {exc.code}"
        except URLError as exc:
            last_error = str(exc.reason)
            last_status_code = None

        elapsed = now_fn() - start
        if soft_timeout is not None and elapsed >= soft_timeout:
            soft_exceeded = True
        if elapsed >= timeout:
            return ReadyResult(
                ok=False,
                status="timeout",
                url=status_url,
                elapsed=elapsed,
                attempts=attempts,
                soft_timeout_exceeded=soft_exceeded,
                last_error=last_error,
                last_status_code=last_status_code,
            )
        sleep_fn(interval)
