const MS_PER_DAY = 24 * 60 * 60 * 1000;

function startOfDayUtc(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function parseDateInput(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (match) {
      const [, year, month, day] = match;
      const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return startOfDayUtc(date);
}

export function addDays(date, days) {
  if (!date || Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + days * MS_PER_DAY);
}

export function normalizeDateRange(startValue, endValue) {
  const start = parseDateInput(startValue);
  const end = parseDateInput(endValue);
  if (start && end) {
    const startUtc = startOfDayUtc(start);
    const endUtc = startOfDayUtc(end);
    if (startUtc.getTime() <= endUtc.getTime()) {
      return { start: startUtc, end: endUtc };
    }
    return { start: endUtc, end: startUtc };
  }
  if (start && !end) return { start, end: start };
  if (!start && end) return { start: end, end };
  return { start: null, end: null };
}

export function durationInDays(start, end) {
  if (!start || !end) return null;
  const startUtc = startOfDayUtc(start);
  const endUtc = startOfDayUtc(end);
  const diff = endUtc.getTime() - startUtc.getTime();
  return Math.max(1, Math.round(diff / MS_PER_DAY) + 1);
}

export function daysBetween(start, target) {
  if (!start || !target) return 0;
  const startUtc = startOfDayUtc(start);
  const targetUtc = startOfDayUtc(target);
  const diff = targetUtc.getTime() - startUtc.getTime();
  return Math.round(diff / MS_PER_DAY);
}

export function computeTimelineRange(items, bufferDays = 2) {
  const dates = [];
  (items || []).forEach((item) => {
    if (item?.startDate) dates.push(item.startDate);
    if (item?.endDate) dates.push(item.endDate);
  });
  if (!dates.length) return null;
  let min = dates[0];
  let max = dates[0];
  dates.forEach((date) => {
    if (!date || Number.isNaN(date.getTime())) return;
    if (date.getTime() < min.getTime()) min = date;
    if (date.getTime() > max.getTime()) max = date;
  });
  const start = addDays(startOfDayUtc(min), -Math.max(0, bufferDays));
  const end = addDays(startOfDayUtc(max), Math.max(0, bufferDays));
  return {
    start,
    end,
    totalDays: durationInDays(start, end),
  };
}

export function formatDateLabel(date) {
  if (!date) return '';
  try {
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  } catch (error) {
    return '';
  }
}

export function formatDayLabel(date) {
  if (!date) return '';
  try {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  } catch (error) {
    return '';
  }
}

export function todayUtc() {
  const now = new Date();
  return startOfDayUtc(now);
}
