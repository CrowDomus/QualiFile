"""Parse SPD events from launcher/backend output."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .constants import EVENT_PREFIX, EVENT_TYPES, LEGACY_LISTENING_PREFIX


@dataclass(frozen=True)
class Event:
    type: str
    id: str | None = None
    ts: str | None = None
    message: str | None = None
    data: dict[str, Any] | None = None
    raw: dict[str, Any] | None = None


def parse_line(line: str) -> Event | None:
    if not line:
        return None
    text = line.strip()
    if not text:
        return None

    if text.startswith(EVENT_PREFIX):
        payload = text[len(EVENT_PREFIX) :].strip()
        try:
            obj = json.loads(payload)
        except Exception:
            return None
        if not isinstance(obj, dict):
            return None
        event_type = obj.get("type")
        if not isinstance(event_type, str) or event_type not in EVENT_TYPES:
            return None
        event_id = obj.get("id")
        if not isinstance(event_id, str):
            event_id = None
        ts = obj.get("ts")
        if not isinstance(ts, str):
            ts = None
        message = obj.get("message")
        if not isinstance(message, str):
            message = None
        data = obj.get("data")
        if not isinstance(data, dict):
            data = {}
        return Event(
            type=event_type,
            id=event_id,
            ts=ts,
            message=message,
            data=data,
            raw=obj,
        )

    if LEGACY_LISTENING_PREFIX in text:
        idx = text.find(LEGACY_LISTENING_PREFIX)
        url = text[idx + len(LEGACY_LISTENING_PREFIX) :].strip()
        if url:
            return Event(
                type="ready",
                id="READY",
                message="Legacy listening URL detected.",
                data={"url": url},
                raw={"legacy": True},
            )

    return None


__all__ = ["Event", "parse_line"]
