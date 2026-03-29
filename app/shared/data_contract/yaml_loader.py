"""Minimal YAML loader for the schema registry (subset of YAML)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .errors import YamlParseError


@dataclass(frozen=True)
class _Line:
    indent: int
    content: str


def load_yaml(path: Path) -> Any:
    text = Path(path).read_text(encoding="utf-8")
    return parse_yaml(text, source=str(path))


def parse_yaml(text: str, *, source: str = "<string>") -> Any:
    lines = _prepare_lines(text, source=source)
    if not lines:
        return {}

    root: dict[str, Any] = {}
    stack: list[tuple[int, Any]] = [(-1, root)]

    for index, line in enumerate(lines):
        indent = line.indent
        content = line.content

        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        container = stack[-1][1]

        if content.startswith("- "):
            if not isinstance(container, list):
                raise YamlParseError(f"{source}: list item found outside a list at line {index + 1}")
            item_text = content[2:].strip()
            if not item_text:
                child = _new_container(lines, index, indent)
                container.append(child)
                stack.append((indent, child))
                continue
            key, value_text = _split_key_value(item_text, allow_no_colon=True)
            if key is None:
                container.append(_parse_scalar(item_text))
                continue
            if value_text is None:
                child = _new_container(lines, index, indent)
                item = {key: child}
                container.append(item)
                stack.append((indent, child))
                continue
            item = {key: _parse_scalar(value_text)}
            container.append(item)
            stack.append((indent, item))
            continue

        if not isinstance(container, dict):
            raise YamlParseError(f"{source}: mapping entry found outside a map at line {index + 1}")
        key, value_text = _split_key_value(content, allow_no_colon=False)
        if value_text is None:
            child = _new_container(lines, index, indent)
            container[key] = child
            stack.append((indent, child))
        else:
            container[key] = _parse_scalar(value_text)

    return root


def _prepare_lines(text: str, *, source: str) -> list[_Line]:
    output: list[_Line] = []
    for raw_index, raw_line in enumerate(text.splitlines()):
        if raw_index == 0 and raw_line.startswith("\ufeff"):
            raw_line = raw_line.lstrip("\ufeff")
        stripped = _strip_comments(raw_line).rstrip()
        if not stripped.strip():
            continue
        indent = _leading_spaces(stripped, source=source, line_number=raw_index + 1)
        content = stripped.lstrip(" ")
        output.append(_Line(indent=indent, content=content))
    return output


def _strip_comments(line: str) -> str:
    in_single = False
    in_double = False
    for index, char in enumerate(line):
        if char == "'" and not in_double:
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double
        if char == "#" and not in_single and not in_double:
            return line[:index]
    return line


def _leading_spaces(line: str, *, source: str, line_number: int) -> int:
    count = 0
    for char in line:
        if char == " ":
            count += 1
            continue
        if char == "\t":
            raise YamlParseError(f"{source}: tab indentation is not supported at line {line_number}")
        break
    return count


def _new_container(lines: list[_Line], index: int, indent: int) -> Any:
    next_line = _next_child_line(lines, index, indent)
    if next_line and next_line.content.startswith("- "):
        return []
    return {}


def _next_child_line(lines: list[_Line], index: int, indent: int) -> _Line | None:
    for next_index in range(index + 1, len(lines)):
        candidate = lines[next_index]
        if candidate.indent <= indent:
            return None
        return candidate
    return None


def _split_key_value(text: str, *, allow_no_colon: bool) -> tuple[str | None, str | None]:
    in_single = False
    in_double = False
    for index, char in enumerate(text):
        if char == "'" and not in_double:
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double
        if char == ":" and not in_single and not in_double:
            key = text[:index].strip()
            value = text[index + 1 :].strip()
            if not key:
                raise YamlParseError("YAML key cannot be empty")
            return key, value or None
    if allow_no_colon:
        return None, None
    raise YamlParseError("Expected a mapping entry with ':'")


def _parse_scalar(text: str) -> Any:
    if text == "":
        return ""
    lowered = text.lower()
    if text == "[]":
        return []
    if text == "{}":
        return {}
    if lowered in {"null", "~"}:
        return None
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if _is_int(text):
        try:
            return int(text)
        except Exception:
            pass
    if _is_quoted(text):
        return _unquote(text)
    return text


def _is_int(text: str) -> bool:
    if text.startswith("-"):
        return text[1:].isdigit()
    return text.isdigit()


def _is_quoted(text: str) -> bool:
    return (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'"))


def _unquote(text: str) -> str:
    if len(text) < 2:
        return text
    quote = text[0]
    inner = text[1:-1]
    if quote == "'":
        return inner.replace("''", "'")
    return (
        inner.replace("\\\\", "\\")
        .replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace("\\r", "\r")
        .replace('\\"', '"')
    )


def iter_scalar_lines(payload: Any) -> Iterable[str]:
    if isinstance(payload, dict):
        for value in payload.values():
            yield from iter_scalar_lines(value)
    elif isinstance(payload, list):
        for value in payload:
            yield from iter_scalar_lines(value)
    elif isinstance(payload, str):
        yield payload
