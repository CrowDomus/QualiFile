from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import threading
from typing import Callable


TimestampFn = Callable[[], str]


def _default_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class StartupLogWriter:
    def __init__(
        self,
        path: str | Path,
        *,
        timestamp_fn: TimestampFn | None = None,
        encoding: str = "utf-8",
        max_bytes: int = 256_000,
    ) -> None:
        self.path = Path(path)
        self.encoding = encoding
        self._timestamp_fn = timestamp_fn or _default_timestamp
        self._lock = threading.Lock()
        self._max_bytes = max_bytes
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, stream: str, line: str) -> None:
        safe_line = line.rstrip("\n")
        entry = f"{self._timestamp_fn()} [{stream}] {safe_line}\n"
        with self._lock:
            with self.path.open("a", encoding=self.encoding) as handle:
                handle.write(entry)
            self._enforce_max_bytes()

    def _enforce_max_bytes(self) -> None:
        if self._max_bytes <= 0:
            return
        try:
            size = self.path.stat().st_size
        except FileNotFoundError:
            return
        if size <= self._max_bytes:
            return
        try:
            with self.path.open("rb") as handle:
                handle.seek(-self._max_bytes, 2)
                tail = handle.read()
            with self.path.open("wb") as handle:
                handle.write(tail)
        except OSError:
            return
