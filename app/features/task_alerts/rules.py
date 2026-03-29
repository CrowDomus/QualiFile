"""Reminder moment rules for task alerts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone, tzinfo

REMINDER_MODE_ON_END_DATE = "on_end_date"
REMINDER_MODE_DAYS_BEFORE_END_DATE = "days_before_end_date"
DEFAULT_REMINDER_HOUR_LOCAL = 8
DEFAULT_REMINDER_MINUTE_LOCAL = 0
MIN_REMINDER_DAYS_BEFORE = 1


@dataclass(frozen=True)
class ReminderConfig:
    enabled: bool
    end_date: str | None
    mode: str
    days_before: int | None


def local_timezone() -> tzinfo:
    tz = datetime.now().astimezone().tzinfo
    return tz or timezone.utc


def _parse_end_date(value: object) -> date | None:
    if value is None:
        return None
    try:
        return date.fromisoformat(str(value).strip())
    except (TypeError, ValueError):
        return None


def _normalize_days_before(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        days = value
    else:
        try:
            days = int(str(value).strip())
        except (TypeError, ValueError):
            return None
    if days < MIN_REMINDER_DAYS_BEFORE:
        return None
    return days


def _is_valid_local_datetime(naive_value: datetime, zone: tzinfo) -> bool:
    candidate = naive_value.replace(tzinfo=zone)
    round_trip = candidate.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None)
    return round_trip == naive_value


def _resolve_local_datetime(day: date, *, zone: tzinfo) -> datetime:
    """Return 08:00 local, or the next valid local time on that date."""

    target = datetime.combine(day, time(DEFAULT_REMINDER_HOUR_LOCAL, DEFAULT_REMINDER_MINUTE_LOCAL))
    for minute_offset in range(24 * 60):
        candidate = target + timedelta(minutes=minute_offset)
        if candidate.date() != day:
            break
        if _is_valid_local_datetime(candidate, zone):
            return candidate.replace(tzinfo=zone)
    return datetime.combine(day, time(23, 59), tzinfo=zone)


def compute_reminder_date(end_date: date, *, mode: str, days_before: int | None) -> date | None:
    if mode == REMINDER_MODE_ON_END_DATE:
        return end_date
    if mode == REMINDER_MODE_DAYS_BEFORE_END_DATE:
        normalized_days = _normalize_days_before(days_before)
        if normalized_days is None:
            return None
        return end_date - timedelta(days=normalized_days)
    return None


def compute_reminder_moment_local(
    end_date_value: object,
    *,
    mode: str,
    days_before: object,
    zone: tzinfo | None = None,
) -> datetime | None:
    end_date = _parse_end_date(end_date_value)
    if end_date is None:
        return None
    reminder_date = compute_reminder_date(end_date, mode=mode, days_before=_normalize_days_before(days_before))
    if reminder_date is None:
        return None
    target_zone = zone or local_timezone()
    return _resolve_local_datetime(reminder_date, zone=target_zone)


def compute_reminder_moment_utc(
    end_date_value: object,
    *,
    mode: str,
    days_before: object,
    zone: tzinfo | None = None,
) -> datetime | None:
    local_moment = compute_reminder_moment_local(
        end_date_value,
        mode=mode,
        days_before=days_before,
        zone=zone,
    )
    if local_moment is None:
        return None
    return local_moment.astimezone(timezone.utc)


def build_reminder_config(payload: dict) -> ReminderConfig:
    reminder_enabled = bool(payload.get("reminder_enabled", False))
    reminder_mode = str(payload.get("reminder_mode") or REMINDER_MODE_ON_END_DATE).strip() or REMINDER_MODE_ON_END_DATE
    reminder_days_before = _normalize_days_before(payload.get("reminder_days_before"))
    return ReminderConfig(
        enabled=reminder_enabled,
        end_date=payload.get("end_date"),
        mode=reminder_mode,
        days_before=reminder_days_before,
    )


def is_due(reminder_moment_utc: datetime, *, now_utc: datetime | None = None) -> bool:
    candidate_now = now_utc or datetime.now(timezone.utc)
    if candidate_now.tzinfo is None:
        candidate_now = candidate_now.replace(tzinfo=timezone.utc)
    else:
        candidate_now = candidate_now.astimezone(timezone.utc)
    return candidate_now >= reminder_moment_utc


__all__ = [
    "DEFAULT_REMINDER_HOUR_LOCAL",
    "DEFAULT_REMINDER_MINUTE_LOCAL",
    "REMINDER_MODE_DAYS_BEFORE_END_DATE",
    "REMINDER_MODE_ON_END_DATE",
    "ReminderConfig",
    "build_reminder_config",
    "compute_reminder_date",
    "compute_reminder_moment_local",
    "compute_reminder_moment_utc",
    "is_due",
    "local_timezone",
]
