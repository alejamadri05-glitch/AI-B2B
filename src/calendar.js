// Demo calendar built from the client's arrival windows.
// Home-services companies book "arrival windows" (e.g. 8-11 AM), not exact times,
// so all math is done on local calendar dates in the client's time zone.
// In production, replace availableWindows/isWindowBookable with calls to the
// client's real scheduler (ServiceTitan, Housecall Pro, Jobber, Google Calendar).
import { countBookings } from "./store.js";

export function localNow(now, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function describeNow(now, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(now);
}

export function addDays(dateKey, days) {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(dateKey) {
  return new Date(`${dateKey}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC",
  });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Leave at least this many hours between now and the start of a same-day window.
const SAME_DAY_LEAD_HOURS = 2;

export function isWindowBookable(config, date, windowLabel, now) {
  const { booking } = config;
  if (!DATE_RE.test(date)) return { ok: false, reason: "Date must be YYYY-MM-DD." };
  const today = localNow(now, config.timezone);
  const lastDay = addDays(today.date, booking.days_ahead);
  if (date < today.date || date > lastDay) {
    return { ok: false, reason: `Date must be between ${today.date} and ${lastDay}.` };
  }
  if (booking.closed_days.includes(weekdayOf(date))) {
    return { ok: false, reason: `Closed on ${weekdayOf(date)}s.` };
  }
  const window = booking.arrival_windows.find((w) => w.label === windowLabel);
  if (!window) {
    const labels = booking.arrival_windows.map((w) => w.label).join(", ");
    return { ok: false, reason: `Unknown arrival window. Valid windows: ${labels}.` };
  }
  if (date === today.date && window.start_hour < today.hour + SAME_DAY_LEAD_HOURS) {
    return { ok: false, reason: "That window has already started or is too soon today." };
  }
  if (countBookings(config.slug, date, windowLabel) >= booking.jobs_per_window) {
    return { ok: false, reason: "That window is fully booked." };
  }
  return { ok: true };
}

export function availableWindows(config, now, fromDate = null, limit = 9) {
  const today = localNow(now, config.timezone).date;
  const start = fromDate && DATE_RE.test(fromDate) && fromDate > today ? fromDate : today;
  const slots = [];
  for (let i = 0; slots.length < limit; i++) {
    const date = addDays(start, i);
    if (date > addDays(today, config.booking.days_ahead)) break;
    for (const w of config.booking.arrival_windows) {
      if (slots.length >= limit) break;
      if (isWindowBookable(config, date, w.label, now).ok) {
        slots.push({ date, weekday: weekdayOf(date), arrival_window: w.label });
      }
    }
  }
  return slots;
}

const DEFAULT_OFFICE_HOURS = {
  Monday: ["08:00", "17:00"],
  Tuesday: ["08:00", "17:00"],
  Wednesday: ["08:00", "17:00"],
  Thursday: ["08:00", "17:00"],
  Friday: ["08:00", "17:00"],
  Saturday: null,
  Sunday: null,
};

// True when the moment falls outside the office hours in config.office_hours
// ({ Monday: ["07:00", "18:00"], ..., Sunday: null }), in the client's time zone.
export function isAfterHours(config, at) {
  const hours = config.office_hours ?? DEFAULT_OFFICE_HOURS;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone,
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  const open = hours[parts.weekday];
  if (!open) return true;
  const time = `${parts.hour}:${parts.minute}`;
  return time < open[0] || time >= open[1];
}
