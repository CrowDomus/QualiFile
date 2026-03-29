from __future__ import annotations

from dataclasses import dataclass
import queue
import subprocess
import threading
from typing import Iterable

from .startup_log import StartupLogWriter


@dataclass(frozen=True)
class LogLine:
    stream: str
    line: str


class BackendMonitor:
    def __init__(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        startup_log: StartupLogWriter | None = None,
        encoding: str = "utf-8",
        errors: str = "replace",
    ) -> None:
        self.argv = [str(arg) for arg in argv]
        self.cwd = cwd
        self.env = env
        self.startup_log = startup_log
        self.encoding = encoding
        self.errors = errors
        self.process: subprocess.Popen[str] | None = None
        self._queue: "queue.Queue[LogLine]" = queue.Queue()
        self._threads: list[threading.Thread] = []

    def start(self) -> "BackendMonitor":
        if self.process is not None:
            raise RuntimeError("BackendMonitor already started")
        self.process = subprocess.Popen(
            self.argv,
            cwd=self.cwd,
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding=self.encoding,
            errors=self.errors,
            bufsize=1,
        )
        self._start_reader("stdout", self.process.stdout)
        self._start_reader("stderr", self.process.stderr)
        return self

    def _start_reader(self, stream_name: str, stream) -> None:
        if stream is None:
            return
        thread = threading.Thread(
            target=self._read_stream,
            args=(stream_name, stream),
            daemon=True,
        )
        thread.start()
        self._threads.append(thread)

    def _read_stream(self, stream_name: str, stream) -> None:
        for line in iter(stream.readline, ""):
            cleaned = line.rstrip("\n")
            self._queue.put(LogLine(stream=stream_name, line=cleaned))
            if self.startup_log is not None:
                self.startup_log.append(stream_name, cleaned)
        stream.close()

    def iter_lines(self, timeout: float = 0.1) -> Iterable[LogLine]:
        if self.process is None:
            raise RuntimeError("BackendMonitor not started")
        while True:
            try:
                item = self._queue.get(timeout=timeout)
                yield item
            except queue.Empty:
                if self.process.poll() is not None and self._queue.empty():
                    break

    def wait(self, timeout: float | None = None) -> int | None:
        if self.process is None:
            return None
        exit_code = self.process.wait(timeout=timeout)
        for thread in self._threads:
            thread.join(timeout=0.1)
        return exit_code

    def terminate(self) -> None:
        if self.process is None:
            return
        self.process.terminate()

    def kill(self) -> None:
        if self.process is None:
            return
        self.process.kill()
