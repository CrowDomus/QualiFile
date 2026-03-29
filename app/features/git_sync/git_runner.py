"""Non-interactive Git execution helpers with timeout and output redaction."""

from __future__ import annotations

import os
import re
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Sequence

DEFAULT_GIT_TIMEOUT_SECONDS = 30.0
GIT_TIMEOUT_EXIT_CODE = 124
_RESTRICTED_GIT_ENV_VARS = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
)

_TOKEN_QUERY_RE = re.compile(r"(?i)([?&](?:access_token|token|password|passwd|pwd|secret)=)([^&\s]+)")
_AUTH_HEADER_RE = re.compile(r"(?im)\b(authorization|proxy-authorization)\b\s*:\s*([^\r\n]+)")
_TOKEN_ASSIGNMENT_RE = re.compile(
    r"(?im)\b(access_token|token|password|passwd|pwd|secret)\b"
    r"\s*([:=])\s*([^\s,;]+)"
)
_URL_USERINFO_RE = re.compile(r"(?i)\b(https?|ssh)://([^/@\s]+)@")
_KNOWN_TOKEN_RE = re.compile(
    r"(?<![A-Za-z0-9])"
    r"(gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,})"
    r"(?![A-Za-z0-9])"
)
_MAX_FAILURE_SUMMARY_LENGTH = 280

SubprocessRunner = Callable[[Sequence[str], Path, Mapping[str, str], float], tuple[int, str, str]]


@dataclass(frozen=True)
class GitCommandResult:
    command: tuple[str, ...]
    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool
    timeout_seconds: float
    duration_seconds: float

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out


class GitCommandConfigurationError(ValueError):
    """Raised when Git command configuration violates execution hardening."""

    def __init__(self, *, kind: str, message: str):
        super().__init__(message)
        self.kind = str(kind).strip() or "git_path_invalid"


def build_non_interactive_git_environment(
    base_environment: Mapping[str, str] | None = None,
) -> dict[str, str]:
    environment = dict(os.environ if base_environment is None else base_environment)
    for variable in _RESTRICTED_GIT_ENV_VARS:
        environment.pop(variable, None)
    environment["GIT_TERMINAL_PROMPT"] = "0"
    environment["GIT_PAGER"] = "cat"
    environment["PAGER"] = "cat"
    environment["GCM_INTERACTIVE"] = "Never"
    return environment


def redact_sensitive_text(value: str | bytes | None) -> str:
    text = _coerce_output_text(value)
    if not text:
        return ""

    redacted = _URL_USERINFO_RE.sub(r"\1://***@", text)
    redacted = _TOKEN_QUERY_RE.sub(r"\1***", redacted)
    redacted = _AUTH_HEADER_RE.sub(r"\1:***", redacted)
    redacted = _TOKEN_ASSIGNMENT_RE.sub(r"\1\2***", redacted)
    redacted = _KNOWN_TOKEN_RE.sub("***", redacted)
    return redacted


def _coerce_output_text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _default_subprocess_runner(
    command: Sequence[str],
    cwd: Path,
    environment: Mapping[str, str],
    timeout_seconds: float,
) -> tuple[int, str, str]:
    process = subprocess.run(
        command,
        cwd=str(cwd),
        env=dict(environment),
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout_seconds,
    )
    return process.returncode, _coerce_output_text(process.stdout), _coerce_output_text(process.stderr)


def _timeout_message(timeout_seconds: float) -> str:
    return f"Git command timed out after {timeout_seconds:g}s."


def _contains_recurse_submodules_flag(args: Sequence[str]) -> bool:
    for arg in args:
        token = str(arg).strip()
        if token == "--recurse-submodules" or token.startswith("--recurse-submodules="):
            return True
    return False


def _normalize_git_binary(git_binary: Path | str | None) -> str:
    if git_binary is None:
        raise GitCommandConfigurationError(
            kind="git_not_trusted",
            message="Git executable is not configured; provide a trusted absolute path.",
        )
    text = str(git_binary).strip()
    if not text:
        raise GitCommandConfigurationError(
            kind="git_not_trusted",
            message="Git executable is not configured; provide a trusted absolute path.",
        )
    candidate = Path(text).expanduser()
    if not candidate.is_absolute():
        raise GitCommandConfigurationError(
            kind="git_path_invalid",
            message="Git executable path must be absolute.",
        )
    return str(candidate)


def run_git_command(
    repo_root: Path | str,
    args: Sequence[str],
    *,
    git_binary: Path | str | None = None,
    timeout_seconds: float = DEFAULT_GIT_TIMEOUT_SECONDS,
    base_environment: Mapping[str, str] | None = None,
    run_subprocess: SubprocessRunner = _default_subprocess_runner,
) -> GitCommandResult:
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be greater than zero.")
    if _contains_recurse_submodules_flag(args):
        raise ValueError("Git Sync forbids '--recurse-submodules' in v1.")

    root = Path(repo_root).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise FileNotFoundError(f"Git repo root is invalid: {root}")

    command = tuple([_normalize_git_binary(git_binary), "--no-pager", *[str(item) for item in args]])
    environment = build_non_interactive_git_environment(base_environment)
    started = time.monotonic()

    try:
        exit_code, stdout, stderr = run_subprocess(command, root, environment, float(timeout_seconds))
        timed_out = False
    except subprocess.TimeoutExpired as exc:
        exit_code = GIT_TIMEOUT_EXIT_CODE
        stdout = _coerce_output_text(exc.stdout)
        stderr = _coerce_output_text(exc.stderr)
        timeout_line = _timeout_message(timeout_seconds)
        stderr = f"{stderr.rstrip()}\n{timeout_line}" if stderr.strip() else timeout_line
        timed_out = True

    duration = max(0.0, time.monotonic() - started)
    return GitCommandResult(
        command=command,
        exit_code=int(exit_code),
        stdout=redact_sensitive_text(stdout),
        stderr=redact_sensitive_text(stderr),
        timed_out=timed_out,
        timeout_seconds=float(timeout_seconds),
        duration_seconds=duration,
    )


def summarize_git_failure(result: GitCommandResult, *, max_length: int = _MAX_FAILURE_SUMMARY_LENGTH) -> str:
    if result.ok:
        return "Git command completed successfully."

    if result.timed_out:
        return _timeout_message(result.timeout_seconds)

    for candidate in (result.stderr, result.stdout):
        for line in candidate.splitlines():
            summary = line.strip()
            if not summary:
                continue
            if len(summary) > max_length:
                return f"{summary[: max_length - 3]}..."
            return summary
    return f"Git command failed with exit code {result.exit_code}."


__all__ = [
    "DEFAULT_GIT_TIMEOUT_SECONDS",
    "GIT_TIMEOUT_EXIT_CODE",
    "GitCommandConfigurationError",
    "GitCommandResult",
    "build_non_interactive_git_environment",
    "redact_sensitive_text",
    "run_git_command",
    "summarize_git_failure",
]
