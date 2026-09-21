// Epoch days ⇄ calendar dates.
//
// `start_day` is an integer: days since 1970-01-01. Every function here converts at the edge and
// every one of them reads the UTC component of a `Date`, never the local one. A single
// `getDate()` in this file would put the whole chart one day out for half the planet, and the
// bug would only show up in the hemisphere nobody tested in.

export const MS_PER_DAY = 86_400_000;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** The UTC midnight that starts `day`. */
export function dayToDate(day: number): Date {
  return new Date(day * MS_PER_DAY);
}

/** The epoch day that contains `date`. */
export function dateToDay(date: Date): number {
  return Math.floor(date.getTime() / MS_PER_DAY);
}

/** Today, in UTC. */
export function today(): number {
  return Math.floor(Date.now() / MS_PER_DAY);
}

/** How far into today it is, in UTC: 0 at midnight, just under 1 a moment before the next one. */
export function fractionOfDay(): number {
  return (Date.now() % MS_PER_DAY) / MS_PER_DAY;
}

/** `2026-01-12` — the value an `<input type="date">` wants. */
export function toIso(day: number): string {
  return dayToDate(day).toISOString().slice(0, 10);
}

/** Parses `2026-01-12` back to an epoch day, or `null` if it is not a date. */
export function fromIso(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / MS_PER_DAY);
}

/** `Mon 12 Jan`. */
export function formatDay(day: number): string {
  const d = dayToDate(day);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}`;
}

/** `12 Jan 2026` — for the inspector, where the year matters. */
export function formatLongDay(day: number): string {
  const d = dayToDate(day);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`;
}

/** Just the day of the month, for the timeline ruler. */
export function dayOfMonth(day: number): number {
  return dayToDate(day).getUTCDate();
}

/** `January 2026`, for the timeline's month band. */
export function monthLabel(day: number): string {
  const d = dayToDate(day);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** True on the first of a month — where the month band breaks. */
export function isMonthStart(day: number): boolean {
  return dayToDate(day).getUTCDate() === 1;
}

export function isWeekend(day: number): boolean {
  const wd = dayToDate(day).getUTCDay();
  return wd === 0 || wd === 6;
}

/**
 * The last day a bar covers. A bar spans `[start, start + duration)`, so a one-day task starts
 * and ends on the same day and the inspector must not say it ends the day after.
 */
export function lastDay(startDay: number, durationDays: number): number {
  return startDay + Math.max(1, durationDays) - 1;
}
