from __future__ import annotations

"""Preview related helpers used by the web UI."""

import mimetypes
from pathlib import Path
from typing import Dict, Tuple

CHUNK_SIZE = 8192


def detect_mime(path: Path) -> str:
    """Return a simple content type guess for ``path``."""

    suffix = path.suffix.lower()
    if suffix in {".png"}:
        return "image/png"
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".pdf":
        return "application/pdf"
    if suffix == ".txt":
        return "text/plain"
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


CODE_LANGUAGE_MAP: Dict[str, str] = {
    ".py": "python",
    ".pyw": "python",
    ".pyi": "python",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".jsx": "jsx",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".hpp": "cpp",
    ".hh": "cpp",
    ".hxx": "cpp",
    ".cxx": "cpp",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".m": "objectivec",
    ".mm": "objectivec",
    ".cs": "csharp",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".php4": "php",
    ".php5": "php",
    ".phtml": "php",
    ".swift": "swift",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".scala": "scala",
    ".sql": "sql",
    ".pl": "perl",
    ".pm": "perl",
    ".r": "r",
    ".dart": "dart",
    ".lua": "lua",
    ".groovy": "groovy",
    ".gradle": "groovy",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".ksh": "bash",
    ".fish": "bash",
    ".ps1": "powershell",
    ".psm1": "powershell",
    ".psd1": "powershell",
    ".bat": "batch",
    ".cmd": "batch",
    ".clj": "clojure",
    ".cljs": "clojure",
    ".cljc": "clojure",
    ".edn": "clojure",
    ".erl": "erlang",
    ".ex": "elixir",
    ".exs": "elixir",
    ".hs": "haskell",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".json": "json",
    ".json5": "json",
    ".toml": "toml",
    ".ini": "ini",
    ".cfg": "ini",
    ".conf": "ini",
    ".env": "properties",
    ".properties": "properties",
    ".md": "markdown",
    ".mdx": "markdown",
    ".markdown": "markdown",
    ".rst": "rst",
    ".tex": "latex",
    ".bib": "latex",
    ".html": "html",
    ".htm": "html",
    ".xhtml": "markup",
    ".xml": "xml",
    ".xsl": "xml",
    ".svg": "svg",
    ".css": "css",
    ".scss": "scss",
    ".sass": "sass",
    ".less": "less",
    ".styl": "stylus",
    ".vue": "markup",
    ".svelte": "svelte",
    ".nginx": "nginx",
    ".nginxconf": "nginx",
    ".lock": "json",
}


SPECIAL_CODE_FILENAMES: Dict[str, str] = {
    "dockerfile": "docker",
    "docker-compose.yml": "yaml",
    "docker-compose.yaml": "yaml",
    "makefile": "makefile",
    "cmakelists.txt": "cmake",
    "vagrantfile": "ruby",
    ".gitconfig": "git",
    ".gitignore": "git",
    "gitmodules": "git",
    "package.json": "json",
    "package-lock.json": "json",
    "composer.json": "json",
    "pom.xml": "xml",
}


TEXT_LIKE_MIME = {
    "text/plain",
    "text/x-python",
    "text/x-python-script",
    "text/x-c",
    "text/x-c++",
    "text/x-java",
    "text/javascript",
    "application/javascript",
    "application/json",
    "application/xml",
    "application/x-sh",
    "application/x-shellscript",
    "application/x-yaml",
    "text/markdown",
    "text/x-script.python",
    "text/x-shellscript",
}


def detect_code_language(path: Path) -> str | None:
    """Return a Prism language identifier for source files."""

    name = path.name.lower()
    if name in SPECIAL_CODE_FILENAMES:
        return SPECIAL_CODE_FILENAMES[name]
    suffix = path.suffix.lower()
    if suffix in CODE_LANGUAGE_MAP:
        return CODE_LANGUAGE_MAP[suffix]
    if name.endswith(".dockerfile"):
        return "docker"
    return None


def is_probably_textual(mime: str) -> bool:
    """Best-effort detection for textual MIME types."""

    if not mime:
        return False
    if mime.startswith("text/"):
        return True
    return mime in TEXT_LIKE_MIME


def read_text_preview(path: Path, *, offset: int = 0, length: int | None = CHUNK_SIZE) -> Tuple[str, bool, int, int]:
    """Return a chunk of text from *path* along with paging details."""

    if offset < 0:
        offset = 0
    if length is not None and length <= 0:
        length = None
    total_size = path.stat().st_size
    with path.open("rb") as handle:
        handle.seek(offset)
        if length is None:
            data = handle.read()
        else:
            data = handle.read(length)
    next_offset = offset + len(data)
    text = data.decode("utf-8", errors="replace")
    has_more = next_offset < total_size
    return text, has_more, next_offset, total_size
